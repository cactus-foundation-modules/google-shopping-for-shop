import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import {
  vpsConfigFromEnv, createTestRole, createTestDatabase, connectionUri,
  dropTestDatabase, dropTestRole, dropStaleTestObjects, TEST_PREFIX,
} from '@/lib/backup/vps-database'
import { splitMigrationStatements } from '@/lib/backup/migration-sql'

// Live click tracking's own SQL, executed through the real functions: migration
// 023, the atomic rate-limit claim, the double dedupe on a landing, the
// first-writer-wins attribution, the two-step confirmation, the pruning sweep
// and the two reads the Reports tab makes.
//
// Typecheck, eslint and the module build gate all see raw SQL as a plain
// string. Only a database can say it parses, and there are four things in here
// of exactly the shape that has gone wrong before: an INSERT ... ON CONFLICT
// whose conflict target is an INDEX rather than a named constraint, a
// LEFT JOIN LATERAL whose whole job is to stop a row being counted twice, an
// interval built from a bound parameter (make_interval takes its arguments by
// name and cannot infer a type from a bare placeholder), and a DECIMAL column
// read back through Prisma.
//
// SKIPS SILENTLY without OVH_SERVER / OVH_USER / OVH_PASSWORD in the shell,
// like lib/performance-sql.test.ts beside it. A SKIP IS NOT A PASS - export
// them from the Deskwell workspace's .env for the run. Provisions and drops its
// own throwaway database under TEST_PREFIX; it touches nothing else on the box.
const cfg = (() => { try { return vpsConfigFromEnv() } catch { return null } })()

// Every case here is several round trips to a Postgres on the other side of the
// country. Vitest's default five seconds is a local-database figure.
vi.setConfig({ testTimeout: 30_000 })

type StoreModule = typeof import('@/modules/google-shopping-for-shop/lib/click-tracking/store')
type ReportModule = typeof import('@/modules/google-shopping-for-shop/lib/click-tracking/report')

describe.skipIf(!cfg)('google-shopping click tracking SQL against a real database', () => {
  let db: PrismaClient
  let dbName: string
  let roleName: string
  let store: StoreModule
  let report: ReportModule

  beforeAll(async () => {
    const suffix = `${Date.now()}`.slice(-9)
    dbName = `${TEST_PREFIX}gct_${suffix}`
    roleName = `${TEST_PREFIX}role_gct_${suffix}`
    await dropStaleTestObjects(cfg!)
    const role = await createTestRole(cfg!, roleName)
    await createTestDatabase(cfg!, dbName, role)
    const url = connectionUri(cfg!, dbName, role)
    db = new PrismaClient({ datasources: { db: { url } } })

    const initSql = path.join(process.cwd(), 'prisma/migrations/20260626000000_init/migration.sql')
    for (const statement of splitMigrationStatements(readFileSync(initSql, 'utf8'))) await db.$executeRawUnsafe(statement)
    for (const moduleName of ['shop', 'shop-variations', 'google-shopping-for-shop']) {
      const dir = path.join(process.cwd(), 'modules', moduleName, 'migrations')
      for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
        for (const statement of splitMigrationStatements(readFileSync(path.join(dir, file), 'utf8'))) {
          await db.$executeRawUnsafe(statement)
        }
      }
    }

    // A listing, one of its variations, and two orders to attribute to them.
    await db.$executeRawUnsafe(`
      INSERT INTO "shp_products" ("id", "name", "slug", "type", "price", "status")
      VALUES ('p1', 'Aeron Chair', 'aeron-chair', 'PHYSICAL', 900, 'ACTIVE'),
             ('p1-black', 'Aeron Chair - Black', 'aeron-chair-black', 'PHYSICAL', 900, 'ACTIVE'),
             ('p2', 'Sayl Chair', 'sayl-chair', 'PHYSICAL', 400, 'ACTIVE')
    `)
    await db.$executeRawUnsafe(`
      INSERT INTO "shp_orders" (
        "id", "order_number", "customer_email", "customer_name", "shipping_address",
        "subtotal", "total", "tax_mode", "payment_method", "currency"
      )
      VALUES ('o1', 'DW000001', 'a@example.test', 'A Person', '{}'::jsonb, 900, 1080, 'INCLUSIVE', 'card', 'GBP'),
             ('o2', 'DW000002', 'b@example.test', 'B Person', '{}'::jsonb, 400, 480, 'INCLUSIVE', 'card', 'GBP')
    `)
    await db.$executeRawUnsafe(`
      INSERT INTO "shp_order_items" ("order_id", "product_id", "product_name", "product_type", "quantity", "unit_price", "tax_rate", "tax_amount", "total")
      VALUES ('o1', 'p1-black', 'Aeron Chair - Black', 'PHYSICAL', 1, 900, 0.2, 180, 1080),
             ('o1', 'p2', 'Sayl Chair', 'PHYSICAL', 1, 400, 0.2, 80, 480)
    `)

    process.env.DATABASE_URL = url
    store = await import('@/modules/google-shopping-for-shop/lib/click-tracking/store')
    report = await import('@/modules/google-shopping-for-shop/lib/click-tracking/report')
  }, 300_000)

  afterAll(async () => {
    const shared = await import('@/lib/db/prisma').catch(() => null)
    await shared?.prisma.$disconnect().catch(() => {})
    await db?.$disconnect().catch(() => {})
    if (dbName) await dropTestDatabase(cfg!, dbName).catch(() => {})
    if (roleName) await dropTestRole(cfg!, roleName).catch(() => {})
  }, 180_000)

  // ----- Migration 023 -------------------------------------------------------

  it('023 creates the three tables with the column types the code assumes, and survives a second run', async () => {
    const sql = readFileSync(path.join(process.cwd(), 'modules/google-shopping-for-shop/migrations/023_click_tracking.sql'), 'utf8')
    for (const statement of splitMigrationStatements(sql)) await db.$executeRawUnsafe(statement)

    const events = await db.$queryRaw<Array<{ column_name: string; data_type: string }>>`
      SELECT "column_name", "data_type" FROM information_schema.columns
      WHERE "table_name" = 'gsf_click_events' ORDER BY "column_name"
    `
    expect(Object.fromEntries(events.map((row) => [row.column_name, row.data_type]))).toEqual({
      attribution_id: 'text',
      click_id: 'text',
      click_id_kind: 'text',
      consented: 'boolean',
      dedupe_bucket: 'bigint',
      id: 'text',
      landed_at: 'timestamp without time zone',
      product_id: 'text',
      session_key: 'text',
      source: 'text',
      variant_id: 'text',
    })

    const orders = await db.$queryRaw<Array<{ column_name: string; data_type: string }>>`
      SELECT "column_name", "data_type" FROM information_schema.columns
      WHERE "table_name" = 'gsf_attributed_orders' ORDER BY "column_name"
    `
    expect(Object.fromEntries(orders.map((row) => [row.column_name, row.data_type]))).toEqual({
      attributed_at: 'timestamp without time zone',
      click_event_id: 'text',
      confirmed_at: 'timestamp without time zone',
      currency: 'text',
      order_id: 'text',
      order_number: 'text',
      order_value: 'numeric',
      seconds_to_purchase: 'bigint',
    })

    const rate = await db.$queryRaw<Array<{ column_name: string }>>`
      SELECT "column_name" FROM information_schema.columns
      WHERE "table_name" = 'gsf_beacon_rate' ORDER BY "column_name"
    `
    expect(rate.map((row) => row.column_name)).toEqual(['bucket_key', 'hits', 'window_started_at'])

    // The three settings columns, with the defaults the module reads back.
    const settings = await db.$queryRaw<Array<{ link_tagging_enabled: boolean; click_tracking_enabled: boolean; click_retention_days: number }>>`
      SELECT "link_tagging_enabled", "click_tracking_enabled", "click_retention_days"
      FROM "gsf_settings" WHERE "id" = 'singleton'
    `
    expect(settings[0]).toEqual({ link_tagging_enabled: false, click_tracking_enabled: false, click_retention_days: 400 })
  })

  // ----- The brake -----------------------------------------------------------

  it('counts inside the database and refuses once the window is used up', async () => {
    const key = 'rate-a'
    for (let i = 0; i < 5; i++) {
      expect(await store.claimBeaconSlot(key, 5, 300), `claim ${i + 1}`).toBe(true)
    }
    expect(await store.claimBeaconSlot(key, 5, 300)).toBe(false)

    // A zero-second window has always just closed, so the next claim starts a
    // fresh one - which is the rolling reset the brake relies on.
    expect(await store.claimBeaconSlot(key, 5, 0)).toBe(true)
  })

  it('counts each caller separately', async () => {
    expect(await store.claimBeaconSlot('rate-b', 1, 300)).toBe(true)
    expect(await store.claimBeaconSlot('rate-b', 1, 300)).toBe(false)
    expect(await store.claimBeaconSlot('rate-c', 1, 300)).toBe(true)
  })

  // ----- Landings ------------------------------------------------------------

  it('records a landing and refuses a repeat from the same visitor on the same product', async () => {
    const first = await store.recordLanding({
      productId: 'p1', variantId: 'p1-black', source: 'free',
      clickId: null, clickIdKind: null, sessionKey: 'sess-1', attributionId: null, consented: false,
    })
    expect(first).not.toBeNull()

    const repeat = await store.recordLanding({
      productId: 'p1', variantId: null, source: 'paid',
      clickId: null, clickIdKind: null, sessionKey: 'sess-1', attributionId: null, consented: false,
    })
    expect(repeat).toBeNull()

    // A different product from the same visitor is a different landing.
    expect(await store.recordLanding({
      productId: 'p2', variantId: null, source: 'free',
      clickId: null, clickIdKind: null, sessionKey: 'sess-1', attributionId: null, consented: false,
    })).not.toBeNull()

    // And so is the same product from somebody else.
    expect(await store.recordLanding({
      productId: 'p1', variantId: null, source: 'paid',
      clickId: null, clickIdKind: null, sessionKey: 'sess-2', attributionId: null, consented: false,
    })).not.toBeNull()
  })

  it('stores a click identifier and an attribution id only where the row says consent was given', async () => {
    const id = await store.recordLanding({
      productId: 'p1', variantId: null, source: 'paid',
      clickId: 'gclid-value', clickIdKind: 'gclid', sessionKey: 'sess-consent', attributionId: 'attr-1', consented: true,
    })
    expect(id).not.toBeNull()
    const rows = await db.$queryRaw<Array<{ click_id: string | null; attribution_id: string | null; consented: boolean }>>`
      SELECT "click_id", "attribution_id", "consented" FROM "gsf_click_events" WHERE "id" = ${id}
    `
    expect(rows[0]).toEqual({ click_id: 'gclid-value', attribution_id: 'attr-1', consented: true })
  })

  it('hands back the NEWEST landing for an attribution cookie, which is what last click wins means', async () => {
    await db.$executeRawUnsafe(`
      INSERT INTO "gsf_click_events" ("id", "landed_at", "product_id", "source", "session_key", "attribution_id", "consented", "dedupe_bucket")
      VALUES ('old', CURRENT_TIMESTAMP - interval '2 days', 'p2', 'free', 'sess-last', 'attr-last', true, 1),
             ('new', CURRENT_TIMESTAMP - interval '1 hour', 'p1', 'paid', 'sess-last', 'attr-last', true, 2)
    `)
    const click = await store.lastClickFor('attr-last')
    expect(click?.id).toBe('new')
    expect(click?.productId).toBe('p1')
    expect(click?.source).toBe('paid')
    expect(await store.lastClickFor('attr-nobody')).toBeNull()
  })

  // ----- Sales ---------------------------------------------------------------

  it('joins an order to a click once, and never restates it', async () => {
    const landedAt = new Date(Date.now() - 3_600_000)
    expect(await store.attributeOrder({
      orderId: 'o1', orderNumber: 'DW000001', clickEventId: 'new', landedAt, confirmed: null,
    })).toBe(true)

    // A refresh of the confirmation page is not a second sale.
    expect(await store.attributeOrder({
      orderId: 'o1', orderNumber: 'DW000001', clickEventId: 'old', landedAt, confirmed: null,
    })).toBe(false)

    const rows = await db.$queryRaw<Array<{ click_event_id: string; seconds_to_purchase: bigint; confirmed_at: Date | null }>>`
      SELECT "click_event_id", "seconds_to_purchase", "confirmed_at" FROM "gsf_attributed_orders" WHERE "order_id" = 'o1'
    `
    expect(rows[0]?.click_event_id).toBe('new')
    expect(Number(rows[0]?.seconds_to_purchase)).toBeGreaterThanOrEqual(3_595)
    expect(rows[0]?.confirmed_at).toBeNull()
  })

  it('confirms the money once, with the figure the shop holds', async () => {
    expect(await store.hasPendingAttribution('o1')).toBe(true)
    expect(await store.hasPendingAttribution('o2')).toBe(false)

    expect(await store.confirmAttributedOrder({
      orderId: 'o1', value: '1080.00', currency: 'GBP', confirmedAt: new Date(),
    })).toBe(true)
    // A second announcement must not restate a figure already recorded.
    expect(await store.confirmAttributedOrder({
      orderId: 'o1', value: '1.00', currency: 'GBP', confirmedAt: new Date(),
    })).toBe(false)
    expect(await store.hasPendingAttribution('o1')).toBe(false)

    const rows = await db.$queryRaw<Array<{ order_value: unknown; currency: string | null }>>`
      SELECT "order_value", "currency" FROM "gsf_attributed_orders" WHERE "order_id" = 'o1'
    `
    expect(Number(rows[0]?.order_value)).toBe(1080)
    expect(rows[0]?.currency).toBe('GBP')
  })

  // ----- What the Reports tab reads -----------------------------------------

  it('totals landings and confirmed revenue by source, without double counting', async () => {
    const view = await report.readLiveReport({ range: '30' })
    const counted = await db.$queryRaw<Array<{ source: string; n: bigint }>>`
      SELECT "source", COUNT(*)::bigint AS n FROM "gsf_click_events"
      WHERE "landed_at" >= CURRENT_TIMESTAMP - interval '30 days' GROUP BY "source"
    `
    const expected = Object.fromEntries(counted.map((row) => [row.source, Number(row.n)]))
    expect(view.totals.free.landings).toBe(expected.free ?? 0)
    expect(view.totals.paid.landings).toBe(expected.paid ?? 0)

    // One confirmed order, on a paid click, and its money lands in that column
    // and nowhere else.
    expect(view.totals.paid.orders).toBe(1)
    expect(view.totals.paid.revenue).toBe(1080)
    expect(view.totals.free.orders).toBe(0)
    expect(view.totals.free.revenue).toBe(0)
    expect(view.totals.all.revenue).toBe(1080)

    // The rate divides by the landings that COULD convert, never by all of them.
    expect(view.totals.all.conversionRate).toBeCloseTo(1 / view.totals.all.attributable, 6)

    // The live feed shows the sale against the click it came from.
    const sold = view.recent.find((landing) => landing.id === 'new')
    expect(sold?.order?.orderNumber).toBe('DW000001')
    expect(sold?.order?.value).toBe(1080)
    expect(sold?.productName).toBe('Aeron Chair')

    // A landing with no sale carries no order, and one with a variation names it.
    expect(view.recent.some((landing) => landing.order === null)).toBe(true)
    expect(view.recent.some((landing) => landing.variantName === 'Aeron Chair - Black')).toBe(true)

    expect(view.firstLandingAt).not.toBeNull()
  })

  it('reads one sale with its click, its timing and what was actually bought', async () => {
    const view = await report.readAttributedOrder('o1')
    expect(view?.orderNumber).toBe('DW000001')
    expect(view?.value).toBe(1080)
    expect(view?.click.productName).toBe('Aeron Chair')
    expect(view?.click.source).toBe('paid')
    expect(view?.secondsToPurchase).toBeGreaterThan(0)
    expect(view?.boughtItems.map((item) => item.name)).toEqual(['Aeron Chair - Black', 'Sayl Chair'])
    expect(await report.readAttributedOrder('o2')).toBeNull()
  })

  // ----- Withdrawal ----------------------------------------------------------

  it('erases the identifiers and the sale joins on withdrawal, and leaves the counts', async () => {
    await db.$executeRawUnsafe(`
      INSERT INTO "gsf_click_events" ("id", "landed_at", "product_id", "variant_id", "source", "click_id", "click_id_kind", "session_key", "attribution_id", "consented", "dedupe_bucket")
      VALUES ('gone-1', CURRENT_TIMESTAMP - interval '3 days', 'p1', 'p1-black', 'paid', 'gclid-secret', 'gclid', 'sess-w', 'attr-withdraw', true, 11),
             ('gone-2', CURRENT_TIMESTAMP - interval '2 days', 'p2', NULL, 'free', 'srsltid-secret', 'srsltid', 'sess-w', 'attr-withdraw', true, 12),
             ('other',  CURRENT_TIMESTAMP - interval '1 day',  'p1', NULL, 'paid', 'gclid-keep', 'gclid', 'sess-x', 'attr-other', true, 13)
    `)
    await db.$executeRawUnsafe(`
      INSERT INTO "gsf_attributed_orders" ("order_id", "order_number", "click_event_id", "seconds_to_purchase", "confirmed_at", "order_value", "currency")
      VALUES ('o2', 'DW000002', 'gone-1', 600, CURRENT_TIMESTAMP, 480, 'GBP')
    `)

    const before = await db.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*)::bigint AS n FROM "gsf_click_events"`
    const result = await store.forgetAttribution('attr-withdraw')
    expect(result).toEqual({ landings: 2, attributions: 1, adsUploads: 0 })

    // The landings are STILL THERE, and still counted.
    const after = await db.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*)::bigint AS n FROM "gsf_click_events"`
    expect(Number(after[0]?.n)).toBe(Number(before[0]?.n))

    const rows = await db.$queryRaw<Array<{
      id: string; click_id: string | null; click_id_kind: string | null
      attribution_id: string | null; consented: boolean; source: string; product_id: string; variant_id: string | null
    }>>`
      SELECT "id", "click_id", "click_id_kind", "attribution_id", "consented", "source", "product_id", "variant_id"
      FROM "gsf_click_events" WHERE "id" IN ('gone-1', 'gone-2', 'other') ORDER BY "id"
    `
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]))

    // Everything that needed permission is gone...
    expect(byId['gone-1']?.click_id).toBeNull()
    expect(byId['gone-1']?.click_id_kind).toBeNull()
    expect(byId['gone-1']?.attribution_id).toBeNull()
    expect(byId['gone-1']?.consented).toBe(false)
    expect(byId['gone-2']?.click_id).toBeNull()
    expect(byId['gone-2']?.attribution_id).toBeNull()

    // ...and everything a shop may count without asking has survived.
    expect(byId['gone-1']?.source).toBe('paid')
    expect(byId['gone-1']?.product_id).toBe('p1')
    expect(byId['gone-1']?.variant_id).toBe('p1-black')
    expect(byId['gone-2']?.source).toBe('free')

    // The sale-to-click join is deleted outright: it names a person's order and
    // their browsing in one line, and it only ever existed by permission.
    expect(await store.hasPendingAttribution('o2')).toBe(false)
    const joins = await db.$queryRaw<Array<{ order_id: string }>>`
      SELECT "order_id" FROM "gsf_attributed_orders" WHERE "click_event_id" = 'gone-1'
    `
    expect(joins).toHaveLength(0)

    // Somebody else's row is untouched.
    expect(byId['other']?.click_id).toBe('gclid-keep')
    expect(byId['other']?.attribution_id).toBe('attr-other')
    expect(byId['other']?.consented).toBe(true)
  })

  it('is safe to run twice, and on an id nothing was ever stored against', async () => {
    expect(await store.forgetAttribution('attr-withdraw')).toEqual({ landings: 0, attributions: 0, adsUploads: 0 })
    expect(await store.forgetAttribution('attr-never-existed')).toEqual({ landings: 0, attributions: 0, adsUploads: 0 })
  })

  it('stops an erased landing counting towards the sale rate', async () => {
    // consented is what the Reports tab counts as "could be joined to a sale".
    // After an erasure it cannot be, so leaving the flag up would report a rate
    // measured against visits that can no longer convert.
    const rows = await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n FROM "gsf_click_events"
      WHERE "id" IN ('gone-1', 'gone-2') AND "consented"
    `
    expect(Number(rows[0]?.n)).toBe(0)
  })

  // ----- Pruning -------------------------------------------------------------

  it('keeps everything on 0 and drops what is past the window otherwise', async () => {
    await db.$executeRawUnsafe(`
      INSERT INTO "gsf_click_events" ("id", "landed_at", "product_id", "source", "session_key", "consented", "dedupe_bucket")
      VALUES ('ancient', CURRENT_TIMESTAMP - interval '500 days', 'p1', 'free', 'sess-old', false, 3)
    `)
    const before = await db.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*)::bigint AS n FROM "gsf_click_events"`

    // 0 is "keep the lot", which is a real answer and not a mistake.
    expect((await store.pruneClickTracking(0)).landings).toBe(0)
    const kept = await db.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*)::bigint AS n FROM "gsf_click_events"`
    expect(Number(kept[0]?.n)).toBe(Number(before[0]?.n))

    expect((await store.pruneClickTracking(400)).landings).toBe(1)
    const gone = await db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "gsf_click_events" WHERE "id" = 'ancient'`
    expect(gone).toHaveLength(0)
  })

  it('takes an attribution with the landing it belongs to', async () => {
    await db.$executeRawUnsafe(`
      INSERT INTO "gsf_click_events" ("id", "landed_at", "product_id", "source", "session_key", "consented", "dedupe_bucket")
      VALUES ('doomed', CURRENT_TIMESTAMP - interval '500 days', 'p2', 'free', 'sess-doomed', true, 4)
    `)
    await store.attributeOrder({
      orderId: 'o2', orderNumber: 'DW000002', clickEventId: 'doomed',
      landedAt: new Date(Date.now() - 1_000), confirmed: null,
    })
    expect(await store.hasPendingAttribution('o2')).toBe(true)

    await store.pruneClickTracking(400)
    // The cascade took it: an attribution whose click has been forgotten is a
    // claim with nothing behind it.
    expect(await store.hasPendingAttribution('o2')).toBe(false)
  })
})
