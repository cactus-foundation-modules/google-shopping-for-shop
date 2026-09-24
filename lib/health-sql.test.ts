import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import {
  vpsConfigFromEnv, createTestRole, createTestDatabase, connectionUri,
  dropTestDatabase, dropTestRole, dropStaleTestObjects, TEST_PREFIX,
} from '@/lib/backup/vps-database'
import { splitMigrationStatements } from '@/lib/backup/migration-sql'
import type { ParsedItemIssue } from '@/modules/google-shopping-for-shop/lib/health/parse'

// Health's own SQL, executed through the real functions: migration 018, the
// item-issue ledger (open, close, reopen), every read the Health tab makes,
// the feed fetch row with its bigints and jsonb, and the settings columns the
// alerts hang off. Typecheck, eslint and the build all see raw SQL as a plain
// string; only a database can say it parses and does what it claims.
//
// SKIPS SILENTLY without OVH_SERVER / OVH_USER / OVH_PASSWORD in the shell,
// like lib/feed-rules-sql.test.ts. A skip is not a pass - export them from the
// Deskwell workspace's .env for the run. Provisions and drops its own
// throwaway database under TEST_PREFIX; it touches nothing else on the box.
const cfg = (() => { try { return vpsConfigFromEnv() } catch { return null } })()

// Every case here is several round trips to a Postgres on the other side of
// the country. Vitest's default five seconds is a local-database figure.
vi.setConfig({ testTimeout: 30_000 })

type IssuesModule = typeof import('@/modules/google-shopping-for-shop/lib/health/item-issues')
type FetchModule = typeof import('@/modules/google-shopping-for-shop/lib/health/feed-fetch')
type SettingsModule = typeof import('@/modules/google-shopping-for-shop/lib/settings')
type TablesModule = typeof import('@/modules/google-shopping-for-shop/lib/workbench-tables')
type AlertsModule = typeof import('@/modules/google-shopping-for-shop/lib/health/alerts')
type ExplainModule = typeof import('@/modules/google-shopping-for-shop/lib/health/explain')

const at = (iso: string) => new Date(iso)

function issue(code: string, overrides: Partial<ParsedItemIssue> = {}): ParsedItemIssue {
  return {
    code,
    attribute: '',
    severity: 'disapproved',
    resolution: 'merchant_action',
    contexts: [{ context: 'SHOPPING_ADS', disapprovedCountries: ['GB'], demotedCountries: [] }],
    ...overrides,
  }
}

describe.skipIf(!cfg)('google-shopping health SQL against a real database', () => {
  let db: PrismaClient
  let dbName: string
  let roleName: string
  let issues: IssuesModule
  let feed: FetchModule
  let settings: SettingsModule
  let tables: TablesModule
  let alerts: AlertsModule
  let explain: ExplainModule

  beforeAll(async () => {
    const suffix = `${Date.now()}`.slice(-9)
    dbName = `${TEST_PREFIX}gsh_${suffix}`
    roleName = `${TEST_PREFIX}role_gsh_${suffix}`
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

    // gsf_item_match_status carries a foreign key to the shop's products, so
    // the four items these cases talk about have to be real ones.
    await db.$executeRaw`
      INSERT INTO "shp_products" ("id", "name", "slug", "type", "price")
      SELECT 'v' || g, 'Product ' || g, 'product-' || g, 'PHYSICAL', 10
      FROM generate_series(1, 4::int) AS g
    `

    process.env.DATABASE_URL = url
    issues = await import('@/modules/google-shopping-for-shop/lib/health/item-issues')
    feed = await import('@/modules/google-shopping-for-shop/lib/health/feed-fetch')
    settings = await import('@/modules/google-shopping-for-shop/lib/settings')
    tables = await import('@/modules/google-shopping-for-shop/lib/workbench-tables')
    alerts = await import('@/modules/google-shopping-for-shop/lib/health/alerts')
    explain = await import('@/modules/google-shopping-for-shop/lib/health/explain')
  }, 300_000)

  afterAll(async () => {
    const shared = await import('@/lib/db/prisma').catch(() => null)
    await shared?.prisma.$disconnect().catch(() => {})
    await db?.$disconnect().catch(() => {})
    if (dbName) await dropTestDatabase(cfg!, dbName).catch(() => {})
    if (roleName) await dropTestRole(cfg!, roleName).catch(() => {})
  }, 180_000)

  // ----- Migration 018 ---------------------------------------------------------

  it('018 adds both tables and every settings column, and survives a second run', async () => {
    const sql = readFileSync(path.join(process.cwd(), 'modules/google-shopping-for-shop/migrations/018_health_and_alerts.sql'), 'utf8')
    for (const statement of splitMigrationStatements(sql)) await db.$executeRawUnsafe(statement)

    const columns = await db.$queryRaw<Array<{ column_name: string }>>`
      SELECT "column_name" FROM information_schema.columns
      WHERE "table_name" = 'gsf_settings'
        AND "column_name" IN ('feed_data_source_id', 'feed_data_source_detected_id', 'disapproval_alert_threshold',
                              'alert_email_enabled', 'alert_email', 'issues_checked_at', 'last_disapproved_count')
      ORDER BY "column_name"
    `
    expect(columns.map((row) => row.column_name)).toEqual([
      'alert_email', 'alert_email_enabled', 'disapproval_alert_threshold', 'feed_data_source_detected_id',
      'feed_data_source_id', 'issues_checked_at', 'last_disapproved_count',
    ])
    const status = await db.$queryRaw<Array<{ column_name: string }>>`
      SELECT "column_name" FROM information_schema.columns
      WHERE "table_name" = 'gsf_item_match_status' AND "column_name" = 'reporting_status'
    `
    expect(status).toHaveLength(1)

    // The default matters: it is what every existing install gets on update.
    const [row] = await db.$queryRaw<Array<{ threshold: number; email: boolean }>>`
      SELECT "disapproval_alert_threshold"::int AS "threshold", "alert_email_enabled" AS "email"
      FROM "gsf_settings" WHERE "id" = 'singleton'
    `
    expect(row?.threshold).toBe(25)
    expect(row?.email).toBe(false)
  })

  // ----- The item issue ledger -------------------------------------------------

  it('opens a row per issue, counts items apart from issues, and is idempotent within a run', async () => {
    const first = at('2026-09-01T05:30:00Z')
    const result = await issues.writeItemIssues([
      { itemId: 'v1', issues: [issue('image_link_broken', { attribute: 'n:image_link' }), issue('missing_value', { attribute: 'n:gtin', severity: 'demoted' })] },
      { itemId: 'v2', issues: [issue('image_link_broken', { attribute: 'n:image_link' })] },
      { itemId: 'v3', issues: [] },
    ], first)

    expect(result.open).toBe(3)
    // v1 and v2 are disapproved; v1's second issue is only a demotion, so it
    // must not be counted twice.
    expect(result.disapprovedItems).toBe(2)
    expect(result.resolved).toBe(0)

    const totals = await issues.readIssueTotals()
    expect(totals.openTotal).toBe(3)
    expect(totals.itemsAffected).toBe(2)
    expect(totals.bySeverity.disapproved).toBe(2)
    expect(totals.bySeverity.demoted).toBe(1)
    expect(totals.itemsBySeverity.disapproved).toBe(2)
  })

  it('stores the contexts as jsonb and reads them back whole', async () => {
    const rows = await issues.readItemIssues('v1')
    expect(rows).toHaveLength(2)
    const broken = rows.find((row) => row.code === 'image_link_broken')
    expect(broken?.contexts).toEqual([{ context: 'SHOPPING_ADS', disapprovedCountries: ['GB'], demotedCountries: [] }])
    // Google's product_view gives neither of these, so they must be null and
    // not an empty string pretending to be a sentence.
    expect(broken?.description).toBeNull()
    expect(broken?.documentationUrl).toBeNull()
  })

  it('closes an issue that stops being reported and leaves the ones still there alone', async () => {
    const second = at('2026-09-02T05:30:00Z')
    const result = await issues.writeItemIssues([
      { itemId: 'v1', issues: [issue('image_link_broken', { attribute: 'n:image_link' })] },
      { itemId: 'v2', issues: [issue('image_link_broken', { attribute: 'n:image_link' })] },
    ], second)

    expect(result.resolved).toBe(1)
    expect(result.open).toBe(2)

    const rows = await issues.readItemIssues('v1')
    const closed = rows.find((row) => row.code === 'missing_value')
    expect(closed?.resolvedAt).toBe(second.toISOString())
    // Closed, not deleted: "this was happening until the 2nd" is the useful
    // half of the story.
    expect(rows).toHaveLength(2)
    const stillOpen = rows.find((row) => row.code === 'image_link_broken')
    expect(stillOpen?.resolvedAt).toBeNull()
    expect(stillOpen?.detectedAt).toBe(at('2026-09-01T05:30:00Z').toISOString())
    expect(stillOpen?.lastSeenAt).toBe(second.toISOString())
  })

  it('reopens a closed issue as a new occurrence, not as one that never went away', async () => {
    const third = at('2026-09-05T05:30:00Z')
    await issues.writeItemIssues([
      { itemId: 'v1', issues: [issue('image_link_broken', { attribute: 'n:image_link' }), issue('missing_value', { attribute: 'n:gtin', severity: 'demoted' })] },
      { itemId: 'v2', issues: [issue('image_link_broken', { attribute: 'n:image_link' })] },
    ], third)

    const rows = await issues.readItemIssues('v1')
    const back = rows.find((row) => row.code === 'missing_value')
    expect(back?.resolvedAt).toBeNull()
    expect(back?.detectedAt).toBe(third.toISOString())
    const untouched = rows.find((row) => row.code === 'image_link_broken')
    expect(untouched?.detectedAt).toBe(at('2026-09-01T05:30:00Z').toISOString())
  })

  it('closes everything when Google reports on nothing at all', async () => {
    const empty = at('2026-09-06T05:30:00Z')
    const result = await issues.writeItemIssues([], empty)
    expect(result.resolved).toBe(3)
    expect(result.open).toBe(0)
    expect(result.disapprovedItems).toBe(0)
    expect((await issues.readIssueTotals()).itemsAffected).toBe(0)
  })

  // ----- What the Health tab reads ---------------------------------------------

  it('ranks codes worst first, counts items not issues, and dates each from its oldest open sighting', async () => {
    const day = at('2026-09-07T05:30:00Z')
    await issues.writeItemIssues([
      { itemId: 'v1', issues: [issue('image_link_broken'), issue('slow_page', { severity: 'demoted' })] },
      { itemId: 'v2', issues: [issue('slow_page', { severity: 'demoted' })] },
      { itemId: 'v3', issues: [issue('slow_page', { severity: 'demoted' })] },
      { itemId: 'v4', issues: [issue('pending_review', { severity: 'pending' })] },
    ], day)

    const codes = await issues.readTopIssueCodes()
    expect(codes.map((code) => code.code)).toEqual(['image_link_broken', 'slow_page', 'pending_review'])
    expect(codes[0]?.severity).toBe('disapproved')
    expect(codes[1]?.items).toBe(3)
    expect(codes[2]?.severity).toBe('pending')
    expect(codes[0]?.since).toBe(day.toISOString())
  })

  it('names the attribute a code is MOST OFTEN about, not the alphabetically first', async () => {
    // 'a_field' sorts first but happens once; 'z_field' happens twice and is
    // the one worth putting on the screen. array_agg(...)[1] answered the
    // wrong question here and read as right.
    //
    // Inserted directly rather than through writeItemIssues: that closes every
    // issue it is not told about, which would quietly wipe the rows the cases
    // below are still reading.
    await db.$executeRaw`
      INSERT INTO "gsf_item_issues" ("item_id", "code", "attribute", "severity")
      VALUES ('v1', 'mixed_fields', 'a_field', 'disapproved'),
             ('v2', 'mixed_fields', 'z_field', 'disapproved'),
             ('v3', 'mixed_fields', 'z_field', 'disapproved')
    `
    const codes = await issues.readTopIssueCodes()
    expect(codes.find((code) => code.code === 'mixed_fields')?.attribute).toBe('z_field')
    await db.$executeRaw`DELETE FROM "gsf_item_issues" WHERE "code" = 'mixed_fields'`
  })

  it('names a real field over the "no field" sentinel on an exact tie', async () => {
    // '' means "not about any one field", not a field called nothing. It also
    // sorts first, so a plain mode() handed the tie to '' and the screen lost
    // the field name for no better reason than half the items not having one.
    // NULLIF makes mode() ignore the sentinel.
    await db.$executeRaw`
      INSERT INTO "gsf_item_issues" ("item_id", "code", "attribute", "severity")
      VALUES ('v1', 'tied_fields', '', 'disapproved'),
             ('v2', 'tied_fields', 'n:brand', 'disapproved')
    `
    const codes = await issues.readTopIssueCodes()
    expect(codes.find((code) => code.code === 'tied_fields')?.attribute).toBe('n:brand')

    // And where NOTHING has a field, the answer is still the empty string
    // rather than a null reaching the screen.
    await db.$executeRaw`DELETE FROM "gsf_item_issues" WHERE "code" = 'tied_fields'`
    await db.$executeRaw`
      INSERT INTO "gsf_item_issues" ("item_id", "code", "attribute", "severity")
      VALUES ('v1', 'no_fields', '', 'disapproved'), ('v2', 'no_fields', '', 'disapproved')
    `
    const again = await issues.readTopIssueCodes()
    expect(again.find((code) => code.code === 'no_fields')?.attribute).toBe('')
    await db.$executeRaw`DELETE FROM "gsf_item_issues" WHERE "code" = 'no_fields'`
  })

  it('lists affected items worst first, with the title Google holds', async () => {
    await db.$executeRaw`
      INSERT INTO "gsf_item_match_status" ("item_id", "matched", "merchant_title", "reporting_status", "checked_at")
      VALUES ('v1', true, 'Acme Task Chair, Blue', 'not-eligible', CURRENT_TIMESTAMP)
    `
    const page = await issues.readAffectedItems({ limit: 10 })
    expect(page.total).toBe(4)
    expect(page.rows[0]?.itemId).toBe('v1')
    expect(page.rows[0]?.worstSeverity).toBe('disapproved')
    expect(page.rows[0]?.title).toBe('Acme Task Chair, Blue')
    // The worst reason first within the item, too.
    expect(page.rows[0]?.issues.map((one) => one.code)).toEqual(['image_link_broken', 'slow_page'])
    // An item Google has never matched still appears, with no title rather
    // than no row.
    expect(page.rows.find((row) => row.itemId === 'v4')?.title).toBe('')
  })

  it('filters the item list by code and by severity, and the count follows the filter', async () => {
    const byCode = await issues.readAffectedItems({ limit: 10, code: 'slow_page' })
    expect(byCode.total).toBe(3)
    expect(byCode.rows.map((row) => row.itemId).sort()).toEqual(['v1', 'v2', 'v3'])

    const bySeverity = await issues.readAffectedItems({ limit: 10, severity: 'pending' })
    expect(bySeverity.total).toBe(1)
    expect(bySeverity.rows[0]?.itemId).toBe('v4')

    const both = await issues.readAffectedItems({ limit: 10, code: 'slow_page', severity: 'disapproved' })
    expect(both.total).toBe(0)
  })

  it('pages the item list without losing the total', async () => {
    const first = await issues.readAffectedItems({ limit: 2, offset: 0 })
    const second = await issues.readAffectedItems({ limit: 2, offset: 2 })
    expect(first.total).toBe(4)
    expect(second.total).toBe(4)
    expect(first.rows).toHaveLength(2)
    expect(second.rows).toHaveLength(2)
    const ids = [...first.rows, ...second.rows].map((row) => row.itemId)
    expect(new Set(ids).size).toBe(4)
  })

  it('summarises one row per item for the products list', async () => {
    const summaries = await issues.readItemIssueSummaries()
    expect(summaries.get('v1')).toEqual({ worst: 'disapproved', codes: ['image_link_broken', 'slow_page'] })
    expect(summaries.get('v4')).toEqual({ worst: 'pending', codes: ['pending_review'] })
    expect(summaries.has('nobody')).toBe(false)
  })

  it('moves the workbench fingerprint when an issue opens or closes, and not otherwise', async () => {
    const before = await tables.readWorkbenchFingerprints()
    const unchanged = await tables.readWorkbenchFingerprints()
    expect(unchanged.issues).toBe(before.issues)

    await issues.writeItemIssues([
      { itemId: 'v1', issues: [issue('image_link_broken')] },
      { itemId: 'v2', issues: [issue('slow_page', { severity: 'demoted' })] },
      { itemId: 'v3', issues: [issue('slow_page', { severity: 'demoted' })] },
      { itemId: 'v4', issues: [issue('pending_review', { severity: 'pending' })] },
    ], at('2026-09-08T05:30:00Z'))
    const after = await tables.readWorkbenchFingerprints()
    expect(after.issues).not.toBe(before.issues)
  })

  it('reads the reporting status back with the match snapshot', async () => {
    const snapshots = await tables.readMatchSnapshots()
    expect(snapshots.get('v1')?.reportingStatus).toBe('not-eligible')
  })

  it('drops closed issues past their keep and never an open one', async () => {
    await db.$executeRaw`
      INSERT INTO "gsf_item_issues" ("item_id", "code", "attribute", "severity", "detected_at", "last_seen_at", "resolved_at")
      VALUES ('ancient', 'gone_long_ago', '', 'disapproved',
              CURRENT_TIMESTAMP - interval '400 days', CURRENT_TIMESTAMP - interval '400 days',
              CURRENT_TIMESTAMP - interval '399 days')
    `
    const dropped = await issues.pruneResolvedIssues()
    expect(dropped).toBe(1)
    expect((await issues.readIssueTotals()).itemsAffected).toBe(4)
  })

  // ----- The feed fetch row ----------------------------------------------------

  it('stores a fetch with its int64 counts and jsonb issues, and reads them back as numbers', async () => {
    await feed.storeFeedFetch({
      dataSourceId: '987654321',
      displayName: 'Cactus product feed',
      fetchUri: 'https://shop.example/google-shopping/feed.xml?key=abc',
      state: 'succeeded',
      itemsTotal: 4211,
      itemsCreated: 12,
      itemsUpdated: 4199,
      issues: [{ title: 'Missing brand', description: 'Some items have no brand.', code: 'validation/missing_brand', count: 7, severity: 'warning', documentationUri: 'https://example.test/help' }],
      uploadedAt: '2026-09-21T04:12:00.000Z',
      checkedAt: '2026-09-21T09:00:00.000Z',
    })

    const stored = await feed.readStoredFeedFetch('987654321')
    expect(stored?.itemsTotal).toBe(4211)
    expect(stored?.itemsUpdated).toBe(4199)
    expect(stored?.state).toBe('succeeded')
    expect(stored?.issues).toHaveLength(1)
    expect(stored?.issues[0]?.count).toBe(7)
    expect(stored?.uploadedAt).toBe('2026-09-21T04:12:00.000Z')
    // Prisma hands a raw int8 back as a BigInt, which JSON.stringify refuses
    // outright - and this goes straight into a JSON response.
    expect(() => JSON.stringify(stored)).not.toThrow()
  })

  it('replaces the row for the same data source rather than stacking them', async () => {
    await feed.storeFeedFetch({
      dataSourceId: '987654321',
      displayName: 'Cactus product feed',
      fetchUri: null,
      state: 'failed',
      itemsTotal: null,
      itemsCreated: null,
      itemsUpdated: null,
      issues: [],
      uploadedAt: null,
      checkedAt: '2026-09-22T09:00:00.000Z',
    })
    const all = await feed.listStoredFeedFetches()
    expect(all).toHaveLength(1)
    expect(all[0]?.state).toBe('failed')
    // Null is "Google did not say", which is not the same as zero.
    expect(all[0]?.itemsTotal).toBeNull()
    expect(all[0]?.uploadedAt).toBeNull()
  })

  it('reports nothing at all for a data source it has never seen', async () => {
    expect(await feed.readStoredFeedFetch('111')).toBeNull()
  })

  // ----- The settings the alerts hang off --------------------------------------

  it('keeps the digits of a typed-in feed number and refuses an undeliverable address', async () => {
    await settings.updateGsfSettings({ feedDataSourceId: 'ID: 987 654-321', alertEmail: 'owner@example.test', alertEmailEnabled: true, disapprovalAlertThreshold: 40 })
    const saved = await settings.getGsfSettings()
    expect(saved.feedDataSourceId).toBe('987654321')
    expect(saved.alertEmail).toBe('owner@example.test')
    expect(saved.alertEmailEnabled).toBe(true)
    expect(saved.disapprovalAlertThreshold).toBe(40)

    await settings.updateGsfSettings({ alertEmail: 'not an address' })
    expect((await settings.getGsfSettings()).alertEmail).toBeNull()
  })

  it('keeps the discovered feed number apart from the one the owner typed', async () => {
    await settings.rememberDetectedDataSource('555')
    const saved = await settings.getGsfSettings()
    expect(saved.feedDataSourceDetectedId).toBe('555')
    expect(saved.feedDataSourceId).toBe('987654321')

    // Clearing the override falls back to what was already found, rather than
    // to nothing at all.
    await settings.updateGsfSettings({ feedDataSourceId: '' })
    const cleared = await settings.getGsfSettings()
    expect(cleared.feedDataSourceId).toBeNull()
    expect(cleared.feedDataSourceDetectedId).toBe('555')
  })

  it('remembers when it last asked and what it found, so the next run has something to compare with', async () => {
    const before = await settings.getGsfSettings()
    expect(before.issuesCheckedAt).toBeNull()
    expect(before.lastDisapprovedCount).toBeNull()

    const when = at('2026-09-22T05:30:00Z')
    await settings.recordIssueCheck(when, 137)
    const after = await settings.getGsfSettings()
    expect(after.issuesCheckedAt?.toISOString()).toBe(when.toISOString())
    expect(after.lastDisapprovedCount).toBe(137)
  })

  it('clamps a nonsense threshold rather than storing it', async () => {
    await settings.updateGsfSettings({ disapprovalAlertThreshold: -5 })
    expect((await settings.getGsfSettings()).disapprovalAlertThreshold).toBe(0)
  })

  // ----- The spike alert's whole life ------------------------------------------

  it('raises on a jump, keeps its wording current, and clears when the count comes back down', async () => {
    const key = 'google-shopping:disapproval-spike'
    await db.$executeRaw`DELETE FROM "Notification" WHERE "dedupeKey" = ${key}`

    // Nothing up, and no jump: nothing happens.
    expect(await alerts.syncDisapprovalAlert({ disapproved: 5, previous: 3, threshold: 25, openBaseline: null })).toBe(false)
    expect(await alerts.readSpikeBaseline()).toBeNull()

    // A jump of 197 from a baseline of 3.
    expect(await alerts.syncDisapprovalAlert({ disapproved: 200, previous: 3, threshold: 25, openBaseline: null })).toBe(true)
    expect(await alerts.readSpikeBaseline()).toBe(3)
    const [raised] = await db.$queryRaw<Array<{ title: string }>>`
      SELECT "title" FROM "Notification" WHERE "dedupeKey" = ${key}
    `
    expect(raised?.title).toContain('197 more products')
    expect(raised?.title).toContain('200 products in total')

    // It gets worse. Same baseline, new figures - not a stale title.
    expect(await alerts.syncDisapprovalAlert({ disapproved: 260, previous: 200, threshold: 25, openBaseline: 3 })).toBe(true)
    const [rewritten] = await db.$queryRaw<Array<{ title: string }>>`
      SELECT "title" FROM "Notification" WHERE "dedupeKey" = ${key}
    `
    expect(rewritten?.title).toContain('257 more products')
    expect(await alerts.readSpikeBaseline()).toBe(3)

    // Still elevated but improving: the notice stays, because the products are
    // still off Google.
    expect(await alerts.syncDisapprovalAlert({ disapproved: 40, previous: 260, threshold: 25, openBaseline: 3 })).toBe(true)

    // Back to where it started. The incident is over, even though three
    // products are still turned down - a shop with a few permanently awkward
    // items is not in the middle of anything.
    expect(await alerts.syncDisapprovalAlert({ disapproved: 3, previous: 40, threshold: 25, openBaseline: 3 })).toBe(false)
    const after = await db.$queryRaw<Array<{ title: string }>>`
      SELECT "title" FROM "Notification" WHERE "dedupeKey" = ${key}
    `
    expect(after).toHaveLength(0)
    expect(await alerts.readSpikeBaseline()).toBeNull()
  })

  it('never raises on a first check, and never with the threshold at zero', async () => {
    const key = 'google-shopping:disapproval-spike'
    await db.$executeRaw`DELETE FROM "Notification" WHERE "dedupeKey" = ${key}`
    expect(await alerts.syncDisapprovalAlert({ disapproved: 5000, previous: null, threshold: 25, openBaseline: null })).toBe(false)
    expect(await alerts.syncDisapprovalAlert({ disapproved: 5000, previous: 0, threshold: 0, openBaseline: null })).toBe(false)
    expect(await alerts.readSpikeBaseline()).toBeNull()
  })

  it('takes down an alert that is ALREADY UP when the threshold is set to zero', async () => {
    // The whole point of 0 is to make it stop. The threshold used to be read
    // only on the way up, so an owner with a notice in the bell could set 0
    // and watch it go on re-titling itself every time the count moved.
    const key = 'google-shopping:disapproval-spike'
    await db.$executeRaw`DELETE FROM "Notification" WHERE "dedupeKey" = ${key}`

    expect(await alerts.syncDisapprovalAlert({ disapproved: 200, previous: 3, threshold: 25, openBaseline: null })).toBe(true)
    expect(await alerts.readSpikeBaseline()).toBe(3)

    // Switched off, with the count still high and still climbing.
    expect(await alerts.syncDisapprovalAlert({ disapproved: 260, previous: 200, threshold: 0, openBaseline: 3 })).toBe(false)
    expect(await db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Notification" WHERE "dedupeKey" = ${key}`).toHaveLength(0)
    expect(await alerts.readSpikeBaseline()).toBeNull()

    // And it stays gone while it is switched off.
    expect(await alerts.syncDisapprovalAlert({ disapproved: 9000, previous: 260, threshold: 0, openBaseline: null })).toBe(false)
    expect(await db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Notification" WHERE "dedupeKey" = ${key}`).toHaveLength(0)
  })

  it('treats an alert raised by an older build, with no baseline on it, as measuring from zero', async () => {
    const key = 'google-shopping:disapproval-spike'
    await db.$executeRaw`DELETE FROM "Notification" WHERE "dedupeKey" = ${key}`
    await db.$executeRaw`
      INSERT INTO "Notification" ("id", "type", "dedupeKey", "title", "updatedAt")
      VALUES ('older-build-alert', 'alert', ${key}, 'Something from before', CURRENT_TIMESTAMP)
    `
    expect(await alerts.readSpikeBaseline()).toBe(0)
    // Measuring from zero, it clears only once nothing is disapproved at all -
    // which is exactly how it behaved when it was raised.
    expect(await alerts.syncDisapprovalAlert({ disapproved: 1, previous: 1, threshold: 25, openBaseline: 0 })).toBe(true)
    expect(await alerts.syncDisapprovalAlert({ disapproved: 0, previous: 1, threshold: 25, openBaseline: 0 })).toBe(false)
  })

  // ----- The feed fetch alert stays quiet about setup ---------------------------

  it('never puts a setup state in the bell, and does alert on a real failure', async () => {
    const key = 'google-shopping:feed-fetch'
    await db.$executeRaw`DELETE FROM "Notification" WHERE "dedupeKey" = ${key}`

    // 'not-found' covers "no data source yet" and "Google has never fetched
    // it" - both standing states that would sit in the bell from install day.
    for (const reason of ['not-found', 'no-credentials', 'no-merchant-id', 'denied', 'error'] as const) {
      expect(await alerts.syncFeedFetchAlert({ status: 'unavailable', reason, alreadyUp: false })).toBe(false)
    }
    expect(await db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Notification" WHERE "dedupeKey" = ${key}`).toHaveLength(0)

    const fetched = {
      dataSourceId: '1', displayName: null, fetchUri: null,
      itemsTotal: null, itemsCreated: null, itemsUpdated: null,
      issues: [{ title: 'Item too big', description: 'Some items were dropped.', code: 'x', count: 4, severity: 'error' as const, documentationUri: null }],
      uploadedAt: null, checkedAt: new Date().toISOString(),
    }
    // Google fetched and could not read it. That one is real.
    expect(await alerts.syncFeedFetchAlert({ status: 'ok', fetch: { ...fetched, state: 'failed' }, alreadyUp: false })).toBe(true)
    const [up] = await db.$queryRaw<Array<{ title: string }>>`SELECT "title" FROM "Notification" WHERE "dedupeKey" = ${key}`
    expect(up?.title).toContain('Item too big')

    // And it clears the moment a read works.
    expect(await alerts.syncFeedFetchAlert({ status: 'ok', fetch: { ...fetched, state: 'succeeded' }, alreadyUp: true })).toBe(false)
    expect(await db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Notification" WHERE "dedupeKey" = ${key}`).toHaveLength(0)
  })

  // ----- "Explain this": the cache and its staleness rule ----------------------
  //
  // No Google here - these cases prove the SQL behind the button, and the rule
  // that decides when a held answer has gone off. The environment has no
  // service-account key, so anything that needs Google comes back
  // 'no-credentials', which is itself the proof that the cache was missed.

  it('stores Google\'s wording on the rows it explains, and stamps every open row', async () => {
    await db.$executeRaw`DELETE FROM "gsf_item_issues"`
    const seen = at('2026-09-10T05:30:00Z')
    await issues.writeItemIssues([
      { itemId: 'v1', issues: [issue('image_link_broken', { attribute: 'n:image_link' }), issue('missing_gtin', { attribute: 'n:gtin' })] },
    ], seen)

    const askedAt = at('2026-09-10T09:00:00Z')
    await explain.cacheExplanations('v1', [{
      code: 'image_link_broken',
      attribute: 'n:image_link',
      description: 'Invalid image',
      detail: 'Make sure the image can be downloaded',
      documentationUrl: 'https://support.google.com/merchants/answer/6098289',
      severity: 'disapproved',
      resolution: 'merchant_action',
      reportingContext: 'SHOPPING_ADS',
      applicableCountries: ['GB'],
    }], askedAt)

    const rows = await db.$queryRaw<Array<{ code: string; description: string | null; detail: string | null; documentation_url: string | null; explained_at: Date | null }>>`
      SELECT "code", "description", "detail", "documentation_url", "explained_at"
      FROM "gsf_item_issues" WHERE "item_id" = 'v1' ORDER BY "code"
    `
    const explained = rows.find((row) => row.code === 'image_link_broken')
    expect(explained?.description).toBe('Invalid image')
    expect(explained?.detail).toBe('Make sure the image can be downloaded')
    expect(explained?.documentation_url).toBe('https://support.google.com/merchants/answer/6098289')

    // The OTHER issue got no words - but it was asked about, so it carries the
    // stamp too. Without that, an item Google says nothing about would look
    // un-asked for ever and re-ask on every single press.
    const quiet = rows.find((row) => row.code === 'missing_gtin')
    expect(quiet?.description).toBeNull()
    expect(quiet?.explained_at?.toISOString()).toBe(askedAt.toISOString())
  })

  it('serves a held answer without reaching for Google', async () => {
    // Fresh, and with words in it: comes straight back, and never gets as far
    // as needing a key.
    const outcome = await explain.explainItem('v1')
    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return
    expect(outcome.fromCache).toBe(true)
    expect(outcome.issues.find((one) => one.code === 'image_link_broken')?.detail).toBe('Make sure the image can be downloaded')
  })

  it('goes back to Google once the issue has been seen again since', async () => {
    // The whole cache rule in one case: the daily check moves last_seen_at
    // past explained_at, so the held wording is stale and the next press asks
    // afresh. No key here, so "asks afresh" surfaces as no-credentials.
    await issues.writeItemIssues([
      { itemId: 'v1', issues: [issue('image_link_broken', { attribute: 'n:image_link' }), issue('missing_gtin', { attribute: 'n:gtin' })] },
    ], at('2026-09-11T05:30:00Z'))

    const outcome = await explain.explainItem('v1')
    expect(outcome.status).toBe('unavailable')
    if (outcome.status === 'unavailable') expect(outcome.reason).toBe('no-credentials')
  })

  it('asks again when told to, once the answer is older than the cooldown', async () => {
    await explain.cacheExplanations('v1', [], at('2026-09-11T09:00:00Z'))
    await db.$executeRaw`UPDATE "gsf_item_issues" SET "description" = 'Held' WHERE "item_id" = 'v1' AND "code" = 'image_link_broken'`
    // Without force it is served from the cache...
    expect((await explain.explainItem('v1')).status).toBe('ok')
    // The case before this one asked about v1 seconds ago, so v1's claim is
    // still live. Aged, because this case is about force beating STALENESS -
    // the brake has its own cases and should not be silently under test here.
    await db.$executeRaw`
      UPDATE "gsf_item_issues"
      SET "explain_claimed_at" = CURRENT_TIMESTAMP - interval '2 minutes' WHERE "item_id" = 'v1'
    `

    // ...and with it, Google is asked regardless. The stamp here is dated
    // 2026-09-11, so the cooldown is long past.
    //
    // Pinned to the reason, not just the status: 'nothing-to-explain' and
    // 'just-asked' are both 'unavailable' too, and either would have let this
    // pass while proving the opposite of what it claims.
    const forced = await explain.explainItem('v1', { force: true })
    expect(forced.status).toBe('unavailable')
    if (forced.status === 'unavailable') expect(forced.reason).toBe('no-credentials')
  })

  it('says Google had nothing to add rather than drawing an empty box', async () => {
    // Asked, answered, and no words came back. A real answer, and a different
    // one from "not asked yet" - the screen must never invent an explanation
    // to fill the gap.
    await db.$executeRaw`DELETE FROM "gsf_item_issues"`
    await issues.writeItemIssues([{ itemId: 'v2', issues: [issue('mystery_code')] }], at('2026-09-12T05:30:00Z'))
    await explain.cacheExplanations('v2', [], at('2026-09-12T09:00:00Z'))

    const outcome = await explain.explainItem('v2')
    expect(outcome.status).toBe('no-words')
  })

  it('refuses an item with no open issues, without asking Google', async () => {
    // Nothing to explain, and nothing held. It must not read as "Google had
    // nothing to say" (an all clear we have not earned) - and it must not
    // reach Google either, which is what stops a made-up item id being an
    // unmetered way to spend the account's quota: a row that does not exist
    // cannot be stamped with a cooldown.
    const outcome = await explain.explainItem('nobody-here')
    expect(outcome.status).toBe('unavailable')
    if (outcome.status === 'unavailable') expect(outcome.reason).toBe('nothing-to-explain')

    // And force does not get round it.
    const forced = await explain.explainItem('nobody-here', { force: true })
    expect(forced.status).toBe('unavailable')
    if (forced.status === 'unavailable') expect(forced.reason).toBe('nothing-to-explain')
  })

  it('lets exactly ONE of a concurrent burst claim the slot', async () => {
    // The case a serial test cannot make. The old brake read explained_at,
    // checked it, spent several hundred ms at Google and only stamped
    // afterwards - so every request arriving before that stamp read the same
    // pre-stamp value and passed. Two hundred parallel presses for one item
    // were two hundred Merchant API calls, repeatable every thirty seconds.
    //
    // Fired with Promise.all against the real database, because the whole
    // proof is that Postgres serialises the claims: anything with a fake
    // client, or run one after another, would pass just as happily against
    // the broken version.
    //
    // Claimed directly rather than through explainItem: with no credentials
    // configured the setup checks answer first, by design, so explainItem
    // cannot reach the claim here at all.
    await db.$executeRaw`DELETE FROM "gsf_item_issues"`
    await issues.writeItemIssues([{ itemId: 'v5', issues: [issue('image_link_broken'), issue('missing_gtin', { attribute: 'n:gtin' })] }], at('2026-09-14T05:30:00Z'))

    const BURST = 24
    const claims = await Promise.all(Array.from({ length: BURST }, () => explain.claimExplainSlot('v5')))

    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(claims.filter((won) => !won)).toHaveLength(BURST - 1)

    // The claim is on every open row of the item, so the next thirty seconds
    // are shut too.
    const rows = await db.$queryRaw<Array<{ claimed: Date | null; explained: Date | null }>>`
      SELECT "explain_claimed_at" AS "claimed", "explained_at" AS "explained"
      FROM "gsf_item_issues" WHERE "item_id" = 'v5'
    `
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.claimed !== null)).toBe(true)
    // Nothing succeeded, so nothing may claim it was explained. This is why
    // the claim is its own column: writing explained_at here would have the
    // screen report silence from Google that nobody ever heard.
    expect(rows.every((row) => row.explained === null)).toBe(true)

    expect(await explain.claimExplainSlot('v5')).toBe(false)
  })

  it('reopens the slot once the window has passed', async () => {
    await db.$executeRaw`
      UPDATE "gsf_item_issues"
      SET "explain_claimed_at" = CURRENT_TIMESTAMP - interval '2 minutes' WHERE "item_id" = 'v5'
    `
    expect(await explain.claimExplainSlot('v5')).toBe(true)
    expect(await explain.claimExplainSlot('v5')).toBe(false)
  })

  it('never claims a slot for an item with nothing open against it', async () => {
    // A made-up item id has no row to claim, which is the other half of the
    // brake: without this, an id nobody has ever heard of would be an
    // unmetered way to spend the account's quota.
    expect(await explain.claimExplainSlot('nobody-here')).toBe(false)
  })

  it('keeps the setup guidance on screen instead of burning the slot', async () => {
    // The credentials, account number and feed label checks all sit ABOVE the
    // claim, because none of them touches anything outside the building. On a
    // half-configured install the owner must keep being told what to fill in
    // - not "Google was asked a moment ago", which would be both untrue and
    // useless for the next thirty seconds.
    await db.$executeRaw`DELETE FROM "gsf_item_issues"`
    await issues.writeItemIssues([{ itemId: 'v6', issues: [issue('image_link_broken')] }], at('2026-09-14T05:30:00Z'))

    for (let press = 0; press < 4; press++) {
      const outcome = await explain.explainItem('v6', { force: true })
      expect(outcome.status).toBe('unavailable')
      if (outcome.status === 'unavailable') expect(outcome.reason).toBe('no-credentials')
    }

    // And not one of those presses took the slot.
    const [row] = await db.$queryRaw<Array<{ claimed: Date | null }>>`
      SELECT "explain_claimed_at" AS "claimed" FROM "gsf_item_issues" WHERE "item_id" = 'v6'
    `
    expect(row?.claimed).toBeNull()
    expect(await explain.claimExplainSlot('v6')).toBe(true)
  })

  it('serves a held answer without asking again', async () => {
    await db.$executeRaw`DELETE FROM "gsf_item_issues"`
    await issues.writeItemIssues([{ itemId: 'v3', issues: [issue('image_link_broken')] }], at('2026-09-13T05:30:00Z'))

    await explain.cacheExplanations('v3', [{
      code: 'image_link_broken', attribute: '', description: 'Invalid image', detail: '',
      documentationUrl: null, severity: 'disapproved', resolution: 'merchant_action',
      reportingContext: 'SHOPPING_ADS', applicableCountries: ['GB'],
    }], new Date())

    // Pressed repeatedly, served from the cache every time, and the slot is
    // never touched - a held answer costs nothing and takes nothing.
    for (let press = 0; press < 5; press++) {
      const outcome = await explain.explainItem('v3')
      expect(outcome.status).toBe('ok')
      if (outcome.status === 'ok') {
        expect(outcome.fromCache).toBe(true)
        expect(outcome.issues[0]?.description).toBe('Invalid image')
      }
    }
    const [row] = await db.$queryRaw<Array<{ claimed: Date | null }>>`
      SELECT "explain_claimed_at" AS "claimed" FROM "gsf_item_issues" WHERE "item_id" = 'v3'
    `
    expect(row?.claimed).toBeNull()
  })

  it('says Google had nothing to add, and keeps saying it', async () => {
    // The stamp goes on every open row, explained or not, so an item Google
    // was silent about is not re-asked on every press.
    await db.$executeRaw`DELETE FROM "gsf_item_issues"`
    await issues.writeItemIssues([{ itemId: 'v4', issues: [issue('mystery_code')] }], at('2026-09-13T05:30:00Z'))
    await explain.cacheExplanations('v4', [], new Date())

    // explained_at is fresh AND the call genuinely completed, so this really
    // is Google having nothing to add - not the brake talking, and not a
    // failure wearing its clothes.
    for (let press = 0; press < 3; press++) {
      expect((await explain.explainItem('v4')).status).toBe('no-words')
    }
  })
})