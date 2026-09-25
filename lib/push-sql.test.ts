import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import {
  vpsConfigFromEnv, createTestRole, createTestDatabase, connectionUri,
  dropTestDatabase, dropTestRole, dropStaleTestObjects, TEST_PREFIX,
} from '@/lib/backup/vps-database'
import { splitMigrationStatements } from '@/lib/backup/migration-sql'

// The live price and stock updates' own SQL, executed through the real
// functions: migration 024, the queue's upsert, the "has it been queued again
// since?" guard on clearing it, the NUMERIC round trip, the reconcile sample's
// interval-from-a-parameter, the FILTER counts and - the load-bearing one - the
// run claim, which is the ONLY thing stopping two serverless invocations
// sending the same catalogue twice.
//
// Typecheck, eslint and the module build gate all see raw SQL as a plain
// string. Only a database can say it parses, and there are four things in here
// of exactly the shape that has gone wrong before: an INSERT ... ON CONFLICT
// with an EXCLUDED-and-existing-row mix, an interval built from a bound
// parameter (make_interval takes its arguments by name and cannot infer a type
// from a bare placeholder), an ORDER BY ... NULLS FIRST inside an index, and a
// NUMERIC column read back through Prisma as a Decimal rather than a number.
//
// SKIPS SILENTLY without OVH_SERVER / OVH_USER / OVH_PASSWORD in the shell,
// like the other *-sql tests beside it. A SKIP IS NOT A PASS - export them from
// the Deskwell workspace's .env for the run. Provisions and drops its own
// throwaway database under TEST_PREFIX; it touches nothing else on the box.
const cfg = (() => { try { return vpsConfigFromEnv() } catch { return null } })()

// Every case here is several round trips to a Postgres on the other side of the
// country. Vitest's default five seconds is a local-database figure.
vi.setConfig({ testTimeout: 30_000 })

type StoreModule = typeof import('@/modules/google-shopping-for-shop/lib/push/store')

describe.skipIf(!cfg)('google-shopping live updates SQL against a real database', () => {
  let db: PrismaClient
  let dbName: string
  let roleName: string
  let store: StoreModule

  beforeAll(async () => {
    const suffix = `${Date.now()}`.slice(-9)
    dbName = `${TEST_PREFIX}gpu_${suffix}`
    roleName = `${TEST_PREFIX}role_gpu_${suffix}`
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

    process.env.DATABASE_URL = url
    store = await import('@/modules/google-shopping-for-shop/lib/push/store')
  }, 300_000)

  afterAll(async () => {
    await db?.$disconnect()
    if (cfg) {
      await dropTestDatabase(cfg, dbName).catch(() => {})
      await dropTestRole(cfg, roleName).catch(() => {})
      await dropStaleTestObjects(cfg).catch(() => {})
    }
  }, 120_000)

  beforeEach(async () => {
    await db.$executeRawUnsafe('TRUNCATE "gsf_push_queue", "gsf_push_state"')
    await db.$executeRawUnsafe(`
      UPDATE "gsf_push_run"
      SET "claimed_at" = NULL, "started_at" = NULL, "finished_at" = NULL, "status" = NULL,
          "sent" = 0, "failed" = 0, "removed" = 0, "last_error" = NULL,
          "reconciled_at" = NULL, "reconcile_checked" = 0, "reconcile_differs" = 0
      WHERE "id" = 'singleton'
    `)
  })

  // -------------------------------------------------------------------------
  // The migration itself
  // -------------------------------------------------------------------------

  it('applies migration 024 a second time without complaint', async () => {
    // The module migration runner may re-apply a file. Everything in 024 is
    // IF NOT EXISTS or ON CONFLICT DO NOTHING, and this is what proves it.
    const file = path.join(process.cwd(), 'modules/google-shopping-for-shop/migrations/024_price_stock_push.sql')
    for (const statement of splitMigrationStatements(readFileSync(file, 'utf8'))) {
      await db.$executeRawUnsafe(statement)
    }
    const rows = await db.$queryRawUnsafe<Array<{ count: bigint }>>('SELECT COUNT(*)::bigint AS count FROM "gsf_push_run"')
    expect(Number(rows[0]?.count)).toBe(1)
  })

  it('seeds the single run row and defaults the new settings columns off', async () => {
    const rows = await db.$queryRawUnsafe<Array<{
      price_push_enabled: boolean
      push_data_source_id: string | null
      push_debounce_seconds: number
      push_reconcile_sample: number
      content_language: string
    }>>(`SELECT "price_push_enabled", "push_data_source_id", "push_debounce_seconds", "push_reconcile_sample", "content_language"
         FROM "gsf_settings" WHERE "id" = 'singleton'`)
    expect(rows[0]?.price_push_enabled).toBe(false)
    expect(rows[0]?.push_data_source_id).toBeNull()
    expect(Number(rows[0]?.push_debounce_seconds)).toBe(120)
    expect(Number(rows[0]?.push_reconcile_sample)).toBe(20)
    expect(rows[0]?.content_language).toBe('en')
  })

  // -------------------------------------------------------------------------
  // The queue
  // -------------------------------------------------------------------------

  it('queues a product once however many times it is saved', async () => {
    await store.queueProducts(['p1', 'p2'], 'price')
    await store.queueProducts(['p1'], 'stockCount')
    await store.queueProducts(['p1'], 'stockCount')

    expect(await store.queueDepth()).toBe(2)
    const rows = await db.$queryRawUnsafe<Array<{ product_id: string; queued_count: number; reason: string }>>(
      'SELECT "product_id", "queued_count", "reason" FROM "gsf_push_queue" ORDER BY "product_id"',
    )
    expect(rows.map((row) => [row.product_id, Number(row.queued_count), row.reason])).toEqual([
      ['p1', 3, 'stockCount'],
      ['p2', 1, 'price'],
    ])
  })

  it('does not move a repeatedly-edited product to the back of the queue', async () => {
    // Otherwise a product somebody is fiddling with every few seconds would
    // never be sent at all.
    await store.queueProducts(['first'], 'price')
    await db.$executeRawUnsafe(`UPDATE "gsf_push_queue" SET "queued_at" = CURRENT_TIMESTAMP - interval '1 hour' WHERE "product_id" = 'first'`)
    await store.queueProducts(['second'], 'price')
    await store.queueProducts(['first'], 'price')

    const queue = await store.readQueue(10)
    expect(queue.map((entry) => entry.productId)).toEqual(['first', 'second'])
  })

  it('ignores blank ids and an empty list', async () => {
    expect(await store.queueProducts([], 'price')).toBe(0)
    expect(await store.queueProducts(['', '   '], 'price')).toBe(0)
    expect(await store.queueDepth()).toBe(0)
  })

  it('clears only the entries that have not been queued again since they were read', async () => {
    await store.queueProducts(['p1', 'p2'], 'price')
    const queue = await store.readQueue(10)

    // p1 is edited again while the run is in flight - through queueProducts,
    // which is the ONLY way this ever happens in life. An earlier version
    // tested `queued_at <= ?` and moved the timestamp by hand to make it pass;
    // queueProducts deliberately never moves it (starvation), so that guard
    // could not fire and the change was deleted unsent. The version is the
    // count, so this is the test that would have caught it.
    await store.queueProducts(['p1'], 'price')

    await store.clearQueued(queue)
    const left = await store.readQueue(10)
    expect(left.map((entry) => entry.productId)).toEqual(['p1'])
    // ...and it keeps its original place in the queue, so it goes first next time.
    expect(left[0]?.queuedCount).toBe(2)
  })

  it('clears an entry nothing touched during the run', async () => {
    await store.queueProducts(['p1'], 'price')
    await store.clearQueued(await store.readQueue(10))
    expect(await store.queueDepth()).toBe(0)
  })

  // -------------------------------------------------------------------------
  // What we believe we sent
  // -------------------------------------------------------------------------

  it('records a send and reads the NUMERIC columns back as numbers', async () => {
    await store.recordSent('item-1', 'item-1', { price: 900.5, salePrice: 749.99, currency: 'GBP', availability: 'IN_STOCK' }, true)
    const state = await store.readAllPushState()
    const row = state.get('item-1')
    expect(row?.snapshot).toEqual({ price: 900.5, salePrice: 749.99, currency: 'GBP', availability: 'IN_STOCK' })
    expect(typeof row?.snapshot.price).toBe('number')
    expect(row?.confirmed).toBe(true)
    expect(row?.failedAt).toBeNull()
  })

  it('stores no sale price at all when there is no offer', async () => {
    await store.recordSent('item-1', 'item-1', { price: 900, currency: 'GBP', availability: 'OUT_OF_STOCK' }, true)
    const row = (await store.readAllPushState()).get('item-1')
    expect(row?.snapshot.salePrice).toBeUndefined()
  })

  it('replaces a previous send and forgets the comparison that went with it', async () => {
    await store.recordSent('item-1', 'item-1', { price: 900, currency: 'GBP', availability: 'IN_STOCK' }, true)
    await store.recordReconcile('item-1', 'agrees', null)
    await store.recordSent('item-1', 'item-1', { price: 850, currency: 'GBP', availability: 'IN_STOCK' }, true)

    const row = (await store.readAllPushState()).get('item-1')
    expect(row?.snapshot.price).toBe(850)
    // The last comparison was about figures we are no longer claiming.
    expect(row?.reconciledAt).toBeNull()
    expect(row?.reconcileResult).toBeNull()
  })

  it('records a refusal without ever reading as a success', async () => {
    await store.recordSent('item-1', 'item-1', { price: 900, currency: 'GBP', availability: 'IN_STOCK' }, true)
    await store.recordFailed('item-1', 'item-1', { price: 850, currency: 'GBP', availability: 'IN_STOCK' }, 'Google said no')

    const row = (await store.readAllPushState()).get('item-1')
    expect(row?.confirmed).toBe(false)
    expect(row?.failedAt).not.toBeNull()
    expect(row?.lastError).toBe('Google said no')
    // The row means "our latest attempt", so it holds the figures we tried.
    expect(row?.snapshot.price).toBe(850)
  })

  it('records a refusal for an item that had never been sent', async () => {
    await store.recordFailed('new-item', 'new-item', { price: 12.34, currency: 'GBP', availability: 'BACKORDER' }, 'nope')
    const row = (await store.readAllPushState()).get('new-item')
    expect(row?.snapshot).toEqual({ price: 12.34, currency: 'GBP', availability: 'BACKORDER' })
    expect(row?.failedAt).not.toBeNull()
  })

  it('keeps the listing each item belongs to, so a queued parent can find its children', async () => {
    // The state table is keyed by CHILD item id. Without the listing beside it,
    // a queued variation PARENT that had left the feed matched nothing and its
    // children sat at Merchant Center until the hourly sweep noticed.
    await store.recordSent('chair-black', 'chair', { price: 900, currency: 'GBP', availability: 'IN_STOCK' }, true)
    await store.recordSent('chair-grey', 'chair', { price: 900, currency: 'GBP', availability: 'IN_STOCK' }, true)
    await store.recordSent('desk', 'desk', { price: 400, currency: 'GBP', availability: 'IN_STOCK' }, true)

    const state = await store.readAllPushState()
    const forChair = [...state.values()].filter((row) => row.parentId === 'chair').map((row) => row.itemId).sort()
    expect(forChair).toEqual(['chair-black', 'chair-grey'])
    expect(state.get('desk')?.parentId).toBe('desk')
  })

  it('moves an item to a new listing when it is sent again under one', async () => {
    await store.recordSent('item-1', 'old-parent', { price: 1, currency: 'GBP', availability: 'IN_STOCK' }, true)
    await store.recordSent('item-1', 'new-parent', { price: 1, currency: 'GBP', availability: 'IN_STOCK' }, true)
    expect((await store.readAllPushState()).get('item-1')?.parentId).toBe('new-parent')
  })

  it('forgets items taken back out of Merchant Center', async () => {
    await store.recordSent('item-1', 'item-1', { price: 1, currency: 'GBP', availability: 'IN_STOCK' }, true)
    await store.recordSent('item-2', 'item-2', { price: 2, currency: 'GBP', availability: 'IN_STOCK' }, true)
    expect(await store.forgetItems(['item-1'])).toBe(1)
    expect([...(await store.readAllPushState()).keys()]).toEqual(['item-2'])
  })

  // -------------------------------------------------------------------------
  // The reconcile sample
  // -------------------------------------------------------------------------

  it('leaves out anything sent inside the grace period', async () => {
    // Merchant Center processes an input asynchronously, so an item asked about
    // straight after it was sent disagrees for an innocent reason.
    await store.recordSent('fresh', 'fresh', { price: 1, currency: 'GBP', availability: 'IN_STOCK' }, true)
    await store.recordSent('settled', 'settled', { price: 2, currency: 'GBP', availability: 'IN_STOCK' }, true)
    await db.$executeRawUnsafe(`UPDATE "gsf_push_state" SET "sent_at" = CURRENT_TIMESTAMP - interval '5 hours' WHERE "item_id" = 'settled'`)

    const sample = await store.sampleForReconcile(10, 120)
    expect(sample.map((row) => row.itemId)).toEqual(['settled'])
  })

  it('takes the never-checked first, then the longest ago', async () => {
    for (const id of ['never', 'old', 'recent']) {
      await store.recordSent(id, id, { price: 1, currency: 'GBP', availability: 'IN_STOCK' }, true)
    }
    await db.$executeRawUnsafe(`UPDATE "gsf_push_state" SET "sent_at" = CURRENT_TIMESTAMP - interval '5 hours'`)
    await db.$executeRawUnsafe(`UPDATE "gsf_push_state" SET "reconciled_at" = CURRENT_TIMESTAMP - interval '3 hours' WHERE "item_id" = 'old'`)
    await db.$executeRawUnsafe(`UPDATE "gsf_push_state" SET "reconciled_at" = CURRENT_TIMESTAMP - interval '1 hour' WHERE "item_id" = 'recent'`)

    const sample = await store.sampleForReconcile(10, 60)
    expect(sample.map((row) => row.itemId)).toEqual(['never', 'old', 'recent'])
  })

  it('never samples an item whose last attempt was refused', async () => {
    // It has not been sent successfully, so there is nothing to compare; the
    // run retries it instead.
    await store.recordFailed('refused', 'refused', { price: 1, currency: 'GBP', availability: 'IN_STOCK' }, 'no')
    await db.$executeRawUnsafe(`UPDATE "gsf_push_state" SET "sent_at" = CURRENT_TIMESTAMP - interval '5 hours'`)
    expect(await store.sampleForReconcile(10, 60)).toEqual([])
  })

  it('asks for nothing when the sample size is zero', async () => {
    await store.recordSent('item-1', 'item-1', { price: 1, currency: 'GBP', availability: 'IN_STOCK' }, true)
    expect(await store.sampleForReconcile(0, 0)).toEqual([])
  })

  it('keeps both sides of a disagreement', async () => {
    await store.recordSent('item-1', 'item-1', { price: 900, currency: 'GBP', availability: 'IN_STOCK' }, true)
    await store.recordReconcile('item-1', 'differs', {
      sent: { price: 900, currency: 'GBP', availability: 'IN_STOCK' },
      google: { price: 950, currency: 'GBP', availability: 'OUT_OF_STOCK' },
      checkedAt: '2026-09-23T10:00:00.000Z',
    })

    const rows = await store.readDisagreements(10)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.reconcileResult).toBe('differs')
    expect((rows[0]?.reconcileDetail as { google: { price: number } }).google.price).toBe(950)
  })

  it('settles a stored disagreement without touching the time it was checked', async () => {
    await store.recordSent('item-1', 'item-1', { price: 153.6, currency: 'GBP', availability: 'IN_STOCK' }, true)
    await store.recordSent('item-2', 'item-2', { price: 10, currency: 'GBP', availability: 'IN_STOCK' }, true)
    await store.recordReconcile('item-1', 'differs', { google: { price: 391.2, salePrice: 153.6, currency: 'GBP', availability: 'IN_STOCK' } })
    await store.recordReconcile('item-2', 'agrees', null)
    const before = (await store.readDisagreements(10))[0]?.reconciledAt

    await store.settleDisagreement('item-1')
    // An item that already agrees is left exactly as it was.
    await store.settleDisagreement('item-2')

    expect(await store.readDisagreements(10)).toEqual([])
    const state = await store.readAllPushState()
    expect(state.get('item-1')?.reconcileResult).toBe('agrees')
    expect(state.get('item-1')?.reconcileDetail).toBeNull()
    expect(state.get('item-1')?.reconciledAt?.getTime()).toBe(before?.getTime())
    expect(state.get('item-2')?.reconcileResult).toBe('agrees')
  })

  it('counts what is wrong without confusing the three kinds of wrong', async () => {
    await store.recordSent('good', 'good', { price: 1, currency: 'GBP', availability: 'IN_STOCK' }, true)
    await store.recordSent('unread', 'unread', { price: 2, currency: 'GBP', availability: 'IN_STOCK' }, false)
    await store.recordFailed('refused', 'refused', { price: 3, currency: 'GBP', availability: 'IN_STOCK' }, 'no')
    await store.recordSent('drifted', 'drifted', { price: 4, currency: 'GBP', availability: 'IN_STOCK' }, true)
    await store.recordReconcile('drifted', 'differs', { google: null })

    const totals = await store.readPushTotals()
    expect(totals.tracked).toBe(4)
    expect(totals.unconfirmed).toBe(1)
    expect(totals.failed).toBe(1)
    expect(totals.differs).toBe(1)
    expect(totals.reconciledAt).not.toBeNull()

    expect((await store.readRecentFailures(10)).map((row) => row.itemId)).toEqual(['refused'])
  })

  it('reports no comparison at all as null rather than as agreement', async () => {
    await store.recordSent('item-1', 'item-1', { price: 1, currency: 'GBP', availability: 'IN_STOCK' }, true)
    const totals = await store.readPushTotals()
    expect(totals.reconciledAt).toBeNull()
    expect(totals.differs).toBe(0)
  })

  // -------------------------------------------------------------------------
  // The change log's pruning, which the link's Undo depends on
  // -------------------------------------------------------------------------

  it('never prunes the setup entries out from under their Undo', async () => {
    // KEEP_PER_AREA is 200 and a busy shop writes a `push` entry every few
    // minutes, so counting the one-off `link` entry among them would prune the
    // only way back inside a day.
    const changeLog = await import('@/modules/google-shopping-for-shop/lib/change-log')
    await db.$executeRawUnsafe(`DELETE FROM "gsf_change_log"`)

    await changeLog.recordChange({
      area: 'live-updates', action: 'link', summary: 'Connected the live updates', createdBy: null,
      before: { rule: [] }, after: { rule: [{ self: true }] },
    })
    // Well past the cap, all of them routine.
    await db.$executeRawUnsafe(`
      INSERT INTO "gsf_change_log" ("area", "action", "summary", "created_at")
      SELECT 'live-updates', 'push', 'Sent some products to Google', CURRENT_TIMESTAMP + make_interval(secs => i)
      FROM generate_series(1, 260) AS i
    `)
    await changeLog.pruneChangeLog()

    const left = await changeLog.listChanges({ area: 'live-updates', limit: 500 })
    expect(left.some((entry) => entry.action === 'link')).toBe(true)
    // ...and the routine ones ARE still capped.
    expect(left.filter((entry) => entry.action === 'push').length).toBeLessThanOrEqual(200)
    await db.$executeRawUnsafe(`DELETE FROM "gsf_change_log"`)
  })

  // -------------------------------------------------------------------------
  // The claim - the brake
  // -------------------------------------------------------------------------

  it('gives the slot to exactly one of two runs starting at the same instant', async () => {
    const [first, second] = await Promise.all([store.claimPushRun(0), store.claimPushRun(0)])
    expect([first, second].filter(Boolean)).toHaveLength(1)
  })

  it('refuses a second run inside the debounce gap and allows it after', async () => {
    expect(await store.claimPushRun(0)).toBe(true)
    await store.releasePushRun({ status: 'ok', sent: 1, unchanged: 0, removed: 0, failed: 0, leftQueued: 0 })

    // The slot is free, but the gap has not passed.
    expect(await store.claimPushRun(120)).toBe(false)
    // A run on a timer passes 0 and is never held off.
    expect(await store.claimPushRun(0)).toBe(true)
  })

  it('refuses while another run still holds the claim, and takes it once that one is stale', async () => {
    expect(await store.claimPushRun(0)).toBe(true)
    expect(await store.claimPushRun(0)).toBe(false)

    await db.$executeRawUnsafe(`UPDATE "gsf_push_run" SET "claimed_at" = CURRENT_TIMESTAMP - interval '10 minutes', "started_at" = CURRENT_TIMESTAMP - interval '10 minutes'`)
    expect(await store.claimPushRun(0)).toBe(true)
  })

  it('moves the finished stamp only when a run actually finishes', async () => {
    await store.claimPushRun(0)
    const midRun = await store.readPushRun()
    expect(midRun.startedAt).not.toBeNull()
    expect(midRun.finishedAt).toBeNull()
    expect(midRun.claimedAt).not.toBeNull()

    await store.releasePushRun({ status: 'part', sent: 3, unchanged: 1, removed: 2, failed: 4, leftQueued: 0, message: 'Google said no' })
    const done = await store.readPushRun()
    expect(done.claimedAt).toBeNull()
    expect(done.finishedAt).not.toBeNull()
    expect(done.status).toBe('part')
    expect([done.sent, done.removed, done.failed]).toEqual([3, 2, 4])
    expect(done.lastError).toBe('Google said no')
  })

  it('lets a claimed run be abandoned without stamping anything', async () => {
    await store.claimPushRun(0)
    await store.abandonPushRun()
    const run = await store.readPushRun()
    expect(run.claimedAt).toBeNull()
    expect(run.finishedAt).toBeNull()
    expect(run.status).toBeNull()
  })

  it('stamps the hourly comparison separately from the send', async () => {
    await store.claimPushRun(0)
    await store.releasePushRun({ status: 'ok', sent: 1, unchanged: 0, removed: 0, failed: 0, leftQueued: 0 })
    await store.recordReconcileRun(20, 2)

    const run = await store.readPushRun()
    expect(run.status).toBe('ok')
    expect(run.reconciledAt).not.toBeNull()
    expect(run.reconcileChecked).toBe(20)
    expect(run.reconcileDiffers).toBe(2)
  })
})
