import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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

// Past one write/log chunk (2,500), so the chunking itself is exercised.
const CATALOGUE = 2600

type ChangesModule = typeof import('@/modules/google-shopping-for-shop/lib/title-template-changes')
type TemplatesModule = typeof import('@/modules/google-shopping-for-shop/lib/title-templates')
type TablesModule = typeof import('@/modules/google-shopping-for-shop/lib/workbench-tables')

describe.skipIf(!cfg)('google-shopping workbench SQL against a real database', () => {
  let db: PrismaClient
  let dbName: string
  let roleName: string
  let changes: ChangesModule
  let templates: TemplatesModule
  let tables: TablesModule

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
})
