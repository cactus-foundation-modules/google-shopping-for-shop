// Storing and reading what Google says is wrong with individual items.
//
// The table is a LEDGER, not a snapshot. An issue is opened the first time it
// is seen and closed when it stops being reported, so "the barcodes went wrong
// on the 3rd and were fixed on the 5th" survives; a delete-and-replace would
// leave only "everything is fine now", which is no use to anyone trying to
// work out what they changed.
//
// All of it is raw SQL, which typecheck, eslint and the build all see as a
// plain string. lib/health-sql.test.ts runs every statement here against a real
// throwaway Postgres, because nothing else will.
import { Prisma } from '@prisma/client'
import { prisma, type PrismaTransactionClient } from '@/lib/db/prisma'
import type { ParsedItemIssue } from '@/modules/google-shopping-for-shop/lib/health/parse'
import {
  storedResolution,
  storedSeverity,
  type IssueContext,
  type IssueSeverity,
  type ItemIssue,
} from '@/modules/google-shopping-for-shop/lib/health/types'

/** How long a closed issue is kept. Long enough to cover "was this happening
 *  before Christmas?", short enough that a shop with a chronic feed problem
 *  does not accumulate a row per item per code for ever. */
const KEEP_RESOLVED_DAYS = 180

/** Rows per statement. A VALUES list is a parameter per column per row, and
 *  Postgres stops at 65,535 parameters in one statement; seven columns at 500
 *  rows is 3,500, comfortably inside it and still one round trip per 500. */
const BATCH = 500

export type ItemIssueInput = { itemId: string; issues: ParsedItemIssue[] }

export type IssueWriteResult = {
  /** Issues still being reported after this run. */
  open: number
  /** Items with at least one issue that disapproves them. */
  disapprovedItems: number
  /** Issues this run closed because Google stopped mentioning them. */
  resolved: number
}

function contextsJson(contexts: IssueContext[]): string {
  return JSON.stringify(contexts)
}

/**
 * Records this run's issues and closes the ones that have gone away.
 *
 * `checkedAt` is the run's single instant, used for every row: the resolve step
 * below finds "not seen this run" by comparing last_seen_at against it, so a
 * per-row `now()` would leave rows written a millisecond apart looking stale.
 */
export async function writeItemIssues(items: ItemIssueInput[], checkedAt: Date): Promise<IssueWriteResult> {
  const values: Prisma.Sql[] = []
  for (const item of items) {
    for (const issue of item.issues) {
      // Casts because a VALUES list inside a CTE has no target column to
      // borrow its types from.
      values.push(Prisma.sql`(
        ${item.itemId}::text,
        ${issue.code}::text,
        ${issue.attribute}::text,
        ${issue.severity}::text,
        ${issue.resolution}::text,
        ${contextsJson(issue.contexts)}::jsonb,
        ${checkedAt}::timestamp(3)
      )`)
    }
  }

  for (let i = 0; i < values.length; i += BATCH) {
    await prisma.$executeRaw`
      INSERT INTO "gsf_item_issues"
        ("item_id", "code", "attribute", "severity", "resolution", "contexts", "detected_at", "last_seen_at")
      SELECT "item_id", "code", "attribute", "severity", "resolution", "contexts", "seen", "seen"
      FROM (VALUES ${Prisma.join(values.slice(i, i + BATCH))})
        AS "incoming" ("item_id", "code", "attribute", "severity", "resolution", "contexts", "seen")
      ON CONFLICT ("item_id", "code", "attribute") DO UPDATE SET
        "severity" = EXCLUDED."severity",
        "resolution" = EXCLUDED."resolution",
        "contexts" = EXCLUDED."contexts",
        "last_seen_at" = EXCLUDED."last_seen_at",
        -- An issue that had been closed and is back is a NEW occurrence, and
        -- is dated as one. One that never went away keeps the date it started.
        "detected_at" = CASE
          WHEN "gsf_item_issues"."resolved_at" IS NOT NULL THEN EXCLUDED."detected_at"
          ELSE "gsf_item_issues"."detected_at"
        END,
        "resolved_at" = NULL
    `
  }

  // Everything open that this run did not mention has stopped being reported.
  //
  // Two things make that safe to say. A refresh is all-or-nothing: collecting
  // the report throws rather than returning half a catalogue, so a partial run
  // never gets here. And an EMPTY report never gets here either - Google
  // answers 200 with no rows while an account is reprocessing, which would
  // otherwise close the entire ledger on the strength of Google saying
  // nothing at all. The caller (lib/merchant-reports.ts) refuses to call this
  // with an empty list, and so must any future caller.
  const resolved = await prisma.$executeRaw`
    UPDATE "gsf_item_issues"
    SET "resolved_at" = ${checkedAt}
    WHERE "resolved_at" IS NULL AND "last_seen_at" < ${checkedAt}
  `

  await pruneResolvedIssues()

  const [counts] = await prisma.$queryRaw<Array<{ open: number; items: number }>>`
    SELECT count(*)::int AS "open",
           count(DISTINCT "item_id") FILTER (WHERE "severity" = 'disapproved')::int AS "items"
    FROM "gsf_item_issues"
    WHERE "resolved_at" IS NULL
  `
  return { open: counts?.open ?? 0, disapprovedItems: counts?.items ?? 0, resolved }
}

/** Drops closed issues past their keep. Open ones are never pruned - an issue
 *  that has been sitting there since March is precisely the one worth seeing. */
export async function pruneResolvedIssues(db: PrismaTransactionClient = prisma): Promise<number> {
  return db.$executeRaw`
    DELETE FROM "gsf_item_issues"
    WHERE "resolved_at" IS NOT NULL
      AND "resolved_at" < CURRENT_TIMESTAMP - make_interval(days => ${KEEP_RESOLVED_DAYS}::int)
  `
}

export type IssueTotals = {
  /** Open issues, by how badly each one bites. */
  bySeverity: Record<IssueSeverity, number>
  /** Items with at least one open issue, by their worst severity. */
  itemsBySeverity: Record<IssueSeverity, number>
  /** Items with any open issue at all. */
  itemsAffected: number
  openTotal: number
}

type SeverityRow = { severity: string; issues: number; items: number }

const EMPTY_BY_SEVERITY: Record<IssueSeverity, number> = { disapproved: 0, demoted: 0, pending: 0, unknown: 0 }

/** Open issues counted two ways: how many issues, and how many items. They are
 *  different numbers and the difference matters - one broken image host is one
 *  code and four thousand items. */
export async function readIssueTotals(): Promise<IssueTotals> {
  const rows = await prisma.$queryRaw<SeverityRow[]>`
    SELECT "severity",
           count(*)::int AS "issues",
           count(DISTINCT "item_id")::int AS "items"
    FROM "gsf_item_issues"
    WHERE "resolved_at" IS NULL
    GROUP BY "severity"
  `
  const bySeverity = { ...EMPTY_BY_SEVERITY }
  const itemsBySeverity = { ...EMPTY_BY_SEVERITY }
  let openTotal = 0
  for (const row of rows) {
    const severity = storedSeverity(row.severity)
    bySeverity[severity] += row.issues
    itemsBySeverity[severity] += row.items
    openTotal += row.issues
  }
  const [affected] = await prisma.$queryRaw<Array<{ items: number }>>`
    SELECT count(DISTINCT "item_id")::int AS "items" FROM "gsf_item_issues" WHERE "resolved_at" IS NULL
  `
  return { bySeverity, itemsBySeverity, itemsAffected: affected?.items ?? 0, openTotal }
}

export type IssueCodeCount = {
  code: string
  /** The worst severity this code is reported at. */
  severity: IssueSeverity
  /** Items this code is open against. */
  items: number
  /** The attribute it is most often about, '' where it is about no field. */
  attribute: string
  /** The oldest still-open sighting. */
  since: string
}

// `attribute` is nullable here and nowhere else: mode() is fed NULLIF(attribute, '')
// and returns NULL when every sighting of a code is the "no field" sentinel.
type CodeRow = { code: string; severity: string; items: number; attribute: string | null; since: Date }

/** The worst codes first: the list to work down. */
export async function readTopIssueCodes(limit = 25): Promise<IssueCodeCount[]> {
  const capped = Math.min(Math.max(1, Math.trunc(limit)), 200)
  const rows = await prisma.$queryRaw<CodeRow[]>`
    SELECT "code",
           -- The worst severity this code appears at anywhere, by the same
           -- ordering the screen sorts by.
           (ARRAY['unknown', 'pending', 'demoted', 'disapproved'])[
             max(CASE "severity" WHEN 'disapproved' THEN 4 WHEN 'demoted' THEN 3 WHEN 'pending' THEN 2 ELSE 1 END)
           ] AS "severity",
           count(DISTINCT "item_id")::int AS "items",
           -- The attribute this code is MOST OFTEN about. mode() is the
           -- ordered-set aggregate for exactly that; array_agg(...)[1] was
           -- here first and quietly answered a different question, namely
           -- whichever attribute sorts first alphabetically.
           --
           -- NULLIF because '' is our sentinel for "not about any one field",
           -- not a field name, and mode() ignores nulls. Without it an exact
           -- tie between '' and a real attribute is won by '' (it sorts
           -- first), and the screen drops the field name for no better reason
           -- than that half the items did not have one.
           mode() WITHIN GROUP (ORDER BY NULLIF("attribute", '')) AS "attribute",
           min("detected_at") AS "since"
    FROM "gsf_item_issues"
    WHERE "resolved_at" IS NULL
    GROUP BY "code"
    ORDER BY max(CASE "severity" WHEN 'disapproved' THEN 4 WHEN 'demoted' THEN 3 WHEN 'pending' THEN 2 ELSE 1 END) DESC,
             count(DISTINCT "item_id") DESC,
             "code" ASC
    LIMIT ${capped}
  `
  return rows.map((row) => ({
    code: row.code,
    severity: storedSeverity(row.severity),
    items: row.items,
    attribute: row.attribute ?? '',
    since: row.since.toISOString(),
  }))
}

export type AffectedItem = {
  itemId: string
  /** The title Google holds for this item, '' when it holds none. */
  title: string
  worstSeverity: IssueSeverity
  issues: Array<{ code: string; attribute: string; severity: IssueSeverity }>
  since: string
}

type AffectedRow = {
  item_id: string
  merchant_title: string | null
  worst: number
  since: Date
  issues: Array<{ code: string; attribute: string; severity: string }> | null
}

/**
 * Items with open issues, worst first.
 *
 * Joined to the match snapshot only for the title Google holds: the Health tab
 * must be readable in a few milliseconds, and reaching for the whole catalogue
 * (which is a feed build) to put a name beside each row would make it the
 * slowest screen in the admin.
 */
export async function readAffectedItems(options: { limit: number; offset?: number; code?: string; severity?: IssueSeverity }): Promise<{ rows: AffectedItem[]; total: number }> {
  const limit = Math.min(Math.max(1, Math.trunc(options.limit)), 500)
  const offset = Math.max(0, Math.trunc(options.offset ?? 0))
  const code = options.code?.trim() || null
  const severity = options.severity ?? null

  // One WHERE shared by the page and its count, so the two can never disagree.
  const where = Prisma.sql`
    "resolved_at" IS NULL
    AND (${code}::text IS NULL OR "code" = ${code}::text)
    AND (${severity}::text IS NULL OR "severity" = ${severity}::text)
  `

  const rows = await prisma.$queryRaw<AffectedRow[]>`
    WITH "open" AS (
      SELECT "item_id",
             max(CASE "severity" WHEN 'disapproved' THEN 4 WHEN 'demoted' THEN 3 WHEN 'pending' THEN 2 ELSE 1 END) AS "worst",
             min("detected_at") AS "since",
             jsonb_agg(jsonb_build_object('code', "code", 'attribute', "attribute", 'severity', "severity")
                       ORDER BY CASE "severity" WHEN 'disapproved' THEN 4 WHEN 'demoted' THEN 3 WHEN 'pending' THEN 2 ELSE 1 END DESC,
                                "code" ASC) AS "issues"
      FROM "gsf_item_issues"
      WHERE ${where}
      GROUP BY "item_id"
    )
    SELECT o."item_id", s."merchant_title", o."worst"::int AS "worst", o."since", o."issues"
    FROM "open" o
    LEFT JOIN "gsf_item_match_status" s ON s."item_id" = o."item_id"
    ORDER BY o."worst" DESC, o."since" ASC, o."item_id" ASC
    LIMIT ${limit} OFFSET ${offset}
  `

  const [counted] = await prisma.$queryRaw<Array<{ total: number }>>`
    SELECT count(DISTINCT "item_id")::int AS "total" FROM "gsf_item_issues" WHERE ${where}
  `

  const WORST: Record<number, IssueSeverity> = { 4: 'disapproved', 3: 'demoted', 2: 'pending', 1: 'unknown' }
  return {
    rows: rows.map((row) => ({
      itemId: row.item_id,
      title: row.merchant_title?.trim() ?? '',
      worstSeverity: WORST[row.worst] ?? 'unknown',
      issues: (row.issues ?? []).map((issue) => ({
        code: issue.code,
        attribute: issue.attribute,
        severity: storedSeverity(issue.severity),
      })),
      since: row.since.toISOString(),
    })),
    total: counted?.total ?? 0,
  }
}

type FullRow = {
  item_id: string
  code: string
  attribute: string
  severity: string
  resolution: string
  description: string | null
  documentation_url: string | null
  contexts: IssueContext[] | null
  detected_at: Date
  last_seen_at: Date
  resolved_at: Date | null
}

/** Everything known about one item's issues, open and closed. */
export async function readItemIssues(itemId: string): Promise<ItemIssue[]> {
  const rows = await prisma.$queryRaw<FullRow[]>`
    SELECT "item_id", "code", "attribute", "severity", "resolution", "description", "documentation_url",
           "contexts", "detected_at", "last_seen_at", "resolved_at"
    FROM "gsf_item_issues"
    WHERE "item_id" = ${itemId}
    ORDER BY "resolved_at" NULLS FIRST, "detected_at" DESC, "code" ASC
  `
  return rows.map((row) => ({
    itemId: row.item_id,
    code: row.code,
    attribute: row.attribute,
    severity: storedSeverity(row.severity),
    resolution: storedResolution(row.resolution),
    description: row.description,
    documentationUrl: row.documentation_url,
    contexts: row.contexts ?? [],
    detectedAt: row.detected_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
  }))
}

/** What the workbench's product list needs per item: the open issues, small
 *  enough to hold one per row for a whole catalogue. */
export type ItemIssueSummary = {
  worst: IssueSeverity
  codes: string[]
}

type SummaryRow = { item_id: string; worst: number; codes: string[] }

export async function readItemIssueSummaries(): Promise<Map<string, ItemIssueSummary>> {
  const rows = await prisma.$queryRaw<SummaryRow[]>`
    SELECT "item_id",
           max(CASE "severity" WHEN 'disapproved' THEN 4 WHEN 'demoted' THEN 3 WHEN 'pending' THEN 2 ELSE 1 END)::int AS "worst",
           array_agg(DISTINCT "code" ORDER BY "code") AS "codes"
    FROM "gsf_item_issues"
    WHERE "resolved_at" IS NULL
    GROUP BY "item_id"
  `
  const WORST: Record<number, IssueSeverity> = { 4: 'disapproved', 3: 'demoted', 2: 'pending', 1: 'unknown' }
  return new Map(rows.map((row) => [row.item_id, { worst: WORST[row.worst] ?? 'unknown', codes: row.codes }]))
}

/** One opaque string that moves whenever any issue row does, for the
 *  workbench's "may I serve what I am holding?" check. */
export async function readIssueFingerprint(): Promise<string> {
  const [row] = await prisma.$queryRaw<Array<{ count: number; hash: bigint | null }>>`
    SELECT count(*)::int AS "count",
           sum(hashtext("item_id" || chr(31) || "code" || chr(31) || "attribute" || chr(31) || "severity"
                        || chr(31) || coalesce("resolved_at"::text, ''))) AS "hash"
    FROM "gsf_item_issues"
  `
  return `${row?.count ?? 0}:${row?.hash ?? 0}`
}
