// Reading and writing gsf_performance_daily.
//
// Every statement here is raw SQL, which no typechecker, linter or build ever
// executes - so this file has a live test of its own (lib/performance-sql.test.ts)
// that runs each one against a real database.
//
// Two conventions, each of which has already cost somebody a day somewhere:
//
//  - A DAY IS BOUND AS TEXT AND CAST IN SQL ('2026-09-23'::date), never as a JS
//    Date. A Date binds as a timestamp, and a timestamp cast to date depends on
//    the session's timezone - which would make the figures for the 23rd land on
//    the 22nd on a server west of Greenwich and nowhere at all on one east.
//
//  - EVERY sum OVER A BIGINT COLUMN IS CAST BACK TO bigint. Postgres widens
//    sum(bigint) to numeric, and Prisma hands numeric back as a Decimal object
//    rather than a number - which arithmetic silently turns into a string.
//
// The honesty rule from the Health tab holds throughout: a figure Google does
// not report is NULL, and NULL is never added up as though it were zero. The
// count of rows that DID report a conversion travels beside the sum, so
// "nothing converted" and "Google does not report conversions here" stay two
// different answers.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { dayFromDate } from '@/modules/google-shopping-for-shop/lib/performance/days'
import {
  rateOf,
  storedMarketingMethod,
  type MarketingMethod,
  type ProductSort,
  type PerformanceRow,
  type PerformanceTotals,
} from '@/modules/google-shopping-for-shop/lib/performance/types'

/** How many rows go into one statement. A day of a large catalogue is a few
 *  thousand; Postgres takes a VALUES list of that size happily, and the batch
 *  keeps a very large day from building a statement measured in megabytes. */
const BATCH = 500

/** The escape character for a LIKE pattern. A backslash would be the usual
 *  choice and is a menace inside a template literal, where it has to be
 *  doubled to survive; an exclamation mark cannot be mistaken for anything. */
const LIKE_ESCAPE = '!'

/** The ESCAPE clause, as literal SQL. Not interpolated: Prisma binds anything
 *  in a template literal as a parameter, and Postgres wants a constant here.
 *  The value is the module constant above, never anything from a request. */
const ESCAPE_CLAUSE = Prisma.raw(`ESCAPE '${LIKE_ESCAPE}'`)

/** An owner's search text as a LIKE pattern, with the wildcards they did not
 *  mean neutralised. Without this a lone underscore matches any character and
 *  a per cent sign matches the whole catalogue. */
export function likePattern(search: string): string | null {
  const trimmed = search.trim()
  if (trimmed === '') return null
  return `%${trimmed.replace(/[!%_]/g, (char) => `${LIKE_ESCAPE}${char}`)}%`
}

/**
 * A batch of rows, written idempotently.
 *
 * Re-running the same window overwrites each row with the same figures, which
 * is what makes the daily re-read of Google's unsettled days safe: no
 * accumulation, no doubling, no need to clear the window out first.
 */
export async function writePerformanceRows(rows: readonly PerformanceRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    // Casts on every column because a VALUES list has no target to borrow its
    // types from, and an untyped NULL in one would reach the conflict clause
    // as `text`.
    const values = rows.slice(i, i + BATCH).map((row) => Prisma.sql`(
      ${row.day}::date,
      ${row.itemId}::text,
      ${row.method}::text,
      ${row.clicks}::bigint,
      ${row.impressions}::bigint,
      ${row.clickThroughRate}::double precision,
      ${row.conversions}::double precision,
      ${row.conversionValueMicros}::bigint,
      ${row.conversionCurrency}::text
    )`)
    await prisma.$executeRaw`
      INSERT INTO "gsf_performance_daily"
        ("day", "item_id", "marketing_method", "clicks", "impressions", "click_through_rate",
         "conversions", "conversion_value_micros", "conversion_currency", "imported_at")
      SELECT v."day", v."item_id", v."method", v."clicks", v."impressions", v."ctr",
             v."conversions", v."value_micros", v."currency", CURRENT_TIMESTAMP
      FROM (VALUES ${Prisma.join(values)})
        AS v("day", "item_id", "method", "clicks", "impressions", "ctr", "conversions", "value_micros", "currency")
      ON CONFLICT ("day", "item_id", "marketing_method") DO UPDATE SET
        "clicks" = EXCLUDED."clicks",
        "impressions" = EXCLUDED."impressions",
        "click_through_rate" = EXCLUDED."click_through_rate",
        "conversions" = EXCLUDED."conversions",
        "conversion_value_micros" = EXCLUDED."conversion_value_micros",
        "conversion_currency" = EXCLUDED."conversion_currency",
        "imported_at" = CURRENT_TIMESTAMP
    `
  }
}

/** Drops days before `olderThanDay`. The caller decides what that is; 0 days
 *  of retention means it is never called at all. */
export async function prunePerformance(olderThanDay: string): Promise<number> {
  return prisma.$executeRaw`DELETE FROM "gsf_performance_daily" WHERE "day" < ${olderThanDay}::date`
}

/** The oldest and newest day we hold anything for, or nulls for an empty table. */
export async function readPerformanceExtent(): Promise<{ from: string | null; to: string | null; rows: number }> {
  const [row] = await prisma.$queryRaw<Array<{ from_day: Date | null; to_day: Date | null; rows: number }>>`
    SELECT min("day") AS "from_day", max("day") AS "to_day", count(*)::int AS "rows"
    FROM "gsf_performance_daily"
  `
  return {
    from: dayFromDate(row?.from_day ?? null),
    to: dayFromDate(row?.to_day ?? null),
    rows: row?.rows ?? 0,
  }
}

type TotalsRow = {
  marketing_method: string
  clicks: bigint | null
  impressions: bigint | null
  conversions: number | null
  conversion_rows: number
  value_micros: bigint | null
  currency: string | null
}

function totalsFromRow(row: TotalsRow | undefined): PerformanceTotals {
  const clicks = Number(row?.clicks ?? 0)
  const impressions = Number(row?.impressions ?? 0)
  // No row in the span carried a conversions figure at all, so Google does not
  // report them here. Not the same as none having happened.
  const reported = (row?.conversion_rows ?? 0) > 0
  return {
    clicks,
    impressions,
    clickThroughRate: rateOf(clicks, impressions),
    conversions: reported ? Number(row?.conversions ?? 0) : null,
    conversionValue: reported && row?.value_micros != null ? Number(row.value_micros) / 1_000_000 : null,
    conversionCurrency: reported ? row?.currency ?? null : null,
  }
}

export const EMPTY_BY_METHOD: Record<MarketingMethod, PerformanceTotals> = {
  organic: totalsFromRow(undefined),
  ads: totalsFromRow(undefined),
  unknown: totalsFromRow(undefined),
}

/** Headline figures for a range, kept apart by marketing method. */
export async function readTotalsByMethod(from: string, to: string): Promise<Record<MarketingMethod, PerformanceTotals>> {
  const rows = await prisma.$queryRaw<TotalsRow[]>`
    SELECT "marketing_method",
           sum("clicks")::bigint AS "clicks",
           sum("impressions")::bigint AS "impressions",
           sum("conversions") AS "conversions",
           count("conversions")::int AS "conversion_rows",
           sum("conversion_value_micros")::bigint AS "value_micros",
           min("conversion_currency") AS "currency"
    FROM "gsf_performance_daily"
    WHERE "day" BETWEEN ${from}::date AND ${to}::date
    GROUP BY "marketing_method"
  `
  const byMethod: Record<MarketingMethod, PerformanceTotals> = {
    organic: totalsFromRow(undefined),
    ads: totalsFromRow(undefined),
    unknown: totalsFromRow(undefined),
  }
  for (const row of rows) byMethod[storedMarketingMethod(row.marketing_method)] = totalsFromRow(row)
  return byMethod
}

export type TrendPoint = {
  day: string
  organic: { clicks: number; impressions: number }
  ads: { clicks: number; impressions: number }
}

/**
 * One point per day that has figures, free and paid side by side.
 *
 * Days with no rows at all are NOT filled in here - the caller knows the range
 * and decides what an absent day means, because a day nothing was imported for
 * and a day of genuine zeroes draw identically and only one of them is a fact.
 */
export async function readTrend(from: string, to: string): Promise<TrendPoint[]> {
  const rows = await prisma.$queryRaw<Array<{
    day: Date
    marketing_method: string
    clicks: bigint | null
    impressions: bigint | null
  }>>`
    SELECT "day", "marketing_method",
           sum("clicks")::bigint AS "clicks",
           sum("impressions")::bigint AS "impressions"
    FROM "gsf_performance_daily"
    WHERE "day" BETWEEN ${from}::date AND ${to}::date
    GROUP BY "day", "marketing_method"
    ORDER BY "day" ASC
  `
  const byDay = new Map<string, TrendPoint>()
  for (const row of rows) {
    const day = dayFromDate(row.day)
    if (!day) continue
    let point = byDay.get(day)
    if (!point) {
      point = { day, organic: { clicks: 0, impressions: 0 }, ads: { clicks: 0, impressions: 0 } }
      byDay.set(day, point)
    }
    const method = storedMarketingMethod(row.marketing_method)
    // An 'unknown' method is counted into neither side rather than guessed
    // into one of them. The headline totals above still carry it.
    if (method === 'organic' || method === 'ads') {
      point[method].clicks += Number(row.clicks ?? 0)
      point[method].impressions += Number(row.impressions ?? 0)
    }
  }
  return [...byDay.values()]
}

export type ProductPerformanceRow = {
  itemId: string
  /** The title Google last told us it holds for this item, where it has. Never
   *  the title that was showing at the time of the click: the performance
   *  report does carry one, and asking for it would split a day's clicks
   *  across a title change (see migration 022). */
  title: string | null
  clicks: number
  impressions: number
  clickThroughRate: number | null
  conversions: number | null
  conversionValue: number | null
  conversionCurrency: string | null
  /** What Google's benchmark says the same thing usually sells for, from the
   *  match snapshot the daily check already writes. Null where Google has
   *  never given one for this item. */
  benchmarkAmount: number | null
  benchmarkCurrency: string | null
}

/**
 * The per-product table: one row per item over the range, biggest first.
 *
 * Joined to the match snapshot rather than to the catalogue, because the whole
 * point of this table is what GOOGLE reports - including for an item that has
 * since left the feed, which the catalogue no longer knows anything about.
 */
export async function readProductPerformance(query: {
  from: string
  to: string
  limit: number
  offset: number
  sort: ProductSort
  search: string
}): Promise<{ rows: ProductPerformanceRow[]; total: number }> {
  const like = likePattern(query.search)

  // Ordering is CHOSEN from a fixed list, never built from the request: the
  // sort arrives as one of four known words and each maps to a fragment
  // written out here in full.
  const order = {
    clicks: Prisma.sql`"clicks" DESC NULLS LAST, "item_id" ASC`,
    impressions: Prisma.sql`"impressions" DESC NULLS LAST, "item_id" ASC`,
    ctr: Prisma.sql`"ctr" DESC NULLS LAST, "item_id" ASC`,
    conversions: Prisma.sql`"conversions" DESC NULLS LAST, "item_id" ASC`,
  }[query.sort]

  const rows = await prisma.$queryRaw<Array<{
    item_id: string
    title: string | null
    clicks: bigint | null
    impressions: bigint | null
    ctr: number | null
    conversions: number | null
    conversion_rows: number
    value_micros: bigint | null
    currency: string | null
    benchmark_amount_micros: string | null
    benchmark_currency: string | null
    total: number
  }>>`
    WITH "summed" AS (
      SELECT p."item_id",
             sum(p."clicks")::bigint AS "clicks",
             sum(p."impressions")::bigint AS "impressions",
             CASE WHEN sum(p."impressions") > 0
                  THEN sum(p."clicks")::double precision / sum(p."impressions")::double precision
                  ELSE NULL END AS "ctr",
             sum(p."conversions") AS "conversions",
             count(p."conversions")::int AS "conversion_rows",
             sum(p."conversion_value_micros")::bigint AS "value_micros",
             min(p."conversion_currency") AS "currency"
      FROM "gsf_performance_daily" p
      WHERE p."day" BETWEEN ${query.from}::date AND ${query.to}::date
      GROUP BY p."item_id"
    ),
    "joined" AS (
      SELECT s.*,
             m."merchant_title" AS "title",
             m."benchmark_amount_micros"::text AS "benchmark_amount_micros",
             m."benchmark_currency" AS "benchmark_currency"
      FROM "summed" s
      LEFT JOIN "gsf_item_match_status" m ON m."item_id" = s."item_id"
      WHERE ${like}::text IS NULL
         OR s."item_id" ILIKE ${like}::text ${ESCAPE_CLAUSE}
         OR coalesce(m."merchant_title", '') ILIKE ${like}::text ${ESCAPE_CLAUSE}
    )
    SELECT "item_id", "title", "clicks", "impressions", "ctr", "conversions", "conversion_rows",
           "value_micros", "currency", "benchmark_amount_micros", "benchmark_currency",
           (count(*) OVER ())::int AS "total"
    FROM "joined"
    ORDER BY ${order}
    LIMIT ${query.limit} OFFSET ${query.offset}
  `

  return {
    total: rows[0]?.total ?? 0,
    rows: rows.map((row) => {
      const reported = row.conversion_rows > 0
      const benchmark = row.benchmark_amount_micros
      return {
        itemId: row.item_id,
        title: row.title,
        clicks: Number(row.clicks ?? 0),
        impressions: Number(row.impressions ?? 0),
        clickThroughRate: row.ctr,
        conversions: reported ? Number(row.conversions ?? 0) : null,
        conversionValue: reported && row.value_micros != null ? Number(row.value_micros) / 1_000_000 : null,
        conversionCurrency: reported ? row.currency : null,
        benchmarkAmount: benchmark != null && /^-?\d+$/.test(benchmark) ? Number(benchmark) / 1_000_000 : null,
        benchmarkCurrency: row.benchmark_currency,
      }
    }),
  }
}
