import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import {
  vpsConfigFromEnv, createTestRole, createTestDatabase, connectionUri,
  dropTestDatabase, dropTestRole, dropStaleTestObjects, TEST_PREFIX,
} from '@/lib/backup/vps-database'
import { splitMigrationStatements } from '@/lib/backup/migration-sql'
import type { RuleDraft } from '@/modules/google-shopping-for-shop/lib/feed-rules/types'

// Feed rules' own SQL, executed through the real functions: migration 017 and
// what it does to existing opt-outs, the rule store and every undo it
// registers, the per-product and per-variation feed choice with its undo, the
// bulk reads the feed build now makes, and the workbench fingerprint that
// tells a held catalogue it is out of date. Typecheck, eslint and the build all
// see raw SQL as a string; only a database can say it parses and does what it
// claims.
//
// SKIPS SILENTLY without OVH_SERVER / OVH_USER / OVH_PASSWORD in the shell, like
// lib/workbench-sql.test.ts. A skip is not a pass - export them from the
// Deskwell workspace's .env for the run. Provisions and drops its own
// throwaway database under TEST_PREFIX; it touches nothing else on the box.
//
// Its own file, and so its own module registry: the change log's undo
// handlers register at import, and lib/workbench-sql.test.ts registers stand-in
// handlers of its own that must not replace the real ones here.
const cfg = (() => { try { return vpsConfigFromEnv() } catch { return null } })()

// Every case here is several round trips to a Postgres on the other side of
// the country, and a case that writes, reads back and undoes is a dozen.
// Vitest's default five seconds is a local-database figure: against the real
// box these pass in a second or two and then time out on an unlucky run,
// which reads as a failure with no assertion in it.
vi.setConfig({ testTimeout: 30_000 })

type StoreModule = typeof import('@/modules/google-shopping-for-shop/lib/feed-rules/store')
type ChoiceModule = typeof import('@/modules/google-shopping-for-shop/lib/feed-choice')
type ChangeLogModule = typeof import('@/modules/google-shopping-for-shop/lib/change-log')
type ProductDataModule = typeof import('@/modules/google-shopping-for-shop/lib/product-data')
type FactsModule = typeof import('@/modules/google-shopping-for-shop/lib/feed-rules/facts')
type TablesModule = typeof import('@/modules/google-shopping-for-shop/lib/workbench-tables')

const exclude = (name: string, supplier: string): RuleDraft => ({
  name,
  enabled: true,
  conditions: { op: 'all', items: [{ field: 'supplier', operator: 'equals', value: supplier }] },
  action: { type: 'exclude' },
})

describe.skipIf(!cfg)('google-shopping feed rules SQL against a real database', () => {
  let db: PrismaClient
  let dbName: string
  let roleName: string
  let store: StoreModule
  let choice: ChoiceModule
  let changeLog: ChangeLogModule
  let productData: ProductDataModule
  let facts: FactsModule
  let tables: TablesModule

  beforeAll(async () => {
    const suffix = `${Date.now()}`.slice(-9)
    dbName = `${TEST_PREFIX}gsr_${suffix}`
    roleName = `${TEST_PREFIX}role_gsr_${suffix}`
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
      FROM generate_series(1, 20::int) AS g
    `
    await db.$executeRaw`INSERT INTO "shp_categories" ("id", "name", "slug") VALUES ('cat-a', 'A', 'a'), ('cat-b', 'B', 'b')`
    await db.$executeRaw`INSERT INTO "shp_product_categories" ("product_id", "category_id") VALUES ('p1', 'cat-a'), ('p1', 'cat-b'), ('p2', 'cat-b')`

    process.env.DATABASE_URL = url
    store = await import('@/modules/google-shopping-for-shop/lib/feed-rules/store')
    choice = await import('@/modules/google-shopping-for-shop/lib/feed-choice')
    changeLog = await import('@/modules/google-shopping-for-shop/lib/change-log')
    productData = await import('@/modules/google-shopping-for-shop/lib/product-data')
    facts = await import('@/modules/google-shopping-for-shop/lib/feed-rules/facts')
    tables = await import('@/modules/google-shopping-for-shop/lib/workbench-tables')
    // What every undo route loads: registers the real feed-rules and products handlers.
    await import('@/modules/google-shopping-for-shop/lib/change-log-handlers')
  }, 300_000)

  afterAll(async () => {
    const shared = await import('@/lib/db/prisma').catch(() => null)
    await shared?.prisma.$disconnect().catch(() => {})
    await db?.$disconnect().catch(() => {})
    if (dbName) await dropTestDatabase(cfg!, dbName).catch(() => {})
    if (roleName) await dropTestRole(cfg!, roleName).catch(() => {})
  }, 180_000)

  // ----- Migration 017 ---------------------------------------------------------

  it('017 turns every old "keep out" tick into "never send", leaves other choices alone, and survives a second run', async () => {
    await db.$executeRaw`
      INSERT INTO "gsf_product_data" ("product_id", "excluded", "feed_choice") VALUES
        ('p10', true, 'rules'), ('p11', false, 'rules'), ('p12', false, 'include')
    `
    const sql = readFileSync(path.join(process.cwd(), 'modules/google-shopping-for-shop/migrations/017_feed_rules.sql'), 'utf8')
    for (const statement of splitMigrationStatements(sql)) await db.$executeRawUnsafe(statement)
    for (const statement of splitMigrationStatements(sql)) await db.$executeRawUnsafe(statement)

    const rows = await db.$queryRaw<Array<{ product_id: string; feed_choice: string }>>`
      SELECT "product_id", "feed_choice" FROM "gsf_product_data" WHERE "product_id" IN ('p10', 'p11', 'p12') ORDER BY "product_id"
    `
    expect(rows).toEqual([
      { product_id: 'p10', feed_choice: 'exclude' },
      { product_id: 'p11', feed_choice: 'rules' },
      { product_id: 'p12', feed_choice: 'include' },
    ])
    await expect(db.$executeRaw`UPDATE "gsf_product_data" SET "feed_choice" = 'sometimes' WHERE "product_id" = 'p11'`).rejects.toThrow()
    const columns = await db.$queryRaw<Array<{ column_name: string }>>`
      SELECT "column_name" FROM information_schema.columns WHERE "table_name" = 'gsf_settings' AND "column_name" = 'rules_range_attribute_id'
    `
    expect(columns).toHaveLength(1)
    await db.$executeRaw`DELETE FROM "gsf_product_data"`
  })

  // ----- The rule store and its undo -------------------------------------------

  it('adds rules at the end of the list, and logs each one', async () => {
    const first = await store.createFeedRule(exclude('First', 'Acme'), 'Tester')
    const second = await store.createFeedRule({ ...exclude('Second', "O'Brien & Sons"), action: { type: 'custom_label', slot: 2, value: 'obrien' } }, 'Tester')
    expect(first.rule.position).toBe(0)
    expect(second.rule.position).toBe(1)
    expect(second.rule.action).toEqual({ type: 'custom_label', slot: 2, value: 'obrien' })
    const listed = await store.listFeedRules()
    expect(listed.map((rule) => rule.name)).toEqual(['First', 'Second'])
    expect(listed[1]?.conditions).toEqual({ op: 'all', items: [{ field: 'supplier', operator: 'equals', value: "O'Brien & Sons" }] })
    const entry = await changeLog.getChange(first.changeId)
    expect(entry).toMatchObject({ area: 'feed-rules', action: 'create', summary: 'Added the rule "First"', createdBy: 'Tester' })
  })

  it('logs a plain switch-off as such, and undoes it', async () => {
    const [first] = await store.listFeedRules()
    const outcome = await store.updateFeedRule(first!.id, { ...store.draftOf(first!), enabled: false }, 'Tester')
    expect(outcome.status).toBe('saved')
    const changeId = (outcome as { changeId: string }).changeId
    expect(await changeLog.getChange(changeId)).toMatchObject({ action: 'enable', summary: 'Turned off the rule "First"' })

    // Saving the same content again is not a change, and is not logged.
    const again = await store.updateFeedRule(first!.id, { ...store.draftOf(first!), enabled: false }, 'Tester')
    expect((again as { changeId: string | null }).changeId).toBeNull()

    const undone = await changeLog.undoChange(changeId, 'Tester')
    expect(undone).toMatchObject({ status: 'undone', restored: 1, skipped: 0 })
    expect((await store.getFeedRule(first!.id))?.enabled).toBe(true)
  })

  it('will not undo an edit the rule has moved on from since', async () => {
    const [first] = await store.listFeedRules()
    const renamed = await store.updateFeedRule(first!.id, { ...store.draftOf(first!), name: 'First renamed' }, 'Tester')
    await store.updateFeedRule(first!.id, { ...store.draftOf(first!), name: 'First renamed again' }, 'Someone else')
    const outcome = await changeLog.undoChange((renamed as { changeId: string }).changeId, 'Tester')
    expect(outcome).toMatchObject({ status: 'undone', restored: 0, skipped: 1 })
    expect((await store.getFeedRule(first!.id))?.name).toBe('First renamed again')
  })

  it('reorders, refuses a stale order, and undoes a reorder', async () => {
    const before = await store.listFeedRules()
    const stale = await store.reorderFeedRules([before[1]!.id], 'Tester')
    expect(stale).toEqual({ status: 'stale' })

    const outcome = await store.reorderFeedRules([before[1]!.id, before[0]!.id], 'Tester')
    expect(outcome.status).toBe('saved')
    expect((await store.listFeedRules()).map((rule) => rule.id)).toEqual([before[1]!.id, before[0]!.id])

    const undone = await changeLog.undoChange((outcome as { changeId: string }).changeId, 'Tester')
    expect(undone).toMatchObject({ restored: 1 })
    expect((await store.listFeedRules()).map((rule) => rule.id)).toEqual([before[0]!.id, before[1]!.id])
  })

  it('deletes, and an undo puts the rule back with its id, place and date', async () => {
    const [first] = await store.listFeedRules()
    const deleted = await store.deleteFeedRule(first!.id, 'Tester')
    expect(deleted.status).toBe('deleted')
    expect(await store.getFeedRule(first!.id)).toBeNull()

    const undone = await changeLog.undoChange((deleted as { changeId: string }).changeId, 'Tester')
    expect(undone).toMatchObject({ restored: 1 })
    const back = await store.getFeedRule(first!.id)
    expect(back).toMatchObject({ id: first!.id, name: first!.name, position: first!.position, createdAt: first!.createdAt })

    // The undo's own entry undoes too: deleting it again.
    const redo = await changeLog.undoChange((undone as { entryId: string }).entryId, 'Tester')
    expect(redo).toMatchObject({ restored: 1 })
    expect(await store.getFeedRule(first!.id)).toBeNull()
  })

  it('undoes an add by taking the rule away, unless it has been changed since', async () => {
    const added = await store.createFeedRule(exclude('Temporary', 'Nobody'), 'Tester')
    expect(await changeLog.undoChange(added.changeId, 'Tester')).toMatchObject({ restored: 1 })
    expect(await store.getFeedRule(added.rule.id)).toBeNull()

    const kept = await store.createFeedRule(exclude('Kept', 'Nobody'), 'Tester')
    await store.updateFeedRule(kept.rule.id, { ...exclude('Kept', 'Somebody') }, 'Tester')
    expect(await changeLog.undoChange(kept.changeId, 'Tester')).toMatchObject({ restored: 0, skipped: 1 })
    expect(await store.getFeedRule(kept.rule.id)).not.toBeNull()
  })

  it('reads a rule whose stored JSON no longer makes sense as switched off, rather than failing', async () => {
    await db.$executeRaw`
      INSERT INTO "gsf_feed_rules" ("id", "name", "enabled", "position", "conditions", "action")
      VALUES ('broken', 'Broken', true, 99, '{"op": "sometimes"}'::jsonb, '{"type": "explode"}'::jsonb)
    `
    const broken = await store.getFeedRule('broken')
    expect(broken).toMatchObject({ enabled: false, conditions: { op: 'all', items: [] } })
    await db.$executeRaw`DELETE FROM "gsf_feed_rules" WHERE "id" = 'broken'`
  })

  it('stores the range attribute, and undoes it', async () => {
    const set = await store.setRangeAttributeId('attr-range', { from: null, to: 'Range' }, 'Tester')
    expect(await store.getRangeAttributeId()).toBe('attr-range')
    expect(await store.setRangeAttributeId('attr-range', { from: 'Range', to: 'Range' }, 'Tester')).toEqual({ changeId: null })
    expect(await changeLog.undoChange(set.changeId!, 'Tester')).toMatchObject({ restored: 1 })
    expect(await store.getRangeAttributeId()).toBeNull()
  })

  // ----- Feed choices ------------------------------------------------------------

  it('sets feed choices in one logged change, skipping ids that are not products, and keeps the old column in step', async () => {
    const result = await choice.setFeedChoices(
      [{ productId: 'p1', choice: 'exclude' }, { productId: 'p2', choice: 'include' }, { productId: 'p3', choice: 'rules' }, { productId: 'ghost', choice: 'exclude' }],
      { summary: 'Test choices', createdBy: 'Tester' },
    )
    // p3 was already 'rules', and the ghost is not a product: neither is written or logged.
    expect(result.changed).toBe(2)
    const entry = await changeLog.getChange(result.changeId!)
    expect(entry?.after).toEqual([{ productId: 'p1', choice: 'exclude' }, { productId: 'p2', choice: 'include' }])
    const choices = await choice.getFeedChoices(['p1', 'p2', 'p3', 'ghost'])
    expect(Object.fromEntries(choices)).toEqual({ p1: 'exclude', p2: 'include', p3: 'rules', ghost: 'rules' })
    const legacy = await db.$queryRaw<Array<{ product_id: string; excluded: boolean }>>`
      SELECT "product_id", "excluded" FROM "gsf_product_data" WHERE "product_id" IN ('p1', 'p2') ORDER BY "product_id"
    `
    expect(legacy).toEqual([{ product_id: 'p1', excluded: true }, { product_id: 'p2', excluded: false }])
  })

  it('undoes feed choices only where they are still as the change left them', async () => {
    const result = await choice.setFeedChoices(
      [{ productId: 'p4', choice: 'exclude' }, { productId: 'p5', choice: 'exclude' }],
      { summary: 'Two out', createdBy: 'Tester' },
    )
    await choice.setFeedChoices([{ productId: 'p5', choice: 'include' }], { summary: 'Changed mind', createdBy: 'Tester' })
    const undone = await changeLog.undoChange(result.changeId!, 'Tester')
    expect(undone).toMatchObject({ status: 'undone', restored: 1, skipped: 1 })
    expect(Object.fromEntries(await choice.getFeedChoices(['p4', 'p5']))).toEqual({ p4: 'rules', p5: 'include' })
  })

  it('does not reset the feed choice when the typed-in fields are saved', async () => {
    await productData.upsertProductData({ productId: 'p1', brand: 'Typed', gtin: null, mpn: null, googleProductCategory: null, condition: null })
    const data = await productData.getProductDataForProducts(['p1', 'p2', 'p9'])
    expect(data.get('p1')).toMatchObject({ brand: 'Typed', feedChoice: 'exclude' })
    expect(data.get('p2')?.feedChoice).toBe('include')
    expect(data.has('p9')).toBe(false)
  })

  // ----- Reads the feed build makes ---------------------------------------------

  it('reads every category each product is filed in, with one array parameter', async () => {
    const ids = Array.from({ length: 3000 }, (_unused, index) => `p${index + 1}`)
    const filed = await facts.readProductCategories(ids)
    expect(filed.get('p1')?.sort()).toEqual(['cat-a', 'cat-b'])
    expect(filed.get('p2')).toEqual(['cat-b'])
    expect(filed.has('p3')).toBe(false)
  })

  it('moves the rules fingerprint when a rule or a feed choice changes, and not otherwise', async () => {
    const first = await tables.readWorkbenchFingerprints()
    expect(await tables.readWorkbenchFingerprints()).toEqual(first)

    const [rule] = await store.listFeedRules()
    await store.updateFeedRule(rule!.id, { ...store.draftOf(rule!), enabled: !rule!.enabled }, 'Tester')
    const afterRule = await tables.readWorkbenchFingerprints()
    expect(afterRule.rules).not.toBe(first.rules)
    expect(afterRule.templates).toBe(first.templates)

    await choice.setFeedChoices([{ productId: 'p6', choice: 'exclude' }], { summary: 'One more', createdBy: null })
    const afterChoice = await tables.readWorkbenchFingerprints()
    expect(afterChoice.rules).not.toBe(afterRule.rules)

    await store.setRangeAttributeId('attr-x', { from: null, to: 'X' }, null)
    expect((await tables.readWorkbenchFingerprints()).rules).not.toBe(afterChoice.rules)
  })

  it('lists feed-rules and products entries apart, newest first', async () => {
    const rules = await changeLog.listChanges({ area: 'feed-rules', limit: 100 })
    const products = await changeLog.listChanges({ area: 'products', limit: 100 })
    expect(rules.length).toBeGreaterThan(5)
    expect(rules.every((entry) => entry.area === 'feed-rules')).toBe(true)
    expect(products.every((entry) => entry.area === 'products' && entry.action !== 'create')).toBe(true)
    expect(products[0]?.summary).toBe('One more')
  })
})
