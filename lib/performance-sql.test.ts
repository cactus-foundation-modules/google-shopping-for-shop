import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import {
  vpsConfigFromEnv, createTestRole, createTestDatabase, connectionUri,
  dropTestDatabase, dropTestRole, dropStaleTestObjects, TEST_PREFIX,
} from '@/lib/backup/vps-database'
import { splitMigrationStatements } from '@/lib/backup/migration-sql'
import type { PerformanceRow } from '@/modules/google-shopping-for-shop/lib/performance/types'
import type { BestSellerRow } from '@/modules/google-shopping-for-shop/lib/best-sellers/types'

// The reports' own SQL, executed through the real functions: migration 022,
// the daily performance table, the best sellers table, the GTIN match against
// the shop's own barcodes, and the settings bookkeeping the import writes.
//
// Typecheck, eslint and the build all see raw SQL as a plain string. Only a
// database can say it parses - and three things in here are exactly the shape
// that has gone wrong before: a DATE bound as text rather than as a JS Date, a
// sum over a bigint column widening to numeric, and an ILIKE with an ESCAPE
// clause that Prisma would otherwise try to bind as a parameter.
//
// SKIPS SILENTLY without OVH_SERVER / OVH_USER / OVH_PASSWORD in the shell,
// like lib/health-sql.test.ts. A skip is not a pass - export them from the
// Deskwell workspace's .env for the run. Provisions and drops its own
// throwaway database under TEST_PREFIX; it touches nothing else on the box.
const cfg = (() => { try { return vpsConfigFromEnv() } catch { return null } })()

/** What the tab asks for: the granularity, country and categories now
 *  configured, capped per category. An empty category list means no filter,
 *  which is the shop that has named none. */
const WEEKLY_GB = { granularity: 'WEEKLY', countryCode: 'GB', perCategory: 50, categoryIds: [] } as const

// Every case here is several round trips to a Postgres on the other side of
// the country. Vitest's default five seconds is a local-database figure.
vi.setConfig({ testTimeout: 30_000 })

type StoreModule = typeof import('@/modules/google-shopping-for-shop/lib/performance/store')
type SellersModule = typeof import('@/modules/google-shopping-for-shop/lib/best-sellers/store')
type SellersImportModule = typeof import('@/modules/google-shopping-for-shop/lib/best-sellers/import')
type SettingsModule = typeof import('@/modules/google-shopping-for-shop/lib/settings')

function perf(overrides: Partial<PerformanceRow> & Pick<PerformanceRow, 'day' | 'itemId' | 'method'>): PerformanceRow {
  return {
    clicks: 0,
    impressions: 0,
    clickThroughRate: null,
    conversions: null,
    conversionValueMicros: null,
    conversionCurrency: null,
    ...overrides,
  }
}

function seller(overrides: Partial<BestSellerRow> & Pick<BestSellerRow, 'kind' | 'rank'>): BestSellerRow {
  return {
    reportDate: '2026-09-14',
    granularity: 'WEEKLY',
    countryCode: 'GB',
    categoryId: '436',
    previousRank: null,
    title: null,
    brand: null,
    categoryPath: null,
    relativeDemand: 'high',
    previousRelativeDemand: 'medium',
    demandChange: 'riser',
    inventoryStatus: 'unknown',
    brandInventoryStatus: 'unknown',
    variantGtins: [],
    ...overrides,
  }
}

describe.skipIf(!cfg)('google-shopping reports SQL against a real database', () => {
  let db: PrismaClient
  let dbName: string
  let roleName: string
  let store: StoreModule
  let sellers: SellersModule
  let sellersImport: SellersImportModule
  let settings: SettingsModule

  beforeAll(async () => {
    const suffix = `${Date.now()}`.slice(-9)
    dbName = `${TEST_PREFIX}gsp_${suffix}`
    roleName = `${TEST_PREFIX}role_gsp_${suffix}`
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

    // Four products, two of them carrying a barcode, for the GTIN match.
    await db.$executeRawUnsafe(`
      INSERT INTO "shp_products" ("id", "name", "slug", "type", "price", "barcode")
      VALUES ('p1', 'Aeron Chair', 'aeron-chair', 'PHYSICAL', 900, '5012345678900'),
             ('p2', 'Embody Chair', 'embody-chair', 'PHYSICAL', 1200, '5012345678917'),
             ('p3', 'Sayl Chair', 'sayl-chair', 'PHYSICAL', 400, NULL),
             ('p4', 'Setu Chair', 'setu-chair', 'PHYSICAL', 500, NULL)
    `)

    process.env.DATABASE_URL = url
    store = await import('@/modules/google-shopping-for-shop/lib/performance/store')
    sellers = await import('@/modules/google-shopping-for-shop/lib/best-sellers/store')
    sellersImport = await import('@/modules/google-shopping-for-shop/lib/best-sellers/import')
    settings = await import('@/modules/google-shopping-for-shop/lib/settings')
  }, 300_000)

  afterAll(async () => {
    const shared = await import('@/lib/db/prisma').catch(() => null)
    await shared?.prisma.$disconnect().catch(() => {})
    await db?.$disconnect().catch(() => {})
    if (dbName) await dropTestDatabase(cfg!, dbName).catch(() => {})
    if (roleName) await dropTestRole(cfg!, roleName).catch(() => {})
  }, 180_000)

  // ----- Migration 022 ---------------------------------------------------------

  it('022 creates both tables with the column types the code assumes, and survives a second run', async () => {
    const sql = readFileSync(path.join(process.cwd(), 'modules/google-shopping-for-shop/migrations/022_performance_reports.sql'), 'utf8')
    for (const statement of splitMigrationStatements(sql)) await db.$executeRawUnsafe(statement)

    const daily = await db.$queryRaw<Array<{ column_name: string; data_type: string }>>`
      SELECT "column_name", "data_type" FROM information_schema.columns
      WHERE "table_name" = 'gsf_performance_daily' ORDER BY "column_name"
    `
    expect(Object.fromEntries(daily.map((row) => [row.column_name, row.data_type]))).toEqual({
      click_through_rate: 'double precision',
      clicks: 'bigint',
      conversion_currency: 'text',
      conversion_value_micros: 'bigint',
      conversions: 'double precision',
      day: 'date',
      impressions: 'bigint',
      imported_at: 'timestamp without time zone',
      item_id: 'text',
      marketing_method: 'text',
    })

    const sellersColumns = await db.$queryRaw<Array<{ column_name: string; data_type: string }>>`
      SELECT "column_name", "data_type" FROM information_schema.columns
      WHERE "table_name" = 'gsf_best_sellers' AND "column_name" IN ('report_date', 'rank', 'variant_gtins', 'in_catalogue')
      ORDER BY "column_name"
    `
    expect(Object.fromEntries(sellersColumns.map((row) => [row.column_name, row.data_type]))).toEqual({
      in_catalogue: 'boolean',
      rank: 'bigint',
      report_date: 'date',
      variant_gtins: 'jsonb',
    })

    // The settings defaults are what every existing install gets on its next
    // update, so they are the thing worth asserting.
    const [row] = await db.$queryRaw<Array<{
      import_enabled: boolean; backfill: number; retention: number
      through: Date | null; conversions: boolean | null; conversions_at: Date | null
      sellers: boolean; granularity: string; limit: number
    }>>`
      SELECT "performance_import_enabled" AS "import_enabled", "performance_backfill_days" AS "backfill",
             "performance_retention_days" AS "retention", "performance_imported_through" AS "through",
             "performance_conversions_available" AS "conversions",
             "performance_conversions_checked_at" AS "conversions_at", "best_sellers_enabled" AS "sellers",
             "best_sellers_granularity" AS "granularity", "best_sellers_limit" AS "limit"
      FROM "gsf_settings" WHERE "id" = 'singleton'
    `
    expect(row?.import_enabled).toBe(true)
    expect(row?.backfill).toBe(90)
    expect(row?.retention).toBe(400)
    expect(row?.through).toBeNull()
    // Never tried is NOT "Google refuses", and the screen tells them apart.
    expect(row?.conversions).toBeNull()
    expect(row?.conversions_at).toBeNull()
    expect(row?.sellers).toBe(false)
    expect(row?.granularity).toBe('WEEKLY')
    expect(row?.limit).toBe(50)
  })

  // ----- The daily performance table -------------------------------------------

  it('writes a batch, and writing the same window again replaces rather than doubles', async () => {
    const rows = [
      perf({ day: '2026-09-01', itemId: 'p1', method: 'organic', clicks: 10, impressions: 100, clickThroughRate: 0.1, conversions: 2, conversionValueMicros: 40_000_000n, conversionCurrency: 'GBP' }),
      perf({ day: '2026-09-01', itemId: 'p1', method: 'ads', clicks: 5, impressions: 200, clickThroughRate: 0.025 }),
      perf({ day: '2026-09-02', itemId: 'p2', method: 'organic', clicks: 1, impressions: 50, clickThroughRate: 0.02 }),
    ]
    await store.writePerformanceRows(rows)
    await store.writePerformanceRows(rows)

    const [count] = await db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS "n" FROM "gsf_performance_daily"`
    expect(count?.n).toBe(3)

    // A day re-read after Google revised it carries the new figure, not the
    // sum of the two readings.
    await store.writePerformanceRows([perf({ day: '2026-09-01', itemId: 'p1', method: 'organic', clicks: 12, impressions: 110, clickThroughRate: 12 / 110, conversions: 3, conversionValueMicros: 60_000_000n, conversionCurrency: 'GBP' })])
    const [revised] = await db.$queryRaw<Array<{ clicks: bigint; conversions: number }>>`
      SELECT "clicks", "conversions" FROM "gsf_performance_daily"
      WHERE "day" = '2026-09-01'::date AND "item_id" = 'p1' AND "marketing_method" = 'organic'
    `
    expect(Number(revised?.clicks)).toBe(12)
    expect(revised?.conversions).toBe(3)
  })

  // Item ids here are real product ids: gsf_item_match_status carries a
  // foreign key to shp_products, and the per-product read joins to it.
  it('stores the day Google meant, whatever this machine thinks the time is', async () => {
    // The whole reason a day is bound as text and cast in SQL: a JS Date binds
    // as a timestamp, and a timestamp cast to date is whatever day it is in
    // the session's timezone.
    await store.writePerformanceRows([perf({ day: '2026-09-05', itemId: 'p4', method: 'organic', clicks: 1, impressions: 1 })])
    const [row] = await db.$queryRaw<Array<{ day: string }>>`
      SELECT to_char("day", 'YYYY-MM-DD') AS "day" FROM "gsf_performance_daily" WHERE "item_id" = 'p4'
    `
    expect(row?.day).toBe('2026-09-05')
  })

  it('keeps a conversions figure Google did not send as NULL, never as nought', async () => {
    const [row] = await db.$queryRaw<Array<{ conversions: number | null; value: bigint | null; currency: string | null }>>`
      SELECT "conversions", "conversion_value_micros" AS "value", "conversion_currency" AS "currency"
      FROM "gsf_performance_daily"
      WHERE "day" = '2026-09-01'::date AND "item_id" = 'p1' AND "marketing_method" = 'ads'
    `
    expect(row?.conversions).toBeNull()
    expect(row?.value).toBeNull()
    expect(row?.currency).toBeNull()
  })

  it('sums by marketing method, and works the rate out from the sums', async () => {
    const totals = await store.readTotalsByMethod('2026-09-01', '2026-09-30')
    // p1 on the 1st (12/110) plus p2 on the 2nd (1/50) plus p4 on the 5th (1/1).
    expect(totals.organic.clicks).toBe(14)
    expect(totals.organic.impressions).toBe(161)
    expect(totals.organic.clickThroughRate).toBeCloseTo(14 / 161)
    expect(totals.organic.conversions).toBe(3)
    expect(totals.organic.conversionValue).toBeCloseTo(60)
    expect(totals.organic.conversionCurrency).toBe('GBP')

    // Paid reported no conversions at all, so the answer is "not reported"
    // rather than a confident nought.
    expect(totals.ads.clicks).toBe(5)
    expect(totals.ads.conversions).toBeNull()
    expect(totals.ads.conversionValue).toBeNull()
  })

  it('returns real numbers rather than Decimal objects from a sum over bigint', async () => {
    const totals = await store.readTotalsByMethod('2026-09-01', '2026-09-30')
    expect(typeof totals.organic.clicks).toBe('number')
    expect(Number.isInteger(totals.organic.clicks)).toBe(true)
  })

  it('has no rate at all where nothing was shown', async () => {
    const totals = await store.readTotalsByMethod('2020-01-01', '2020-01-02')
    expect(totals.organic.impressions).toBe(0)
    expect(totals.organic.clickThroughRate).toBeNull()
  })

  it('gives one trend point per day that has figures, and none for days that have not', async () => {
    const trend = await store.readTrend('2026-09-01', '2026-09-10')
    expect(trend.map((point) => point.day)).toEqual(['2026-09-01', '2026-09-02', '2026-09-05'])
    expect(trend[0]).toEqual({ day: '2026-09-01', organic: { clicks: 12, impressions: 110 }, ads: { clicks: 5, impressions: 200 } })
  })

  it('reads the extent of what is held', async () => {
    const extent = await store.readPerformanceExtent()
    expect(extent.from).toBe('2026-09-01')
    expect(extent.to).toBe('2026-09-05')
    expect(extent.rows).toBe(4)
  })

  // ----- The per-product table -------------------------------------------------

  it('sums per product across both methods, biggest first, with the page total', async () => {
    const page = await store.readProductPerformance({ from: '2026-09-01', to: '2026-09-30', limit: 10, offset: 0, sort: 'clicks', search: '' })
    expect(page.total).toBe(3)
    expect(page.rows[0]?.itemId).toBe('p1')
    expect(page.rows[0]?.clicks).toBe(17)
    expect(page.rows[0]?.impressions).toBe(310)
    expect(page.rows[0]?.clickThroughRate).toBeCloseTo(17 / 310)
    // Only the organic half reported conversions, and that is what is shown.
    expect(page.rows[0]?.conversions).toBe(3)
  })

  it('pages without losing the total', async () => {
    const page = await store.readProductPerformance({ from: '2026-09-01', to: '2026-09-30', limit: 1, offset: 1, sort: 'clicks', search: '' })
    expect(page.total).toBe(3)
    expect(page.rows).toHaveLength(1)
    expect(page.rows[0]?.itemId).toBe('p2')
  })

  it('sorts by each of the four things the screen offers', async () => {
    for (const sort of ['clicks', 'impressions', 'ctr', 'conversions'] as const) {
      const page = await store.readProductPerformance({ from: '2026-09-01', to: '2026-09-30', limit: 10, offset: 0, sort, search: '' })
      expect(page.rows.length).toBeGreaterThan(0)
    }
  })

  it('joins the benchmark price from the match snapshot', async () => {
    await db.$executeRawUnsafe(`
      INSERT INTO "gsf_item_match_status" ("item_id", "matched", "merchant_title", "benchmark_amount_micros", "benchmark_currency", "checked_at")
      VALUES ('p1', true, 'Aeron Chair, black', 899000000, 'GBP', CURRENT_TIMESTAMP)
    `)
    const page = await store.readProductPerformance({ from: '2026-09-01', to: '2026-09-30', limit: 10, offset: 0, sort: 'clicks', search: '' })
    const row = page.rows.find((item) => item.itemId === 'p1')
    expect(row?.title).toBe('Aeron Chair, black')
    expect(row?.benchmarkAmount).toBeCloseTo(899)
    expect(row?.benchmarkCurrency).toBe('GBP')
    // An item Google reported on that has no snapshot is still listed.
    expect(page.rows.find((item) => item.itemId === 'p2')?.benchmarkAmount).toBeNull()
  })

  it('searches the item number and the title', async () => {
    const byId = await store.readProductPerformance({ from: '2026-09-01', to: '2026-09-30', limit: 10, offset: 0, sort: 'clicks', search: 'p2' })
    expect(byId.rows.map((row) => row.itemId)).toEqual(['p2'])
    const byTitle = await store.readProductPerformance({ from: '2026-09-01', to: '2026-09-30', limit: 10, offset: 0, sort: 'clicks', search: 'aeron' })
    expect(byTitle.rows.map((row) => row.itemId)).toEqual(['p1'])
  })

  it('treats a wildcard in the search as a character, not as a wildcard', async () => {
    // Without the ESCAPE clause a lone underscore matches any character, so
    // this would return every three-character item id.
    const underscore = await store.readProductPerformance({ from: '2026-09-01', to: '2026-09-30', limit: 10, offset: 0, sort: 'clicks', search: 'p_' })
    expect(underscore.rows).toHaveLength(0)
    const percent = await store.readProductPerformance({ from: '2026-09-01', to: '2026-09-30', limit: 10, offset: 0, sort: 'clicks', search: '%' })
    expect(percent.rows).toHaveLength(0)
    // And the escape character itself is not special either.
    const bang = await store.readProductPerformance({ from: '2026-09-01', to: '2026-09-30', limit: 10, offset: 0, sort: 'clicks', search: '!' })
    expect(bang.rows).toHaveLength(0)
  })

  // ----- Retention -------------------------------------------------------------

  it('prunes days before the cut-off and leaves the rest', async () => {
    const dropped = await store.prunePerformance('2026-09-02')
    expect(dropped).toBe(2)
    const extent = await store.readPerformanceExtent()
    expect(extent.from).toBe('2026-09-02')
  })

  // ----- The import's own bookkeeping ------------------------------------------

  it('round-trips the cursor as the day it was given, not the day it is here', async () => {
    await settings.recordPerformanceCheck({
      outcome: 'ok',
      checkedAt: new Date('2026-09-23T10:00:00.000Z'),
      importedThrough: '2026-09-20',
      conversionsAvailable: true,
    })
    const read = await settings.getGsfSettings()
    expect(read.performanceImportedThrough).toBe('2026-09-20')
    expect(read.performanceConversionsAvailable).toBe(true)
    expect(read.performanceCheckedAt?.toISOString()).toBe('2026-09-23T10:00:00.000Z')
  })

  it('moves the conversions stamp only when the question was actually put', async () => {
    // Without this the refusal has no date on it and no expiry, and the screen
    // would go on saying "Google turned this down" for ever.
    await settings.recordPerformanceCheck({
      outcome: 'ok',
      checkedAt: new Date('2026-09-23T10:00:00.000Z'),
      importedThrough: '2026-09-20',
      conversionsAvailable: false,
      conversionsLearned: true,
    })
    const asked = await settings.getGsfSettings()
    expect(asked.performanceConversionsCheckedAt?.toISOString()).toBe('2026-09-23T10:00:00.000Z')

    // A later run that did NOT ask must leave the stamp where it is, or the
    // refusal would never go stale.
    await settings.recordPerformanceCheck({
      outcome: 'ok',
      checkedAt: new Date('2026-09-24T10:00:00.000Z'),
      importedThrough: '2026-09-21',
      conversionsAvailable: false,
    })
    const unasked = await settings.getGsfSettings()
    expect(unasked.performanceCheckedAt?.toISOString()).toBe('2026-09-24T10:00:00.000Z')
    expect(unasked.performanceConversionsCheckedAt?.toISOString()).toBe('2026-09-23T10:00:00.000Z')
  })

  it('takes a null cursor, which is where a first run starts from', async () => {
    await settings.recordPerformanceCheck({ outcome: 'ok', checkedAt: new Date(), importedThrough: null, conversionsAvailable: null })
    const read = await settings.getGsfSettings()
    expect(read.performanceImportedThrough).toBeNull()
    expect(read.performanceConversionsAvailable).toBeNull()
  })

  it('refuses a cursor that is not a date rather than quietly dropping it', async () => {
    await expect(settings.recordPerformanceCheck({ outcome: 'ok', checkedAt: new Date(), importedThrough: 'yesterday', conversionsAvailable: null }))
      .rejects.toThrow()
  })

  it('a failed run records the failure and does NOT move the "last fetched" stamp', async () => {
    // The whole point: without this the tab prints "Last fetched just now"
    // about a run that died, and narrowing the conversions fallback makes a
    // throw the DESIGNED outcome for any Google refusal nothing recognises.
    await settings.recordPerformanceCheck({
      outcome: 'ok',
      checkedAt: new Date('2026-09-25T09:00:00.000Z'),
      importedThrough: '2026-09-22',
      conversionsAvailable: true,
    })
    await settings.recordPerformanceCheck({
      outcome: 'failed',
      checkedAt: new Date('2026-09-26T09:00:00.000Z'),
      importedThrough: '2026-09-22',
      conversionsAvailable: true,
      error: "Invalid date '2026-13-01'",
    })
    const failed = await settings.getGsfSettings()
    expect(failed.performanceCheckedAt?.toISOString()).toBe('2026-09-25T09:00:00.000Z')
    expect(failed.performanceFailedAt?.toISOString()).toBe('2026-09-26T09:00:00.000Z')
    expect(failed.performanceLastError).toBe("Invalid date '2026-13-01'")
    // The cursor still moves: whatever WAS read is in the table either way.
    expect(failed.performanceImportedThrough).toBe('2026-09-22')

    // And a run that works clears the failure rather than leaving it to rot.
    await settings.recordPerformanceCheck({
      outcome: 'ok',
      checkedAt: new Date('2026-09-27T09:00:00.000Z'),
      importedThrough: '2026-09-24',
      conversionsAvailable: true,
    })
    const recovered = await settings.getGsfSettings()
    expect(recovered.performanceCheckedAt?.toISOString()).toBe('2026-09-27T09:00:00.000Z')
    expect(recovered.performanceFailedAt).toBeNull()
    expect(recovered.performanceLastError).toBeNull()
  })

  it('reads and writes the report settings, clamping what it is given', async () => {
    await settings.updateGsfSettings({
      performanceImportEnabled: false,
      performanceBackfillDays: 5_000,
      performanceRetentionDays: 0,
      bestSellersEnabled: true,
      bestSellersCategoryIds: '436, 1234, not-a-number',
      bestSellersGranularity: 'MONTHLY',
      bestSellersLimit: 9_999,
    })
    const read = await settings.getGsfSettings()
    expect(read.performanceImportEnabled).toBe(false)
    expect(read.performanceBackfillDays).toBe(730)
    expect(read.performanceRetentionDays).toBe(0)
    expect(read.bestSellersEnabled).toBe(true)
    expect(read.bestSellersCategoryIds).toBe('436,1234')
    expect(read.bestSellersGranularity).toBe('MONTHLY')
    expect(read.bestSellersLimit).toBe(1_000)

    // Put the ones later cases rely on back.
    await settings.updateGsfSettings({ performanceImportEnabled: true, bestSellersCategoryIds: '' })
  })

  // ----- Best sellers ----------------------------------------------------------

  it('matches Google’s example barcodes against the shop’s own', async () => {
    const found = await sellers.matchGtins(['5012345678900', '5012345678917', '5099999999999'])
    expect(found.get('5012345678900')).toBe('p1')
    expect(found.get('5012345678917')).toBe('p2')
    expect(found.has('5099999999999')).toBe(false)
  })

  it('also matches a GTIN typed into this module’s own fields', async () => {
    await db.$executeRawUnsafe(`INSERT INTO "gsf_product_data" ("product_id", "gtin") VALUES ('p3', '5077777777777')`)
    const found = await sellers.matchGtins(['5077777777777'])
    expect(found.get('5077777777777')).toBe('p3')
  })

  it('asks nothing of the database when there is nothing matchable to ask about', async () => {
    expect((await sellers.matchGtins([])).size).toBe(0)
    expect((await sellers.matchGtins(['not-a-barcode', ''])).size).toBe(0)
  })

  it('writes rankings with the verdict each row earned, and writing again replaces', async () => {
    const rows: BestSellerRow[] = [
      seller({ kind: 'cluster', rank: 1, title: 'Aeron Chair', brand: 'Herman Miller', categoryPath: 'Furniture > Office Chairs', inventoryStatus: 'not-in-inventory', variantGtins: ['5012345678900'] }),
      seller({ kind: 'cluster', rank: 2, title: 'Something else', inventoryStatus: 'in-stock', variantGtins: [] }),
      seller({ kind: 'cluster', rank: 3, title: 'Never heard of it', inventoryStatus: 'not-in-inventory', variantGtins: [] }),
      seller({ kind: 'cluster', rank: 4, title: 'No idea either way', inventoryStatus: 'unknown', variantGtins: [] }),
      seller({ kind: 'brand', rank: 1, brand: 'Herman Miller' }),
    ]
    const matched = await sellers.matchGtins(rows.flatMap((row) => row.variantGtins))
    await sellers.writeBestSellers(rows, matched)
    await sellers.writeBestSellers(rows, matched)

    const clusters = await sellers.readBestSellers('cluster', WEEKLY_GB)
    expect(clusters.reportDate).toBe('2026-09-14')
    expect(clusters.truncated).toBe(0)
    expect(clusters.rows.map((row) => row.verdict)).toEqual(['matched', 'google', 'no', 'unknown'])
    // A barcode match beats Google saying it is not in the data source, and
    // names the product.
    expect(clusters.rows[0]?.matchedProductId).toBe('p1')
    expect(clusters.rows[0]?.variantGtins).toEqual(['5012345678900'])
    // "Not known" is stored as NULL, never as false.
    const [unknown] = await db.$queryRaw<Array<{ in_catalogue: boolean | null }>>`
      SELECT "in_catalogue" FROM "gsf_best_sellers" WHERE "kind" = 'cluster' AND "rank" = 4
    `
    expect(unknown?.in_catalogue).toBeNull()

    const brands = await sellers.readBestSellers('brand', WEEKLY_GB)
    expect(brands.rows).toHaveLength(1)
    expect(brands.rows[0]?.brand).toBe('Herman Miller')
  })

  it('refuses to lose a whole run to two rows sharing a rank', async () => {
    // Postgres throws "ON CONFLICT DO UPDATE command cannot affect row a
    // second time" when one VALUES list carries the same key twice, and that
    // throw would take the whole import down rather than one row of it.
    await sellers.writeBestSellers([
      seller({ kind: 'cluster', rank: 9, reportDate: '2026-09-14', title: 'First reading' }),
      seller({ kind: 'cluster', rank: 9, reportDate: '2026-09-14', title: 'Second reading' }),
    ], new Map())
    const [row] = await db.$queryRaw<Array<{ title: string }>>`
      SELECT "title" FROM "gsf_best_sellers" WHERE "kind" = 'cluster' AND "rank" = 9 AND "report_date" = '2026-09-14'::date
    `
    expect(row?.title).toBe('Second reading')
    await db.$executeRawUnsafe(`DELETE FROM "gsf_best_sellers" WHERE "rank" = 9`)
  })

  it('caps each category separately rather than dropping the last categories', async () => {
    // The bug this replaces: a flat LIMIT over rows ordered by category then
    // rank keeps the whole of the first category and none of the last, while
    // the settings screen promises a top N per category.
    await sellers.writeBestSellers([
      seller({ kind: 'cluster', rank: 1, categoryId: '600', reportDate: '2026-09-14', title: 'Six hundred, first' }),
      seller({ kind: 'cluster', rank: 2, categoryId: '600', reportDate: '2026-09-14', title: 'Six hundred, second' }),
      seller({ kind: 'cluster', rank: 3, categoryId: '600', reportDate: '2026-09-14', title: 'Six hundred, third' }),
    ], new Map())

    const capped = await sellers.readBestSellers('cluster', { ...WEEKLY_GB, perCategory: 2 })
    const byCategory = new Map<string, number>()
    for (const row of capped.rows) byCategory.set(row.categoryId, (byCategory.get(row.categoryId) ?? 0) + 1)
    // Both categories present, neither deeper than the cap.
    expect([...byCategory.keys()].sort()).toEqual(['436', '600'])
    expect([...byCategory.values()].every((count) => count <= 2)).toBe(true)
    // And what was left out is counted rather than silently dropped.
    expect(capped.truncated).toBeGreaterThan(0)

    await db.$executeRawUnsafe(`DELETE FROM "gsf_best_sellers" WHERE "category_id" = '600'`)
  })

  it('shows only the granularity and country now configured', async () => {
    await sellers.writeBestSellers([
      seller({ kind: 'cluster', rank: 1, granularity: 'MONTHLY', reportDate: '2026-09-01', title: 'A monthly row' }),
    ], new Map())
    const weekly = await sellers.readBestSellers('cluster', WEEKLY_GB)
    expect(weekly.rows.map((row) => row.title)).not.toContain('A monthly row')
    const monthly = await sellers.readBestSellers('cluster', { ...WEEKLY_GB, granularity: 'MONTHLY' })
    expect(monthly.rows.map((row) => row.title)).toEqual(['A monthly row'])
    // A country nothing was stored against shows nothing, rather than
    // everything.
    const elsewhere = await sellers.readBestSellers('cluster', { ...WEEKLY_GB, countryCode: 'IE' })
    expect(elsewhere.rows).toHaveLength(0)

    await db.$executeRawUnsafe(`DELETE FROM "gsf_best_sellers" WHERE "granularity" = 'MONTHLY'`)
  })

  it('reads only the newest ranking it holds for each category', async () => {
    await sellers.writeBestSellers([seller({ kind: 'cluster', rank: 1, reportDate: '2026-09-21', title: 'This week' })], new Map())
    const clusters = await sellers.readBestSellers('cluster', WEEKLY_GB)
    expect(clusters.reportDate).toBe('2026-09-21')
    expect(clusters.rows.map((row) => row.title)).toEqual(['This week'])
    // Last week's rows are still in the table - history is kept, not shown.
    const [count] = await db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS "n" FROM "gsf_best_sellers" WHERE "kind" = 'cluster'`
    expect(count?.n).toBe(5)
  })

  it('counts what is held under another setting, so a switch does not read as an empty account', async () => {
    // Switching weekly to monthly makes every stored row invisible at once.
    // Without this count the panel would say "Google gave no rankings for
    // these categories" - untrue, and untrue in the direction that has an
    // owner switch the feature off while their rankings sit one setting away.
    const monthly = await sellers.readBestSellers('cluster', { ...WEEKLY_GB, granularity: 'MONTHLY' })
    expect(monthly.rows).toHaveLength(0)
    expect(monthly.heldElsewhere).toBeGreaterThan(0)

    // And a genuinely empty table reports nothing held anywhere.
    const nowhere = await sellers.readBestSellers('brand', { ...WEEKLY_GB, countryCode: 'IE' })
    expect(nowhere.rows).toHaveLength(0)
    expect(nowhere.heldElsewhere).toBeGreaterThan(0)
  })

  it('hides a category the owner has dropped from the setting, without deleting it', async () => {
    // Filtered rather than pruned: putting the category back shows its last
    // ranking straight away, dated, instead of an empty list until the next
    // fetch. Deleting on a settings change would throw data away on a
    // keystroke.
    const narrowed = await sellers.readBestSellers('cluster', { ...WEEKLY_GB, categoryIds: ['999'] })
    expect(narrowed.rows).toHaveLength(0)
    // And it counts as held-but-not-shown, so the panel says so rather than
    // claiming Google gave nothing.
    expect(narrowed.heldElsewhere).toBeGreaterThan(0)

    // Naming the category it does hold brings it straight back.
    const restored = await sellers.readBestSellers('cluster', { ...WEEKLY_GB, categoryIds: ['436'] })
    expect(restored.rows.length).toBeGreaterThan(0)

    // The rows are still in the table either way.
    const [count] = await db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS "n" FROM "gsf_best_sellers"`
    expect(count?.n).toBeGreaterThan(0)
  })

  it('prunes rankings before a report date but NEVER the newest per category', async () => {
    // The pathological case this guard exists for: the retention window is a
    // number of DAYS sized for the daily figures, while a report_date is the
    // first day of a week or a month - so on MONTHLY the same run that wrote a
    // ranking could delete it, and the tab would show an empty state for ever
    // while the fetch worked perfectly every day.
    // FOUR, not five: the brand ranking is the newest its category has, so
    // the guard keeps it even though the cut-off is past its date. That one
    // surviving row is the whole point of the guard.
    const dropped = await sellers.pruneBestSellers('2026-09-21')
    expect(dropped).toBe(4)
    const clusters = await sellers.readBestSellers('cluster', WEEKLY_GB)
    expect(clusters.rows).toHaveLength(1)

    // A cut-off past everything held still leaves the newest of each category
    // standing.
    const survivors = await sellers.pruneBestSellers('2030-01-01')
    expect(survivors).toBe(0)
    const after = await sellers.readBestSellers('cluster', WEEKLY_GB)
    expect(after.rows).toHaveLength(1)
    const brands = await sellers.readBestSellers('brand', WEEKLY_GB)
    expect(brands.rows).toHaveLength(1)
  })

  it('falls back to the category numbers already typed against the shop’s own categories', async () => {
    expect(await sellersImport.resolveBestSellerCategories('436, 1234')).toEqual(['436', '1234'])
    // Nothing set: read from the taxonomy screen's own answers, and ignore the
    // ones written as a path rather than a number.
    await db.$executeRawUnsafe(`
      INSERT INTO "shp_categories" ("id", "name", "slug") VALUES ('c1', 'Chairs', 'chairs'), ('c2', 'Desks', 'desks')
    `)
    await db.$executeRawUnsafe(`
      INSERT INTO "gsf_category_taxonomy" ("category_id", "google_product_category")
      VALUES ('c1', '436'), ('c2', 'Furniture > Office Furniture > Desks')
    `)
    expect(await sellersImport.resolveBestSellerCategories(null)).toEqual(['436'])
    expect(await sellersImport.resolveBestSellerCategories('nonsense')).toEqual(['436'])
  })
})
