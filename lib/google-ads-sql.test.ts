import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import {
  vpsConfigFromEnv, createTestRole, createTestDatabase, connectionUri,
  dropTestDatabase, dropTestRole, dropStaleTestObjects, TEST_PREFIX,
} from '@/lib/backup/vps-database'
import { splitMigrationStatements } from '@/lib/backup/migration-sql'

// The Google Ads SQL, executed through the real functions: migration 025, the
// spend upsert, the lower() joins, the run claim, the eligibility query and the
// upload upsert.
//
// Typecheck, eslint and the module build gate all see raw SQL as a plain
// string. Only a database can say it parses, and there are five things in here
// of exactly the shape that has gone wrong before in this module:
//
//   - an INSERT ... SELECT FROM (VALUES ...) with a cast on every column and an
//     ON CONFLICT that mixes EXCLUDED with the existing row;
//   - a join through lower() on both sides, which is the ONLY correct way to
//     match Google Ads' lower-cased item ids to Merchant Center's;
//   - an interval built from a bound parameter (make_interval takes its
//     arguments by name and cannot infer a type from a bare placeholder);
//   - a NUMERIC column read back through Prisma as a Decimal rather than a
//     number;
//   - the run claim, which is the only thing stopping two serverless
//     invocations uploading the same sale twice.
//
// SKIPS SILENTLY without OVH_SERVER / OVH_USER / OVH_PASSWORD in the shell,
// like the other *-sql tests beside it. A SKIP IS NOT A PASS - export them from
// the Deskwell workspace's .env for the run. Provisions and drops its own
// throwaway database under TEST_PREFIX; it touches nothing else on the box.
const cfg = (() => { try { return vpsConfigFromEnv() } catch { return null } })()

// Every case here is several round trips to a Postgres on the other side of the
// country. Vitest's default five seconds is a local-database figure.
vi.setConfig({ testTimeout: 30_000 })

type StoreModule = typeof import('@/modules/google-shopping-for-shop/lib/google-ads/store')

describe.skipIf(!cfg)('google-shopping Google Ads SQL against a real database', () => {
  let db: PrismaClient
  let dbName: string
  let roleName: string
  let store: StoreModule

  beforeAll(async () => {
    const suffix = `${Date.now()}`.slice(-9)
    dbName = `${TEST_PREFIX}gad_${suffix}`
    roleName = `${TEST_PREFIX}role_gad_${suffix}`
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

    // A listing, one variation and three orders to attribute and upload.
    await db.$executeRawUnsafe(`
      INSERT INTO "shp_products" ("id", "name", "slug", "type", "price", "status")
      VALUES ('p1', 'Aeron Chair', 'aeron-chair', 'PHYSICAL', 900, 'ACTIVE'),
             ('p1-Black', 'Aeron Chair - Black', 'aeron-chair-black', 'PHYSICAL', 900, 'ACTIVE')
    `)
    await db.$executeRawUnsafe(`
      INSERT INTO "shp_orders" (
        "id", "order_number", "customer_email", "customer_name", "shipping_address",
        "subtotal", "total", "tax_mode", "payment_method", "currency"
      )
      VALUES ('o1', 'DW000001', 'a@example.test', 'A', '{}'::jsonb, 900, 1080, 'INCLUSIVE', 'card', 'GBP'),
             ('o2', 'DW000002', 'b@example.test', 'B', '{}'::jsonb, 400, 480, 'INCLUSIVE', 'card', 'GBP'),
             ('o3', 'DW000003', 'c@example.test', 'C', '{}'::jsonb, 400, 480, 'INCLUSIVE', 'card', 'GBP'),
             ('o4', 'DW000004', 'd@example.test', 'D', '{}'::jsonb, 400, 480, 'INCLUSIVE', 'card', 'GBP')
    `)

    process.env.DATABASE_URL = url
    store = await import('@/modules/google-shopping-for-shop/lib/google-ads/store')
  }, 300_000)

  afterAll(async () => {
    const shared = await import('@/lib/db/prisma').catch(() => null)
    await shared?.prisma.$disconnect().catch(() => {})
    await db?.$disconnect().catch(() => {})
    if (cfg) {
      if (dbName) await dropTestDatabase(cfg, dbName).catch(() => {})
      if (roleName) await dropTestRole(cfg, roleName).catch(() => {})
      await dropStaleTestObjects(cfg).catch(() => {})
    }
  }, 180_000)

  beforeEach(async () => {
    await db.$executeRawUnsafe('TRUNCATE "gsf_ads_performance_daily", "gsf_ads_conversion_uploads"')
    await db.$executeRawUnsafe('DELETE FROM "gsf_attributed_orders"')
    await db.$executeRawUnsafe('DELETE FROM "gsf_click_events"')
    await db.$executeRawUnsafe(`
      UPDATE "gsf_ads_run" SET "claimed_at" = NULL, "started_at" = NULL, "finished_at" = NULL,
        "status" = NULL, "uploaded" = 0, "failed" = 0, "skipped" = 0, "last_error" = NULL,
        "spend_checked_at" = NULL, "spend_failed_at" = NULL, "spend_last_error" = NULL,
        "spend_imported_through" = NULL
    `)
  })

  // ----- Migration 025 -------------------------------------------------------

  it('025 creates the three tables with the column types the code assumes, and survives a second run', async () => {
    const sql = readFileSync(path.join(process.cwd(), 'modules/google-shopping-for-shop/migrations/025_google_ads.sql'), 'utf8')
    // Applied a second time: the module migration runner may re-apply a file,
    // and an ALTER that is not IF NOT EXISTS would throw here.
    for (const statement of splitMigrationStatements(sql)) await db.$executeRawUnsafe(statement)

    const spend = await db.$queryRaw<Array<{ column_name: string; data_type: string }>>`
      SELECT "column_name", "data_type" FROM information_schema.columns
      WHERE "table_name" = 'gsf_ads_performance_daily' ORDER BY "column_name"
    `
    expect(Object.fromEntries(spend.map((row) => [row.column_name, row.data_type]))).toEqual({
      clicks: 'bigint',
      conversions: 'double precision',
      conversions_value: 'double precision',
      cost_micros: 'bigint',
      currency: 'text',
      day: 'date',
      impressions: 'bigint',
      imported_at: 'timestamp without time zone',
      item_id: 'text',
    })

    const uploads = await db.$queryRaw<Array<{ column_name: string; data_type: string }>>`
      SELECT "column_name", "data_type" FROM information_schema.columns
      WHERE "table_name" = 'gsf_ads_conversion_uploads' ORDER BY "column_name"
    `
    const byName = Object.fromEntries(uploads.map((row) => [row.column_name, row.data_type]))
    expect(byName.value).toBe('numeric')
    expect(byName.status).toBe('text')
    expect(byName.attempts).toBe('integer')
    // Nullable on purpose: consent withdrawal clears it and the row stays, so
    // the same sale is never uploaded a second time.
    const clickColumn = await db.$queryRaw<Array<{ is_nullable: string }>>`
      SELECT "is_nullable" FROM information_schema.columns
      WHERE "table_name" = 'gsf_ads_conversion_uploads' AND "column_name" = 'click_event_id'
    `
    expect(clickColumn[0]?.is_nullable).toBe('YES')

    // The singleton is seeded, once.
    const runs = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM "gsf_ads_run"`
    expect(Number(runs[0]?.n)).toBe(1)

    // And the settings columns landed on the existing row.
    const settings = await db.$queryRaw<Array<{ ads_enabled: boolean; ads_spend_backfill_days: number }>>`
      SELECT "ads_enabled", "ads_spend_backfill_days" FROM "gsf_settings" WHERE "id" = 'singleton'
    `
    expect(settings[0]?.ads_enabled).toBe(false)
    expect(Number(settings[0]?.ads_spend_backfill_days)).toBe(90)
  })

  // ----- Spend ---------------------------------------------------------------

  it('writes a day idempotently, keeping the bigints out of string arithmetic', async () => {
    const rows = [
      { day: '2026-09-20', itemId: 'p1-black', costMicros: 4_230_000n, clicks: 12n, impressions: 980n, conversions: 1.5, conversionsValue: 412.5 },
      { day: '2026-09-20', itemId: 'p2', costMicros: 1_000_000n, clicks: 3n, impressions: 100n, conversions: null, conversionsValue: null },
    ]
    await store.writeAdsSpendRows(rows, 'GBP')
    // The same window again, which is what the daily re-read of Google's
    // unsettled days does. No accumulation, no doubling.
    await store.writeAdsSpendRows(rows, 'GBP')

    const totals = await store.readAdsSpendTotals('2026-09-01', '2026-09-30')
    expect(totals.cost).toBeCloseTo(5.23, 6)
    expect(totals.clicks).toBe(15)
    expect(totals.impressions).toBe(1080)
    expect(totals.currency).toBe('GBP')
    expect(totals.daysHeld).toBe(1)
    // One row reported a conversion, one did not. The sum is over the one that
    // did; a table where NONE reported answers null rather than nought.
    expect(totals.conversions).toBeCloseTo(1.5, 6)
  })

  it('answers no conversions rather than nought where Google reported none', async () => {
    await store.writeAdsSpendRows(
      [{ day: '2026-09-20', itemId: 'p1-black', costMicros: 1n, clicks: 1n, impressions: 1n, conversions: null, conversionsValue: null }],
      'GBP',
    )
    const totals = await store.readAdsSpendTotals('2026-09-20', '2026-09-20')
    expect(totals.conversions).toBeNull()
    expect(totals.conversionsValue).toBeNull()
  })

  it('matches Google’s lower-cased item id to a title stored with capitals', async () => {
    // THE test in this file. Google Ads returns segments.product_item_id
    // lower-cased whatever case the id has in Merchant Center, so a plain
    // equality join matches nothing and every title reads blank - with no error
    // anywhere.
    await db.$executeRawUnsafe(`
      INSERT INTO "gsf_item_match_status" ("item_id", "merchant_title", "checked_at")
      VALUES ('p1-Black', 'Aeron Chair - Black', CURRENT_TIMESTAMP)
      ON CONFLICT ("item_id") DO UPDATE SET "merchant_title" = EXCLUDED."merchant_title"
    `)
    await store.writeAdsSpendRows(
      [{ day: '2026-09-20', itemId: 'p1-black', costMicros: 4_230_000n, clicks: 12n, impressions: 980n, conversions: null, conversionsValue: null }],
      'GBP',
    )
    const items = await store.readAdsSpendByItem({ from: '2026-09-01', to: '2026-09-30', limit: 10, offset: 0 })
    expect(items.total).toBe(1)
    expect(items.rows[0]?.itemId).toBe('p1-black')
    expect(items.rows[0]?.title).toBe('Aeron Chair - Black')
    expect(items.rows[0]?.cost).toBeCloseTo(4.23, 6)
  })

  it('reports a day per point and prunes by day, never by timestamp', async () => {
    await store.writeAdsSpendRows([
      { day: '2026-09-18', itemId: 'a', costMicros: 1_000_000n, clicks: 1n, impressions: 10n, conversions: null, conversionsValue: null },
      { day: '2026-09-20', itemId: 'a', costMicros: 2_000_000n, clicks: 2n, impressions: 20n, conversions: null, conversionsValue: null },
    ], 'GBP')
    const trend = await store.readAdsSpendTrend('2026-09-01', '2026-09-30')
    expect(trend.map((point) => point.day)).toEqual(['2026-09-18', '2026-09-20'])
    expect(trend[1]?.cost).toBeCloseTo(2, 6)

    const extent = await store.readAdsSpendExtent()
    expect([extent.from, extent.to]).toEqual(['2026-09-18', '2026-09-20'])

    expect(await store.pruneAdsSpend('2026-09-20')).toBe(1)
    expect((await store.readAdsSpendExtent()).from).toBe('2026-09-20')
  })

  // ----- The run -------------------------------------------------------------

  it('lets one run claim the slot and refuses the second', async () => {
    expect(await store.claimAdsRun()).toBe(true)
    // The whole point: two serverless invocations are two machines, and without
    // this both would read the same eligible sales and upload each one twice.
    expect(await store.claimAdsRun()).toBe(false)
    await store.releaseAdsRun({ status: 'ok', uploaded: 2, failed: 0, skipped: 1 })
    expect(await store.claimAdsRun()).toBe(true)
  })

  it('moves the finished stamp only when a run actually finishes', async () => {
    await store.claimAdsRun()
    const midRun = await store.readAdsRun()
    expect(midRun.startedAt).not.toBeNull()
    expect(midRun.finishedAt).toBeNull()

    await store.releaseAdsRun({ status: 'part', uploaded: 3, failed: 2, skipped: 1, message: 'Google said no' })
    const done = await store.readAdsRun()
    expect(done.claimedAt).toBeNull()
    expect(done.finishedAt).not.toBeNull()
    expect([done.status, done.uploaded, done.failed, done.skipped]).toEqual(['part', 3, 2, 1])
    expect(done.lastError).toBe('Google said no')
  })

  it('lets a claimed run be abandoned without stamping anything', async () => {
    await store.claimAdsRun()
    await store.abandonAdsRun()
    const run = await store.readAdsRun()
    expect(run.claimedAt).toBeNull()
    expect(run.finishedAt).toBeNull()
    expect(run.status).toBeNull()
  })

  it('never reports a spend fetch that did not happen', async () => {
    await store.recordAdsSpendCheck({ outcome: 'ok', checkedAt: new Date(), importedThrough: '2026-09-18' })
    const good = await store.readAdsRun()
    expect(good.spendCheckedAt).not.toBeNull()
    expect(good.spendFailedAt).toBeNull()
    expect(good.spendImportedThrough).toBe('2026-09-18')

    await store.recordAdsSpendCheck({ outcome: 'failed', checkedAt: new Date(), importedThrough: '2026-09-19', error: 'nope' })
    const bad = await store.readAdsRun()
    // The success stamp has NOT moved: the fetch failed.
    expect(bad.spendCheckedAt?.getTime()).toBe(good.spendCheckedAt?.getTime())
    expect(bad.spendFailedAt).not.toBeNull()
    expect(bad.spendLastError).toBe('nope')
    // ...but whatever WAS read is in the table, so the cursor says so.
    expect(bad.spendImportedThrough).toBe('2026-09-19')

    await expect(store.recordAdsSpendCheck({ outcome: 'ok', checkedAt: new Date(), importedThrough: 'soon' })).rejects.toThrow()
  })

  // ----- Eligibility ---------------------------------------------------------

  async function seedClicksAndOrders() {
    await db.$executeRawUnsafe(`
      INSERT INTO "gsf_click_events" ("id", "landed_at", "product_id", "source", "click_id", "click_id_kind", "session_key", "attribution_id", "consented", "dedupe_bucket")
      VALUES ('c-paid',      CURRENT_TIMESTAMP - interval '2 hours', 'p1', 'paid', 'gclid-1',   'gclid',   's1', 'a1', true,  1),
             ('c-free',      CURRENT_TIMESTAMP - interval '2 hours', 'p1', 'free', NULL,        NULL,      's2', 'a2', true,  2),
             ('c-nocons',    CURRENT_TIMESTAMP - interval '2 hours', 'p1', 'paid', NULL,        NULL,      's3', NULL, false, 3),
             ('c-srsltid',   CURRENT_TIMESTAMP - interval '2 hours', 'p1', 'paid', 'srsltid-1', 'srsltid', 's4', 'a4', true,  4)
    `)
    await db.$executeRawUnsafe(`
      INSERT INTO "gsf_attributed_orders" ("order_id", "order_number", "click_event_id", "seconds_to_purchase", "confirmed_at", "order_value", "currency")
      VALUES ('o1', 'DW000001', 'c-paid',    600, CURRENT_TIMESTAMP, 1080, 'GBP'),
             ('o2', 'DW000002', 'c-free',    600, CURRENT_TIMESTAMP, 480,  'GBP'),
             ('o3', 'DW000003', 'c-nocons',  600, CURRENT_TIMESTAMP, 480,  'GBP'),
             ('o4', 'DW000004', 'c-srsltid', 600, CURRENT_TIMESTAMP, 480,  'GBP')
    `)
  }

  it('offers only the paid, consented, confirmed sales that carry an Ads click', async () => {
    await seedClicksAndOrders()
    const waiting = await store.readUploadableOrders(50, 3)
    // o2 came from a free listing, o3's shopper never consented, o4 carries an
    // srsltid - which Google appends to free clicks too and has no field for.
    expect(waiting.map((row) => row.orderId)).toEqual(['o1'])
    expect(waiting[0]?.clickId).toBe('gclid-1')
    // NUMERIC read back through Prisma as a Decimal, turned into a string
    // rather than a float.
    expect(waiting[0]?.value).toBe('1080')
    expect(await store.countUploadableOrders(3)).toBe(1)
  })

  it('drops a sale out of the list the moment consent is withdrawn', async () => {
    await seedClicksAndOrders()
    expect(await store.countUploadableOrders(3)).toBe(1)
    // Exactly what forgetAttribution does: the identifier goes and the flag
    // goes with it. The consent test runs at the moment of sending, so this is
    // enough - no cached list, nothing to invalidate.
    await db.$executeRawUnsafe(`
      UPDATE "gsf_click_events" SET "click_id" = NULL, "click_id_kind" = NULL, "attribution_id" = NULL, "consented" = false
      WHERE "id" = 'c-paid'
    `)
    expect(await store.countUploadableOrders(3)).toBe(0)
    expect(await store.readUploadableOrders(50, 3)).toEqual([])
  })

  it('never offers a sale twice, and retries a refusal up to the cap', async () => {
    await seedClicksAndOrders()
    const base = {
      orderId: 'o1', orderNumber: 'DW000001', clickEventId: 'c-paid',
      conversionAction: 'customers/1/conversionActions/2',
      conversionDateTime: '2026-09-20 11:32:45+00:00',
      value: '1080', currency: 'GBP', clickIdKind: 'gclid',
    }

    await store.recordUploadOutcome({ ...base, status: 'refused', message: 'no', errorCode: 'CLICK_NOT_FOUND' })
    expect(await store.countUploadableOrders(3)).toBe(1)
    await store.recordUploadOutcome({ ...base, status: 'refused', message: 'no', errorCode: 'CLICK_NOT_FOUND' })
    await store.recordUploadOutcome({ ...base, status: 'refused', message: 'no', errorCode: 'CLICK_NOT_FOUND' })
    // Three tries used up: it is left alone rather than offered for ever.
    expect(await store.countUploadableOrders(3)).toBe(0)

    await store.recordUploadOutcome({ ...base, status: 'uploaded' })
    const totals = await store.readUploadTotals()
    expect(totals).toEqual({ uploaded: 1, refused: 0, skipped: 0 })
    // And an uploaded sale is never offered again, whatever the cap.
    expect(await store.countUploadableOrders(99)).toBe(0)

    const recent = await store.readRecentUploads(10)
    expect(recent[0]).toMatchObject({ orderId: 'o1', status: 'uploaded', value: 1080 })
    // The success cleared the failure stamp rather than leaving both showing.
    expect(recent[0]?.at).not.toBeNull()
  })

  it('never retries a sale this site declined to send', async () => {
    await seedClicksAndOrders()
    await store.recordUploadOutcome({
      orderId: 'o1', orderNumber: 'DW000001', clickEventId: 'c-paid',
      status: 'skipped', conversionAction: null, conversionDateTime: null,
      value: '1080', currency: 'GBP', clickIdKind: 'gclid',
      message: 'The payment settled before the visit.',
    })
    expect(await store.countUploadableOrders(99)).toBe(0)
    const problems = await store.readUploadProblems(10)
    expect(problems[0]).toMatchObject({ orderId: 'o1', status: 'skipped', attempts: 0 })
  })

  it('counts this site’s own paid sales over an instant range', async () => {
    await seedClicksAndOrders()
    const start = new Date(Date.now() - 24 * 3600_000)
    const end = new Date(Date.now() + 3600_000)
    const sales = await store.readAttributedPaidSales(start, end)
    // Paid clicks only: the free listing sale is somebody else's column. Both
    // the consented and the non-consented paid sale count here - this is a
    // count of sales, not a list of things to send anybody.
    expect(sales.orders).toBe(3)
    expect(sales.revenue).toBeCloseTo(1080 + 480 + 480, 6)
  })

  it('keeps the record of an upload when the landing behind it is erased', async () => {
    await seedClicksAndOrders()
    await store.recordUploadOutcome({
      orderId: 'o1', orderNumber: 'DW000001', clickEventId: 'c-paid', status: 'uploaded',
      conversionAction: 'customers/1/conversionActions/2',
      conversionDateTime: '2026-09-20 11:32:45+00:00',
      value: '1080', currency: 'GBP', clickIdKind: 'gclid',
    })
    const tracking = await import('@/modules/google-shopping-for-shop/lib/click-tracking/store')
    const result = await tracking.forgetAttribution('a1')
    expect(result.adsUploads).toBe(1)

    const rows = await db.$queryRaw<Array<{
      order_id: string; click_event_id: string | null; click_id_kind: string | null; status: string
    }>>`
      SELECT "order_id", "click_event_id", "click_id_kind", "status" FROM "gsf_ads_conversion_uploads"
    `
    // The join to the visit is gone, and so is the kind of click - on its own
    // that still says "this order came from a Google ad click", which is the
    // claim being erased. What is NOT gone is the fact Google was told, because
    // losing that would send the same sale a second time.
    expect(rows[0]).toMatchObject({ order_id: 'o1', click_event_id: null, click_id_kind: null, status: 'uploaded' })
  })
})
