// Every SQL statement the Google Ads work runs.
//
// Kept together because the conventions only make sense read side by side, and
// because raw SQL is executed by no typechecker, no linter and no build - so
// this file has a live test of its own (lib/google-ads-sql.test.ts) that runs
// each statement against a real Postgres.
//
// The conventions, each of which has cost somebody a day somewhere:
//
//  - A DAY IS BOUND AS TEXT AND CAST IN SQL ('2026-09-23'::date), never as a JS
//    Date. A Date binds as a timestamp, and a timestamp cast to date is
//    whatever day it happens to be in the session's timezone.
//  - EVERY sum OVER A BIGINT COLUMN IS CAST BACK TO bigint. Postgres widens
//    sum(bigint) to numeric and Prisma hands numeric back as a Decimal, which
//    arithmetic silently turns into a string.
//  - ITEM IDS ARE JOINED THROUGH lower() ON BOTH SIDES. Google Ads returns
//    `segments.product_item_id` lower-cased whatever case the id has in
//    Merchant Center, so a plain `=` matches nothing and the spend column reads
//    as zero with no error anywhere. See migration 025.
//  - A figure Google did not report is NULL and is never summed as though it
//    were zero. The count of rows that DID report travels beside the sum.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { dayFromDate } from '@/modules/google-shopping-for-shop/lib/performance/days'
import { asUploadStatus, type UploadStatus } from '@/modules/google-shopping-for-shop/lib/google-ads/types'
import type { AdsSpendRow } from '@/modules/google-shopping-for-shop/lib/google-ads/parse'

/** How many rows go into one statement. A day of a large catalogue is a few
 *  thousand, which Postgres takes happily; the batch keeps a very large day
 *  from building a statement measured in megabytes. */
const BATCH = 500

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------

/**
 * A batch of daily spend rows, written idempotently.
 *
 * Re-running the same window overwrites each row with the same figures, which
 * is what makes the daily re-read of Google's unsettled days safe: no
 * accumulation, no doubling, nothing to clear out first.
 */
export async function writeAdsSpendRows(rows: readonly AdsSpendRow[], currency: string | null): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    // Casts on every column because a VALUES list has no target to borrow its
    // types from, and an untyped NULL in one would reach the conflict clause as
    // `text`.
    const values = rows.slice(i, i + BATCH).map((row) => Prisma.sql`(
      ${row.day}::date,
      ${row.itemId}::text,
      ${row.costMicros}::bigint,
      ${row.clicks}::bigint,
      ${row.impressions}::bigint,
      ${row.conversions}::double precision,
      ${row.conversionsValue}::double precision,
      ${currency}::text
    )`)
    await prisma.$executeRaw`
      INSERT INTO "gsf_ads_performance_daily"
        ("day", "item_id", "cost_micros", "clicks", "impressions", "conversions",
         "conversions_value", "currency", "imported_at")
      SELECT v."day", v."item_id", v."cost", v."clicks", v."impressions", v."conversions",
             v."conversions_value", v."currency", CURRENT_TIMESTAMP
      FROM (VALUES ${Prisma.join(values)})
        AS v("day", "item_id", "cost", "clicks", "impressions", "conversions", "conversions_value", "currency")
      ON CONFLICT ("day", "item_id") DO UPDATE SET
        "cost_micros" = EXCLUDED."cost_micros",
        "clicks" = EXCLUDED."clicks",
        "impressions" = EXCLUDED."impressions",
        "conversions" = EXCLUDED."conversions",
        "conversions_value" = EXCLUDED."conversions_value",
        "currency" = EXCLUDED."currency",
        "imported_at" = CURRENT_TIMESTAMP
    `
  }
}

/** Drops days before `olderThanDay`. A retention window of 0 means this is
 *  never called at all. */
export async function pruneAdsSpend(olderThanDay: string): Promise<number> {
  return prisma.$executeRaw`DELETE FROM "gsf_ads_performance_daily" WHERE "day" < ${olderThanDay}::date`
}

/** The oldest and newest day held, and how many rows, for "we have figures from
 *  X to Y". Nulls for an empty table, never a tidy zero range. */
export async function readAdsSpendExtent(): Promise<{ from: string | null; to: string | null; rows: number }> {
  const [row] = await prisma.$queryRaw<Array<{ from_day: Date | null; to_day: Date | null; rows: number }>>`
    SELECT min("day") AS "from_day", max("day") AS "to_day", count(*)::int AS "rows"
    FROM "gsf_ads_performance_daily"
  `
  return { from: dayFromDate(row?.from_day ?? null), to: dayFromDate(row?.to_day ?? null), rows: row?.rows ?? 0 }
}

export type AdsSpendTotals = {
  /** Money, in the account's currency. */
  cost: number
  clicks: number
  impressions: number
  /** Google Ads' own conversion count over the range, or null where it reported
   *  none at all. NOT this site's attributed sales. */
  conversions: number | null
  conversionsValue: number | null
  currency: string | null
  /** Days in the range that have any figures at all, so a screen can tell "no
   *  spend" from "not fetched yet". */
  daysHeld: number
}

export const EMPTY_ADS_SPEND: AdsSpendTotals = {
  cost: 0, clicks: 0, impressions: 0, conversions: null, conversionsValue: null, currency: null, daysHeld: 0,
}

/** Headline spend over a range. */
export async function readAdsSpendTotals(from: string, to: string): Promise<AdsSpendTotals> {
  const [row] = await prisma.$queryRaw<Array<{
    cost: bigint | null
    clicks: bigint | null
    impressions: bigint | null
    conversions: number | null
    conversion_rows: number
    conversions_value: number | null
    currency: string | null
    days_held: number
  }>>`
    SELECT sum("cost_micros")::bigint AS "cost",
           sum("clicks")::bigint AS "clicks",
           sum("impressions")::bigint AS "impressions",
           sum("conversions") AS "conversions",
           count("conversions")::int AS "conversion_rows",
           sum("conversions_value") AS "conversions_value",
           min("currency") AS "currency",
           count(DISTINCT "day")::int AS "days_held"
    FROM "gsf_ads_performance_daily"
    WHERE "day" BETWEEN ${from}::date AND ${to}::date
  `
  if (!row) return EMPTY_ADS_SPEND
  const reported = row.conversion_rows > 0
  return {
    cost: Number(row.cost ?? 0) / 1_000_000,
    clicks: Number(row.clicks ?? 0),
    impressions: Number(row.impressions ?? 0),
    conversions: reported ? Number(row.conversions ?? 0) : null,
    conversionsValue: reported ? Number(row.conversions_value ?? 0) : null,
    currency: row.currency,
    daysHeld: row.days_held,
  }
}

export type AdsSpendDay = { day: string; cost: number; clicks: number; impressions: number }

/** One point per day that has figures. Days with none are NOT filled in here:
 *  the caller knows the range and decides what an absent day means, because a
 *  day nothing was fetched for and a day of genuine nothing draw identically
 *  and only one of them is a fact. */
export async function readAdsSpendTrend(from: string, to: string): Promise<AdsSpendDay[]> {
  const rows = await prisma.$queryRaw<Array<{
    day: Date; cost: bigint | null; clicks: bigint | null; impressions: bigint | null
  }>>`
    SELECT "day",
           sum("cost_micros")::bigint AS "cost",
           sum("clicks")::bigint AS "clicks",
           sum("impressions")::bigint AS "impressions"
    FROM "gsf_ads_performance_daily"
    WHERE "day" BETWEEN ${from}::date AND ${to}::date
    GROUP BY "day"
    ORDER BY "day" ASC
  `
  const days: AdsSpendDay[] = []
  for (const row of rows) {
    const day = dayFromDate(row.day)
    if (!day) continue
    days.push({
      day,
      cost: Number(row.cost ?? 0) / 1_000_000,
      clicks: Number(row.clicks ?? 0),
      impressions: Number(row.impressions ?? 0),
    })
  }
  return days
}

export type AdsSpendItem = {
  itemId: string
  /** The title Merchant Center last told us it holds, where the two ids match.
   *  Null for an item that has left the feed, which still has spend against it
   *  and must still appear. */
  title: string | null
  cost: number
  clicks: number
  impressions: number
  conversions: number | null
}

/**
 * The most expensive items over a range, biggest spend first.
 *
 * Joined to the match snapshot through lower() on BOTH sides. Google Ads sends
 * the item id lower-cased; Merchant Center holds whatever the feed published.
 * A plain equality join here matched nothing at all for any shop whose product
 * ids carry a capital letter, and reported every title as blank.
 */
export async function readAdsSpendByItem(query: {
  from: string
  to: string
  limit: number
  offset: number
}): Promise<{ rows: AdsSpendItem[]; total: number }> {
  const rows = await prisma.$queryRaw<Array<{
    item_id: string
    title: string | null
    cost: bigint | null
    clicks: bigint | null
    impressions: bigint | null
    conversions: number | null
    conversion_rows: number
    total: number
  }>>`
    WITH "summed" AS (
      SELECT a."item_id",
             sum(a."cost_micros")::bigint AS "cost",
             sum(a."clicks")::bigint AS "clicks",
             sum(a."impressions")::bigint AS "impressions",
             sum(a."conversions") AS "conversions",
             count(a."conversions")::int AS "conversion_rows"
      FROM "gsf_ads_performance_daily" a
      WHERE a."day" BETWEEN ${query.from}::date AND ${query.to}::date
      GROUP BY a."item_id"
    )
    SELECT s."item_id",
           (SELECT m."merchant_title" FROM "gsf_item_match_status" m
             WHERE lower(m."item_id") = lower(s."item_id") LIMIT 1) AS "title",
           s."cost", s."clicks", s."impressions", s."conversions", s."conversion_rows",
           (count(*) OVER ())::int AS "total"
    FROM "summed" s
    ORDER BY s."cost" DESC NULLS LAST, s."item_id" ASC
    LIMIT ${query.limit} OFFSET ${query.offset}
  `
  return {
    total: rows[0]?.total ?? 0,
    rows: rows.map((row) => ({
      itemId: row.item_id,
      title: row.title,
      cost: Number(row.cost ?? 0) / 1_000_000,
      clicks: Number(row.clicks ?? 0),
      impressions: Number(row.impressions ?? 0),
      conversions: row.conversion_rows > 0 ? Number(row.conversions ?? 0) : null,
    })),
  }
}

// ---------------------------------------------------------------------------
// The run: brake and status stamp
// ---------------------------------------------------------------------------

/** A run that claimed the slot and did not let go within this many seconds is
 *  presumed dead and its claim may be taken. Matches the price push's own
 *  window, and the route budget it is protecting. */
const STALE_CLAIM_SECONDS = 300

export type AdsRunRow = {
  claimedAt: Date | null
  startedAt: Date | null
  finishedAt: Date | null
  status: 'ok' | 'part' | 'failed' | null
  uploaded: number
  failed: number
  skipped: number
  lastError: string | null
  spendCheckedAt: Date | null
  spendFailedAt: Date | null
  spendLastError: string | null
  spendImportedThrough: string | null
}

function asRunStatus(value: string | null): AdsRunRow['status'] {
  return value === 'ok' || value === 'part' || value === 'failed' ? value : null
}

export async function readAdsRun(): Promise<AdsRunRow> {
  const [row] = await prisma.$queryRaw<Array<{
    claimed_at: Date | null
    started_at: Date | null
    finished_at: Date | null
    status: string | null
    uploaded: number
    failed: number
    skipped: number
    last_error: string | null
    spend_checked_at: Date | null
    spend_failed_at: Date | null
    spend_last_error: string | null
    spend_imported_through: Date | null
  }>>`
    SELECT "claimed_at", "started_at", "finished_at", "status", "uploaded", "failed", "skipped",
           "last_error", "spend_checked_at", "spend_failed_at", "spend_last_error", "spend_imported_through"
    FROM "gsf_ads_run" WHERE "id" = 'singleton'
  `
  return {
    claimedAt: row?.claimed_at ?? null,
    startedAt: row?.started_at ?? null,
    finishedAt: row?.finished_at ?? null,
    status: asRunStatus(row?.status ?? null),
    uploaded: Number(row?.uploaded ?? 0),
    failed: Number(row?.failed ?? 0),
    skipped: Number(row?.skipped ?? 0),
    lastError: row?.last_error ?? null,
    spendCheckedAt: row?.spend_checked_at ?? null,
    spendFailedAt: row?.spend_failed_at ?? null,
    spendLastError: row?.spend_last_error ?? null,
    // Read through dayFromDate, which reads a DATE in UTC - the only way to get
    // the day that was stored rather than the day it is where this runs.
    spendImportedThrough: dayFromDate(row?.spend_imported_through ?? null),
  }
}

/**
 * Takes the upload slot, or says no.
 *
 * ONE statement, and it has to be. Every serverless invocation is its own
 * process, so a flag in this one stops none of the others - and two overlapping
 * runs would read the same eligible orders and upload each sale twice.
 */
export async function claimAdsRun(minGapSeconds = 0): Promise<boolean> {
  const gap = Math.max(0, Math.trunc(minGapSeconds))
  const claimed = await prisma.$executeRaw`
    UPDATE "gsf_ads_run"
    SET "claimed_at" = CURRENT_TIMESTAMP, "started_at" = CURRENT_TIMESTAMP
    WHERE "id" = 'singleton'
      -- Cast because make_interval takes its arguments by name, and a bare
      -- placeholder leaves Postgres unable to infer a type for one.
      AND ("claimed_at" IS NULL OR "claimed_at" < CURRENT_TIMESTAMP - make_interval(secs => ${STALE_CLAIM_SECONDS}::int))
      AND ("started_at" IS NULL OR "started_at" < CURRENT_TIMESTAMP - make_interval(secs => ${gap}::int))
  `
  return claimed > 0
}

/** Gives the slot back and stamps what happened. Only ever called by a run that
 *  reached the end, or by the catch that knows it did not - never by a caller
 *  that simply stopped looking. */
export async function releaseAdsRun(summary: {
  status: 'ok' | 'part' | 'failed'
  uploaded: number
  failed: number
  skipped: number
  message?: string
}): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "gsf_ads_run"
    SET "claimed_at" = NULL,
        "finished_at" = CURRENT_TIMESTAMP,
        "status" = ${summary.status},
        "uploaded" = ${summary.uploaded},
        "failed" = ${summary.failed},
        "skipped" = ${summary.skipped},
        "last_error" = ${summary.message?.slice(0, 1000) ?? null}
    WHERE "id" = 'singleton'
  `
}

/** Lets a claimed run go without stamping anything. For a run that found there
 *  was nothing to do after it had already taken the slot: the previous run's
 *  figures are still the last thing that happened, and overwriting them with
 *  zeroes would report a send that never took place. */
export async function abandonAdsRun(): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "gsf_ads_run" SET "claimed_at" = NULL WHERE "id" = 'singleton'
  `
}

/**
 * What the spend fetch managed.
 *
 * 'ok' moves the "last fetched" stamp and clears any recorded failure.
 * 'failed' does NEITHER: it records the failure and leaves the success stamp
 * exactly where it was, so no screen can ever report a fetch that did not
 * happen. The cursor is written on both, because whatever WAS read is in the
 * table either way.
 */
export async function recordAdsSpendCheck(input: {
  checkedAt: Date
  importedThrough: string | null
  outcome: 'ok' | 'failed'
  error?: string
}): Promise<void> {
  if (input.importedThrough !== null && !/^\d{4}-\d{2}-\d{2}$/.test(input.importedThrough)) {
    throw new Error(`Not a date the spend import can have reached: ${input.importedThrough}`)
  }
  const failed = input.outcome === 'failed'
  await prisma.$executeRaw`
    UPDATE "gsf_ads_run"
    SET "spend_checked_at" = CASE WHEN ${failed} THEN "spend_checked_at" ELSE ${input.checkedAt}::timestamp(3) END,
        "spend_failed_at" = CASE WHEN ${failed} THEN ${input.checkedAt}::timestamp(3) ELSE NULL END,
        -- Cut rather than refused: this is Google's own sentence and it only
        -- ever goes on a screen, but a stack trace in a TEXT column for ever is
        -- nobody's idea of an error message.
        "spend_last_error" = CASE WHEN ${failed} THEN ${input.error?.slice(0, 1000) ?? null}::text ELSE NULL END,
        "spend_imported_through" = ${input.importedThrough}::date
    WHERE "id" = 'singleton'
  `
}

// ---------------------------------------------------------------------------
// The conversion upload
// ---------------------------------------------------------------------------

export type UploadableOrder = {
  orderId: string
  orderNumber: string
  clickEventId: string
  clickId: string
  clickIdKind: string
  landedAt: Date
  confirmedAt: Date
  value: string
  currency: string
  /** How many times this order has already been refused. */
  attempts: number
}

/**
 * The paid, consented, confirmed sales Google Ads has not been told about.
 *
 * Every condition in the WHERE below is load-bearing, and the consent ones are
 * the reason the query exists at all rather than a cached list:
 *
 *   consented AND click_id IS NOT NULL
 *     The consent test happens HERE, at the moment of the upload, not at the
 *     moment of the landing. Withdrawing marketing consent sets both of these
 *     (lib/click-tracking/store.ts, forgetAttribution) in one transaction, so a
 *     shopper who withdrew an hour ago drops out of this list before anything
 *     is sent. Both are tested rather than either, because they are two
 *     independent promises and a bug in one must not silently retire the other.
 *
 *   source = 'paid'
 *     A free listing click has no Google Ads click to attach a conversion to.
 *
 *   click_id_kind IN ('gclid','gbraid','wbraid')
 *     `srsltid` is NOT a Google Ads click identifier - Google appends it to
 *     free Shopping clicks too, and ClickConversion has no field for it.
 *
 *   confirmed_at IS NOT NULL AND order_value IS NOT NULL
 *     Only money the shop itself has confirmed. The confirmation page alone is
 *     not a sale.
 *
 *   no upload row, or a refused one under the retry cap
 *     Idempotent by order id. An order that has been uploaded is never sent
 *     again; a 'skipped' one is never retried, because the reason it was
 *     skipped will not change on its own.
 */
export async function readUploadableOrders(limit: number, maxAttempts: number): Promise<UploadableOrder[]> {
  const rows = await prisma.$queryRaw<Array<{
    order_id: string
    order_number: string
    click_event_id: string
    click_id: string
    click_id_kind: string
    landed_at: Date
    confirmed_at: Date
    order_value: Prisma.Decimal
    currency: string
    attempts: number | null
  }>>`
    SELECT o."order_id", o."order_number", e."id" AS "click_event_id",
           e."click_id", e."click_id_kind", e."landed_at",
           o."confirmed_at", o."order_value", o."currency", u."attempts"
    FROM "gsf_attributed_orders" o
    JOIN "gsf_click_events" e ON e."id" = o."click_event_id"
    LEFT JOIN "gsf_ads_conversion_uploads" u ON u."order_id" = o."order_id"
    WHERE o."confirmed_at" IS NOT NULL
      AND o."order_value" IS NOT NULL
      AND o."currency" IS NOT NULL
      AND e."source" = 'paid'
      AND e."consented" = true
      AND e."click_id" IS NOT NULL
      AND e."click_id_kind" IN ('gclid', 'gbraid', 'wbraid')
      AND (u."order_id" IS NULL OR (u."status" = 'refused' AND u."attempts" < ${maxAttempts}::int))
    ORDER BY o."confirmed_at" ASC
    LIMIT ${limit}
  `
  return rows.map((row) => ({
    orderId: row.order_id,
    orderNumber: row.order_number,
    clickEventId: row.click_event_id,
    clickId: row.click_id,
    clickIdKind: row.click_id_kind,
    landedAt: row.landed_at,
    confirmedAt: row.confirmed_at,
    value: row.order_value.toString(),
    currency: row.currency,
    attempts: Number(row.attempts ?? 0),
  }))
}

/** How many sales are waiting to be sent. The same conditions as above, counted
 *  rather than fetched, so a run can decline to claim the slot at all. */
export async function countUploadableOrders(maxAttempts: number): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ waiting: number }>>`
    SELECT count(*)::int AS "waiting"
    FROM "gsf_attributed_orders" o
    JOIN "gsf_click_events" e ON e."id" = o."click_event_id"
    LEFT JOIN "gsf_ads_conversion_uploads" u ON u."order_id" = o."order_id"
    WHERE o."confirmed_at" IS NOT NULL
      AND o."order_value" IS NOT NULL
      AND o."currency" IS NOT NULL
      AND e."source" = 'paid'
      AND e."consented" = true
      AND e."click_id" IS NOT NULL
      AND e."click_id_kind" IN ('gclid', 'gbraid', 'wbraid')
      AND (u."order_id" IS NULL OR (u."status" = 'refused' AND u."attempts" < ${maxAttempts}::int))
  `
  return row?.waiting ?? 0
}

export type UploadOutcomeInput = {
  orderId: string
  orderNumber: string
  clickEventId: string
  status: UploadStatus
  conversionAction: string | null
  conversionDateTime: string | null
  value: string | null
  currency: string | null
  clickIdKind: string | null
  message?: string
  errorCode?: string | null
}

/**
 * Records what became of one order's upload.
 *
 * `attempts` is incremented on a refusal and on a refusal only. A success
 * leaves it where it is, and a skip does not count as a try: the retry cap is
 * there to stop a permanently-refused sale being offered to Google for ever,
 * not to count how many times we have looked at it.
 */
export async function recordUploadOutcome(input: UploadOutcomeInput): Promise<void> {
  const refused = input.status === 'refused'
  const uploaded = input.status === 'uploaded'
  const value = input.value === null ? null : new Prisma.Decimal(input.value)
  await prisma.$executeRaw`
    INSERT INTO "gsf_ads_conversion_uploads" (
      "order_id", "order_number", "click_event_id", "status", "attempts",
      "uploaded_at", "failed_at", "last_error", "error_code",
      "conversion_action", "conversion_date_time", "value", "currency", "click_id_kind"
    )
    VALUES (
      ${input.orderId}::text, ${input.orderNumber}::text, ${input.clickEventId}::text,
      ${input.status}::text, ${refused ? 1 : 0}::int,
      CASE WHEN ${uploaded} THEN CURRENT_TIMESTAMP ELSE NULL END,
      CASE WHEN ${refused} THEN CURRENT_TIMESTAMP ELSE NULL END,
      ${input.message?.slice(0, 1000) ?? null}::text,
      ${input.errorCode ?? null}::text,
      ${input.conversionAction}::text, ${input.conversionDateTime}::text,
      ${value}::decimal, ${input.currency}::text, ${input.clickIdKind}::text
    )
    ON CONFLICT ("order_id") DO UPDATE SET
      "status" = EXCLUDED."status",
      "attempts" = "gsf_ads_conversion_uploads"."attempts" + CASE WHEN ${refused} THEN 1 ELSE 0 END,
      "uploaded_at" = CASE WHEN ${uploaded} THEN CURRENT_TIMESTAMP ELSE "gsf_ads_conversion_uploads"."uploaded_at" END,
      "failed_at" = CASE WHEN ${refused} THEN CURRENT_TIMESTAMP ELSE NULL END,
      "last_error" = EXCLUDED."last_error",
      "error_code" = EXCLUDED."error_code",
      "conversion_action" = EXCLUDED."conversion_action",
      "conversion_date_time" = EXCLUDED."conversion_date_time",
      "value" = EXCLUDED."value",
      "currency" = EXCLUDED."currency",
      "click_id_kind" = EXCLUDED."click_id_kind"
  `
}

export type UploadTotals = { uploaded: number; refused: number; skipped: number }

export async function readUploadTotals(): Promise<UploadTotals> {
  const [row] = await prisma.$queryRaw<Array<{ uploaded: number; refused: number; skipped: number }>>`
    SELECT count(*) FILTER (WHERE "status" = 'uploaded')::int AS "uploaded",
           count(*) FILTER (WHERE "status" = 'refused')::int AS "refused",
           count(*) FILTER (WHERE "status" = 'skipped')::int AS "skipped"
    FROM "gsf_ads_conversion_uploads"
  `
  return { uploaded: row?.uploaded ?? 0, refused: row?.refused ?? 0, skipped: row?.skipped ?? 0 }
}

export type UploadRecord = {
  orderId: string
  orderNumber: string
  status: UploadStatus
  attempts: number
  at: string | null
  value: number | null
  currency: string | null
  message: string | null
  errorCode: string | null
}

function toRecord(row: {
  order_id: string
  order_number: string
  status: string
  attempts: number
  uploaded_at: Date | null
  failed_at: Date | null
  value: Prisma.Decimal | null
  currency: string | null
  last_error: string | null
  error_code: string | null
}): UploadRecord {
  return {
    orderId: row.order_id,
    orderNumber: row.order_number,
    status: asUploadStatus(row.status),
    attempts: Number(row.attempts),
    at: (row.uploaded_at ?? row.failed_at)?.toISOString() ?? null,
    value: row.value === null ? null : Number(row.value),
    currency: row.currency,
    message: row.last_error,
    errorCode: row.error_code,
  }
}

/** The most recent sales Google took, newest first. */
export async function readRecentUploads(limit: number): Promise<UploadRecord[]> {
  const rows = await prisma.$queryRaw<Parameters<typeof toRecord>[0][]>`
    SELECT "order_id", "order_number", "status", "attempts", "uploaded_at", "failed_at",
           "value", "currency", "last_error", "error_code"
    FROM "gsf_ads_conversion_uploads"
    WHERE "status" = 'uploaded'
    ORDER BY "uploaded_at" DESC NULLS LAST
    LIMIT ${limit}
  `
  return rows.map(toRecord)
}

/** The ones Google would not take, and the ones this site declined to send.
 *  Together, because to an owner they are one question: what has not got
 *  through? The status on each row says which kind it is. */
export async function readUploadProblems(limit: number): Promise<UploadRecord[]> {
  const rows = await prisma.$queryRaw<Parameters<typeof toRecord>[0][]>`
    SELECT "order_id", "order_number", "status", "attempts", "uploaded_at", "failed_at",
           "value", "currency", "last_error", "error_code"
    FROM "gsf_ads_conversion_uploads"
    WHERE "status" IN ('refused', 'skipped')
    ORDER BY "failed_at" DESC NULLS LAST, "order_number" DESC
    LIMIT ${limit}
  `
  return rows.map(toRecord)
}

/**
 * This site's own attributed PAID sales over a span, for the cost per sale.
 *
 * Deliberately the site's own figure rather than Google Ads' `conversions`
 * metric. The two count different things - Google's includes whatever that
 * account's own tracking reports, from the browser tag and from anybody else's
 * uploads - and mixing them would produce a cost per sale that belongs to
 * neither.
 *
 * Bound as two instants rather than as dates: a landing is a timestamp, and the
 * span has already been worked out in the site's own timezone by the caller.
 */
export async function readAttributedPaidSales(start: Date, end: Date): Promise<{ orders: number; revenue: number }> {
  const [row] = await prisma.$queryRaw<Array<{ orders: bigint; revenue: Prisma.Decimal | null }>>`
    SELECT count(*)::bigint AS "orders", COALESCE(sum(o."order_value"), 0)::decimal AS "revenue"
    FROM "gsf_attributed_orders" o
    JOIN "gsf_click_events" e ON e."id" = o."click_event_id"
    WHERE o."confirmed_at" IS NOT NULL
      AND e."source" = 'paid'
      AND e."landed_at" >= ${start} AND e."landed_at" < ${end}
  `
  return { orders: Number(row?.orders ?? 0), revenue: Number(row?.revenue ?? 0) }
}
