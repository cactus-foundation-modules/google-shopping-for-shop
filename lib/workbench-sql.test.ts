import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import {
  vpsConfigFromEnv, createTestRole, createTestDatabase, connectionUri,
  dropTestDatabase, dropTestRole, dropStaleTestObjects, TEST_PREFIX,
} from '@/lib/backup/vps-database'
import { splitMigrationStatements } from '@/lib/backup/migration-sql'

// The workbench's own SQL, executed through the real functions: the title
// template change log and its undo, the chunked writes a whole-catalogue save
// makes, the log's pruning window, and the fingerprint and snapshot reads the
// in-memory cache is keyed on. Typecheck, eslint and the build all see raw SQL
// as a string; only a database can say it parses and does what it claims.
//
// SKIPS SILENTLY without OVH_SERVER / OVH_USER / OVH_PASSWORD in the shell, like
// lib/feed-sql.test.ts. A skip is not a pass - export them from the Deskwell
// workspace's .env for the run. Provisions and drops its own throwaway database
// under TEST_PREFIX; it touches nothing else on the box.
//
// The functions under test use the app's shared Prisma client, which reads
// DATABASE_URL when first imported - so they are imported only once
// DATABASE_URL points at the throwaway database.
const cfg = (() => { try { return vpsConfigFromEnv() } catch { return null } })()

// See lib/feed-rules-sql.test.ts: these are round trips to a remote database,
// and the default five seconds is a local-database figure.
vi.setConfig({ testTimeout: 30_000 })

// Past one write/log chunk (2,500), so the chunking itself is exercised.
const CATALOGUE = 2600

type ChangesModule = typeof import('@/modules/google-shopping-for-shop/lib/title-template-changes')
type TemplatesModule = typeof import('@/modules/google-shopping-for-shop/lib/title-templates')
type TablesModule = typeof import('@/modules/google-shopping-for-shop/lib/workbench-tables')
type ChangeLogModule = typeof import('@/modules/google-shopping-for-shop/lib/change-log')

describe.skipIf(!cfg)('google-shopping workbench SQL against a real database', () => {
  let db: PrismaClient
  let dbName: string
  let roleName: string
  let changes: ChangesModule
  let templates: TemplatesModule
  let tables: TablesModule
  let changeLog: ChangeLogModule

  const meta = { summarise: (changed: number) => `Edited ${changed}`, createdBy: 'Workbench test' }

  async function templateOf(id: string): Promise<string | null> {
    const rows = await db.$queryRaw<Array<{ title_template: string }>>`SELECT "title_template" FROM "gsf_title_templates" WHERE "item_id" = ${id}`
    return rows[0]?.title_template ?? null
  }

  beforeAll(async () => {
    const suffix = `${Date.now()}`.slice(-9)
    dbName = `${TEST_PREFIX}gsw_${suffix}`
    roleName = `${TEST_PREFIX}role_gsw_${suffix}`
    await dropStaleTestObjects(cfg!)
    const role = await createTestRole(cfg!, roleName)
    await createTestDatabase(cfg!, dbName, role)
    const url = connectionUri(cfg!, dbName, role)
    db = new PrismaClient({ datasources: { db: { url } } })

    const initSql = path.join(process.cwd(), 'prisma/migrations/20260626000000_init/migration.sql')
    for (const statement of splitMigrationStatements(readFileSync(initSql, 'utf8'))) await db.$executeRawUnsafe(statement)
    for (const moduleName of ['shop', 'google-shopping-for-shop']) {
      const dir = path.join(process.cwd(), 'modules', moduleName, 'migrations')
      for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
        for (const statement of splitMigrationStatements(readFileSync(path.join(dir, file), 'utf8'))) await db.$executeRawUnsafe(statement)
      }
    }
    await db.$executeRaw`
      INSERT INTO "shp_products" ("id", "name", "slug", "type", "price")
      SELECT 'p' || g, 'Product ' || g, 'product-' || g, 'PHYSICAL', 10
      FROM generate_series(1, ${CATALOGUE}::int) AS g
    `

    process.env.DATABASE_URL = url
    changes = await import('@/modules/google-shopping-for-shop/lib/title-template-changes')
    templates = await import('@/modules/google-shopping-for-shop/lib/title-templates')
    tables = await import('@/modules/google-shopping-for-shop/lib/workbench-tables')
    changeLog = await import('@/modules/google-shopping-for-shop/lib/change-log')
  }, 300_000)

  afterAll(async () => {
    const shared = await import('@/lib/db/prisma').catch(() => null)
    await shared?.prisma.$disconnect().catch(() => {})
    await db?.$disconnect().catch(() => {})
    if (dbName) await dropTestDatabase(cfg!, dbName).catch(() => {})
    if (roleName) await dropTestRole(cfg!, roleName).catch(() => {})
  }, 180_000)

  it('015 creates the change log, and survives being applied twice', async () => {
    const sql = readFileSync(path.join(process.cwd(), 'modules/google-shopping-for-shop/migrations/015_title_template_changes.sql'), 'utf8')
    for (const statement of splitMigrationStatements(sql)) await db.$executeRawUnsafe(statement)
    const found = await db.$queryRaw<Array<{ table_name: string }>>`
      SELECT "table_name" FROM information_schema.tables
      WHERE "table_name" IN ('gsf_title_template_batches', 'gsf_title_template_batch_items')
      ORDER BY "table_name"
    `
    expect(found.map((row) => row.table_name)).toEqual(['gsf_title_template_batch_items', 'gsf_title_template_batches'])
  })

  it('saves only what changes, logs it as one batch, and skips ids that are not products', async () => {
    const first = await changes.applyTitleTemplateChanges([
      { itemId: 'p1', titleTemplate: `O'Brien <sku> 24" chair` },
      { itemId: 'p2', titleTemplate: 'B' },
      { itemId: 'p3', titleTemplate: null },
      { itemId: 'ghost', titleTemplate: 'X' },
    ], meta)
    expect(first).toMatchObject({ changed: 2, unchanged: 1, missing: 1 })
    expect(first.batchId).toBeTruthy()
    expect(await templateOf('p1')).toBe(`O'Brien <sku> 24" chair`)

    const logged = await db.$queryRaw<Array<{ item_id: string; previous_template: string | null; new_template: string | null }>>`
      SELECT "item_id", "previous_template", "new_template" FROM "gsf_title_template_batch_items"
      WHERE "batch_id" = ${first.batchId} ORDER BY "item_id"
    `
    expect(logged).toEqual([
      { item_id: 'p1', previous_template: null, new_template: `O'Brien <sku> 24" chair` },
      { item_id: 'p2', previous_template: null, new_template: 'B' },
    ])

    const again = await changes.applyTitleTemplateChanges([{ itemId: 'p1', titleTemplate: `  O'Brien <sku> 24" chair ` }], meta)
    expect(again).toEqual({ batchId: null, changed: 0, unchanged: 1, missing: 0 })

    const listed = await changes.listTitleTemplateBatches(5)
    expect(listed[0]).toMatchObject({ id: first.batchId, summary: 'Edited 2', itemCount: 2, createdBy: 'Workbench test', undoneAt: null })
  })

  it('undo restores only what is still as the batch left it, once', async () => {
    const batch = await changes.applyTitleTemplateChanges([
      { itemId: 'p1', titleTemplate: 'A2' },
      { itemId: 'p2', titleTemplate: null },
    ], meta)
    // Someone edits p2 again afterwards: undo must not trample it.
    await changes.applyTitleTemplateChanges([{ itemId: 'p2', titleTemplate: 'Later edit' }], meta)

    const undone = await changes.undoTitleTemplateBatch(batch.batchId!, 'Workbench test')
    expect(undone).toMatchObject({ status: 'undone', restored: 1, skipped: 1 })
    expect(await templateOf('p1')).toBe(`O'Brien <sku> 24" chair`)
    expect(await templateOf('p2')).toBe('Later edit')

    expect(await changes.undoTitleTemplateBatch(batch.batchId!, null)).toEqual({ status: 'already-undone' })
    expect(await changes.undoTitleTemplateBatch('no-such-batch', null)).toEqual({ status: 'not-found' })

    // The undo is a batch of its own, so it can be undone in turn.
    const redo = await changes.undoTitleTemplateBatch((undone as { batchId: string }).batchId, null)
    expect(redo).toMatchObject({ status: 'undone', restored: 1, skipped: 0 })
    expect(await templateOf('p1')).toBe('A2')
  })

  it('a whole-catalogue save crosses the write and log chunks', async () => {
    const ids = Array.from({ length: CATALOGUE }, (_unused, index) => `p${index + 1}`)
    const set = await changes.applyTitleTemplateChanges(ids.map((itemId) => ({ itemId, titleTemplate: 'Bulk <sku>' })), meta)
    expect(set.changed).toBe(CATALOGUE)
    const [logged] = await db.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS "count" FROM "gsf_title_template_batch_items" WHERE "batch_id" = ${set.batchId}
    `
    expect(logged?.count).toBe(CATALOGUE)
    expect((await templates.getTitleTemplatesForItems(ids)).size).toBe(CATALOGUE)
    expect((await templates.getAllTitleTemplates()).size).toBe(CATALOGUE)

    const cleared = await changes.applyTitleTemplateChanges(ids.map((itemId) => ({ itemId, titleTemplate: null })), meta)
    expect(cleared.changed).toBe(CATALOGUE)
    expect((await templates.getAllTitleTemplates()).size).toBe(0)
  }, 120_000)

  it('prunes the log to its window, always keeping the newest', async () => {
    let newest: string | null = null
    for (let round = 0; round < 55; round++) {
      const saved = await changes.applyTitleTemplateChanges([{ itemId: 'p9', titleTemplate: `Round ${round}` }], meta)
      newest = saved.batchId
    }
    const [row] = await db.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS "count" FROM "gsf_title_template_batches"`
    expect(row?.count).toBe(50)
    const listed = await changes.listTitleTemplateBatches(1)
    expect(listed[0]?.id).toBe(newest)
  }, 120_000)

  it('fingerprints move on every kind of change, and snapshots read back typed', async () => {
    const start = await tables.readWorkbenchFingerprints()

    await changes.applyTitleTemplateChanges([{ itemId: 'p5', titleTemplate: 'Five' }], meta)
    const added = await tables.readWorkbenchFingerprints()
    expect(added.templates).not.toBe(start.templates)
    expect(added.snapshots).toBe(start.snapshots)

    // Same number of rows, different content.
    await changes.applyTitleTemplateChanges([{ itemId: 'p5', titleTemplate: 'Five, again' }], meta)
    const edited = await tables.readWorkbenchFingerprints()
    expect(edited.templates).not.toBe(added.templates)

    await db.$executeRaw`
      INSERT INTO "gsf_item_match_status" ("item_id", "matched", "merchant_title", "benchmark_amount_micros", "benchmark_currency")
      VALUES ('p5', true, 'Held title', 123450000, 'GBP')
    `
    const reported = await tables.readWorkbenchFingerprints()
    expect(reported.snapshots).not.toBe(edited.snapshots)
    const snapshots = await tables.readMatchSnapshots()
    expect(snapshots.get('p5')).toMatchObject({ matched: true, merchantTitle: 'Held title', benchmarkAmountMicros: '123450000', benchmarkCurrency: 'GBP' })
    expect(snapshots.get('p5')?.checkedAt).toBeInstanceOf(Date)

    await db.$executeRaw`UPDATE "gsf_item_match_status" SET "merchant_title" = 'Renamed' WHERE "item_id" = 'p5'`
    expect((await tables.readWorkbenchFingerprints()).snapshots).not.toBe(reported.snapshots)
  })

  // ----- The general change log (migration 016) -----------------------------
  // Its own table, its own undo, and nothing to do with the title template
  // batches above: one line per change, with a before and an after the area
  // that wrote it decides the shape of.

  it('016 creates the general change log, and survives being applied twice', async () => {
    const sql = readFileSync(path.join(process.cwd(), 'modules/google-shopping-for-shop/migrations/016_change_log.sql'), 'utf8')
    for (const statement of splitMigrationStatements(sql)) await db.$executeRawUnsafe(statement)
    const found = await db.$queryRaw<Array<{ table_name: string }>>`
      SELECT "table_name" FROM information_schema.tables WHERE "table_name" = 'gsf_change_log'
    `
    expect(found).toHaveLength(1)
    const indexes = await db.$queryRaw<Array<{ indexname: string }>>`
      SELECT "indexname" FROM pg_indexes WHERE "tablename" = 'gsf_change_log' ORDER BY "indexname"
    `
    expect(indexes.map((row) => row.indexname)).toContain('gsf_change_log_area_created_idx')
  })

  it('writes jsonb snapshots and reads them back as the shapes they went in as', async () => {
    const id = await changeLog.recordChange({
      area: 'feed-rules',
      action: 'update',
      summary: 'Turned on the rule "Clearance"',
      // Deliberately awkward: an object, an array, a bare scalar and a null all
      // go into the same jsonb column, and a JS array here must NOT be written
      // as a Postgres array literal.
      before: { enabled: false, labels: [], note: null },
      after: { enabled: true, labels: ['a', 'b'], note: "O'Brien" },
      createdBy: 'Workbench test',
    })
    expect(id).toBeTruthy()

    const entry = await changeLog.getChange(id)
    expect(entry).toMatchObject({ area: 'feed-rules', action: 'update', summary: 'Turned on the rule "Clearance"', createdBy: 'Workbench test', undoneAt: null })
    expect(entry?.before).toEqual({ enabled: false, labels: [], note: null })
    expect(entry?.after).toEqual({ enabled: true, labels: ['a', 'b'], note: "O'Brien" })
    expect(entry?.createdAt).toBeInstanceOf(Date)

    // A change with nothing before it leaves the column NULL rather than the
    // JSON document `null`, which is a different thing in jsonb.
    const created = await changeLog.recordChange({ area: 'shipping', action: 'create', summary: 'Sent delivery settings', after: [1, 2, 3], createdBy: null })
    const nulls = await db.$queryRaw<Array<{ before_is_null: boolean }>>`
      SELECT ("before" IS NULL) AS "before_is_null" FROM "gsf_change_log" WHERE "id" = ${created}
    `
    expect(nulls[0]?.before_is_null).toBe(true)
    expect((await changeLog.getChange(created))?.after).toEqual([1, 2, 3])
    expect(await changeLog.getChange('no-such-entry')).toBeNull()
  })

  it('lists one area or all of them, newest first', async () => {
    const all = await changeLog.listChanges({ limit: 50 })
    expect(all.length).toBeGreaterThanOrEqual(2)
    expect(all[0]?.area).toBe('shipping')

    const rules = await changeLog.listChanges({ area: 'feed-rules', limit: 50 })
    expect(rules.every((entry) => entry.area === 'feed-rules')).toBe(true)
    expect(rules.some((entry) => entry.summary === 'Turned on the rule "Clearance"')).toBe(true)
  })

  it('refuses to undo an area that has registered no handler', async () => {
    const id = await changeLog.recordChange({ area: 'products', action: 'update', summary: 'Something', before: { a: 1 }, after: { a: 2 }, createdBy: null })
    expect(await changeLog.undoChange(id, null)).toEqual({ status: 'not-undoable' })
    // And it stays un-undone, so a handler arriving later can still put it back.
    expect((await changeLog.getChange(id))?.undoneAt).toBeNull()
  })

  it('undoes through the area handler, once, and records the undo as its own entry', async () => {
    // Stands in for a real area: the handler is handed the entry and the open
    // transaction, and says what it managed to put back.
    const seen: Array<{ before: unknown; after: unknown }> = []
    changeLog.registerUndoHandler('settings', async ({ entry, tx }) => {
      seen.push({ before: entry.before, after: entry.after })
      // Proves the handler really is inside the transaction it was given.
      await tx.$executeRaw`SELECT 1`
      return { restored: 2, skipped: 1 }
    })

    const id = await changeLog.recordChange({
      area: 'settings',
      action: 'update',
      summary: 'Turned on delivery charges',
      before: { sendDeliveryOptions: false },
      after: { sendDeliveryOptions: true },
      createdBy: 'Workbench test',
    })

    const outcome = await changeLog.undoChange(id, 'Someone else')
    expect(outcome).toMatchObject({ status: 'undone', restored: 2, skipped: 1 })
    expect(seen).toEqual([{ before: { sendDeliveryOptions: false }, after: { sendDeliveryOptions: true } }])
    expect((await changeLog.getChange(id))?.undoneAt).toBeInstanceOf(Date)

    const undoEntry = await changeLog.getChange((outcome as { entryId: string }).entryId)
    expect(undoEntry).toMatchObject({ area: 'settings', action: 'undo', summary: 'Undid "Turned on delivery charges"', createdBy: 'Someone else' })
    // The undo took away what the change put in, so the pair reads round the
    // other way - which is what makes an undo undoable in its turn.
    expect(undoEntry?.before).toEqual({ sendDeliveryOptions: true })
    expect(undoEntry?.after).toEqual({ sendDeliveryOptions: false })

    expect(await changeLog.undoChange(id, null)).toEqual({ status: 'already-undone' })
    expect(await changeLog.undoChange('no-such-entry', null)).toEqual({ status: 'not-found' })
    expect(changeLog.canUndoArea('settings')).toBe(true)

    // Undo the undo: the handler is handed the undo entry, whose pair is the
    // original's swapped round - so it sees "put delivery charges back on".
    const redo = await changeLog.undoChange(undoEntry!.id, 'Workbench test')
    expect(redo).toMatchObject({ status: 'undone', restored: 2, skipped: 1 })
    expect(seen[1]).toEqual({ before: { sendDeliveryOptions: true }, after: { sendDeliveryOptions: false } })
    const redoEntry = await changeLog.getChange((redo as { entryId: string }).entryId)
    expect(redoEntry).toMatchObject({ action: 'undo', summary: 'Undid "Undid \"Turned on delivery charges\""' })
    expect(redoEntry?.before).toEqual({ sendDeliveryOptions: false })
    expect(redoEntry?.after).toEqual({ sendDeliveryOptions: true })
  })

  it('leaves the entry alone when the handler throws', async () => {
    // A different area from the no-handler test above, which must keep having
    // no handler however these are ordered.
    changeLog.registerUndoHandler('feed-rules', async () => { throw new Error('the rule is gone') })
    const id = await changeLog.recordChange({ area: 'feed-rules', action: 'update', summary: 'Doomed', createdBy: null })
    await expect(changeLog.undoChange(id, null)).rejects.toThrow('the rule is gone')
    expect((await changeLog.getChange(id))?.undoneAt).toBeNull()
  })

  it('prunes each area to its own window, and drops anything too old', async () => {
    // Straight into the table: the pruning window is 200 an area, and 200
    // separate transactions over the wire would test nothing extra.
    await db.$executeRaw`
      INSERT INTO "gsf_change_log" ("area", "action", "summary", "created_at")
      SELECT 'feed-rules', 'update', 'Bulk ' || g, CURRENT_TIMESTAMP - make_interval(mins => g)
      FROM generate_series(1, 260::int) AS g
    `
    await db.$executeRaw`
      INSERT INTO "gsf_change_log" ("area", "action", "summary", "created_at")
      VALUES ('shipping', 'push', 'Ancient', CURRENT_TIMESTAMP - make_interval(days => 500))
    `
    const shippingBefore = await changeLog.listChanges({ area: 'shipping', limit: 500 })

    await changeLog.pruneChangeLog()

    const rules = await changeLog.listChanges({ area: 'feed-rules', limit: 500 })
    expect(rules).toHaveLength(200)
    // The newest survive; the oldest are the ones that go.
    expect(rules.some((entry) => entry.summary === 'Bulk 1')).toBe(true)
    expect(rules.some((entry) => entry.summary === 'Bulk 260')).toBe(false)

    const shipping = await changeLog.listChanges({ area: 'shipping', limit: 500 })
    expect(shipping.some((entry) => entry.summary === 'Ancient')).toBe(false)
    // A quiet area keeps everything else it had: one busy area cannot push
    // another's history out.
    expect(shipping.length).toBe(shippingBefore.length - 1)
  }, 120_000)
})
