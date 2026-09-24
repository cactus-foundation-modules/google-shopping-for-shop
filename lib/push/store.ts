// Every database read and write the live price and stock updates make.
//
// Three tables, migration 024:
//   gsf_push_queue  products whose price or availability has moved and not yet
//                   been sent
//   gsf_push_state  our latest ATTEMPT per feed item - what we tried to set,
//                   whether Google acknowledged it, and what the sample check
//                   made of it afterwards
//   gsf_push_run    one row: the claim that stops two runs overlapping, and the
//                   stamp of how the last one went
//
// The claim is a database UPDATE with a condition, never a variable in this
// process. On serverless there is no "this process" to guard - the next request
// may be answered by a different machine that has never heard of the first -
// and an in-process brake is therefore no brake at all. Same shape as
// lib/health/explain.ts's claimExplainSlot.
import { prisma } from '@/lib/db/prisma'
import type { PushRunSummary, PushSnapshot } from '@/modules/google-shopping-for-shop/lib/push/types'
import { isGoogleAvailability } from '@/modules/google-shopping-for-shop/lib/push/types'

/** A run that claimed the slot and never let go is assumed dead after this. A
 *  module route has sixty seconds, so five minutes is well past any run that is
 *  still breathing. */
const STALE_CLAIM_SECONDS = 300

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export type QueuedProduct = {
  productId: string
  queuedAt: Date
  reason: string
  /** How many times this product has been queued. It is the VERSION of the
   *  entry, and it is what makes "has this been queued again since I read it?"
   *  answerable - see clearQueued. */
  queuedCount: number
}

/**
 * Puts products in the queue, or bumps the ones already there.
 *
 * `queued_at` is NOT moved on a repeat: a product edited every few seconds
 * would otherwise keep pushing itself to the back of the queue and never be
 * sent at all. `queued_count` moves instead, and it does two jobs - it tells
 * the screen this one has been fiddled with nine times, and it is the VERSION
 * that lets clearQueued tell "dealt with" from "changed again while I was
 * dealing with it". Nothing may stop bumping it.
 */
export async function queueProducts(productIds: readonly string[], reason: string): Promise<number> {
  const ids = [...new Set(productIds.filter((id) => typeof id === 'string' && id.trim() !== ''))]
  if (ids.length === 0) return 0
  const trimmed = reason.slice(0, 200)
  let written = 0
  for (const productId of ids) {
    written += await prisma.$executeRaw`
      INSERT INTO "gsf_push_queue" ("product_id", "reason")
      VALUES (${productId}, ${trimmed})
      ON CONFLICT ("product_id") DO UPDATE
      SET "queued_count" = "gsf_push_queue"."queued_count" + 1,
          "reason" = EXCLUDED."reason"
    `
  }
  return written
}

export async function queueDepth(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "gsf_push_queue"`
  return Number(rows[0]?.count ?? 0)
}

/** The oldest queued products, up to `limit`. Read, not removed: a run that
 *  dies half way must leave its work in the queue for the next one. */
export async function readQueue(limit: number): Promise<QueuedProduct[]> {
  const take = Math.min(Math.max(1, Math.trunc(limit)), 5000)
  const rows = await prisma.$queryRaw<Array<{ product_id: string; queued_at: Date; reason: string; queued_count: number }>>`
    SELECT "product_id", "queued_at", "reason", "queued_count"
    FROM "gsf_push_queue"
    ORDER BY "queued_at" ASC, "product_id" ASC
    LIMIT ${take}
  `
  return rows.map((row) => ({
    productId: row.product_id,
    queuedAt: row.queued_at,
    reason: row.reason,
    queuedCount: Number(row.queued_count),
  }))
}

/**
 * Takes products back out of the queue once they have been dealt with.
 *
 * Only if they have not been queued AGAIN since they were read, and the test
 * for that is `queued_count`, NOT `queued_at`.
 *
 * This is subtle and it was wrong the first time. `queued_at` deliberately does
 * not move on a repeat (see queueProducts, and the starvation it prevents), so
 * a product re-queued while the run was in flight still carries the timestamp
 * the run read - and a `queued_at <= ?` test would happily delete it. The run
 * had already sent the pre-change price, nothing would queue the new one again,
 * and the shop would advertise the old price until something else happened to
 * that product. The window is the whole feed build plus the sending budget, so
 * it is tens of seconds, not milliseconds.
 *
 * The count is the version: the upsert bumps it, this only deletes the exact
 * version it was handed, and anything re-queued since survives with its
 * original `queued_at` and goes to the front of the next run.
 */
export async function clearQueued(entries: readonly QueuedProduct[]): Promise<number> {
  let cleared = 0
  for (const entry of entries) {
    cleared += await prisma.$executeRaw`
      DELETE FROM "gsf_push_queue"
      WHERE "product_id" = ${entry.productId} AND "queued_count" = ${entry.queuedCount}
    `
  }
  return cleared
}

// ---------------------------------------------------------------------------
// What we believe we sent
// ---------------------------------------------------------------------------

export type PushStateRow = {
  itemId: string
  /** The listing this item belongs to - the variation parent's product id, or
   *  the item's own id where there are no variations. What the queue holds. */
  parentId: string
  snapshot: PushSnapshot
  sentAt: Date
  confirmed: boolean
  lastError: string | null
  failedAt: Date | null
  reconciledAt: Date | null
  reconcileResult: 'agrees' | 'differs' | null
  reconcileDetail: unknown
}

type RawStateRow = {
  item_id: string
  parent_id: string
  price: unknown
  sale_price: unknown
  currency: string
  availability: string
  sent_at: Date
  confirmed: boolean
  last_error: string | null
  failed_at: Date | null
  reconciled_at: Date | null
  reconcile_result: string | null
  reconcile_detail: unknown
}

/** NUMERIC comes back from Prisma as a Prisma.Decimal, not a number. Number()
 *  on it is correct and Number() on a float would be a no-op, so this is safe
 *  either way - but reading it as a number without the conversion is not. */
function amount(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value)
}

function toStateRow(row: RawStateRow): PushStateRow {
  const availability = row.availability.toUpperCase()
  const sale = row.sale_price === null || row.sale_price === undefined ? null : Number(row.sale_price)
  return {
    itemId: row.item_id,
    // A row written before the column existed carries '', which reads as "no
    // listing recorded" rather than as a listing whose id is empty.
    parentId: row.parent_id || row.item_id,
    snapshot: {
      price: amount(row.price),
      ...(sale === null ? {} : { salePrice: sale }),
      currency: row.currency,
      // A row written by a build that spelled it differently must not crash the
      // screen. An unrecognised value reads as OUT_OF_STOCK, which is the safe
      // direction: it can only cause a resend, never a silent agreement.
      availability: isGoogleAvailability(availability) ? availability : 'OUT_OF_STOCK',
    },
    sentAt: row.sent_at,
    confirmed: row.confirmed,
    lastError: row.last_error,
    failedAt: row.failed_at,
    reconciledAt: row.reconciled_at,
    reconcileResult: row.reconcile_result === 'agrees' || row.reconcile_result === 'differs' ? row.reconcile_result : null,
    reconcileDetail: row.reconcile_detail,
  }
}

const STATE_COLUMNS = `"item_id", "parent_id", "price", "sale_price", "currency", "availability", "sent_at", "confirmed",
  "last_error", "failed_at", "reconciled_at", "reconcile_result", "reconcile_detail"`

/** Every item we have ever sent, keyed by feed item id. A catalogue's worth of
 *  four small columns; read whole because the run compares every built item
 *  against it. */
export async function readAllPushState(): Promise<Map<string, PushStateRow>> {
  const rows = await prisma.$queryRawUnsafe<RawStateRow[]>(`SELECT ${STATE_COLUMNS} FROM "gsf_push_state"`)
  return new Map(rows.map((row) => [row.item_id, toStateRow(row)]))
}

/** Records a send that Google took. `confirmed` false means the write went
 *  through and the reply could not be read back - recorded as exactly that, and
 *  never as a success. */
export async function recordSent(itemId: string, parentId: string, snapshot: PushSnapshot, confirmed: boolean): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "gsf_push_state" (
      "item_id", "parent_id", "price", "sale_price", "currency", "availability", "sent_at", "confirmed",
      "last_error", "failed_at", "reconciled_at", "reconcile_result", "reconcile_detail"
    )
    VALUES (
      ${itemId}, ${parentId}, ${snapshot.price}::numeric, ${snapshot.salePrice ?? null}::numeric, ${snapshot.currency},
      ${snapshot.availability}, CURRENT_TIMESTAMP, ${confirmed}, NULL, NULL, NULL, NULL, NULL
    )
    ON CONFLICT ("item_id") DO UPDATE SET
      "parent_id" = EXCLUDED."parent_id",
      "price" = EXCLUDED."price",
      "sale_price" = EXCLUDED."sale_price",
      "currency" = EXCLUDED."currency",
      "availability" = EXCLUDED."availability",
      "sent_at" = EXCLUDED."sent_at",
      "confirmed" = EXCLUDED."confirmed",
      "last_error" = NULL,
      "failed_at" = NULL,
      -- A new send makes the last comparison meaningless: it was about figures
      -- that are no longer the ones we are claiming.
      "reconciled_at" = NULL,
      "reconcile_result" = NULL,
      "reconcile_detail" = NULL
  `
}

/**
 * Records an attempt Google refused.
 *
 * The attempted figures are stored, not the last good ones: the row means "our
 * latest attempt", and a failed row is retried next run precisely because it
 * does not read as a clean send. `confirmed` is false and `failed_at` is set,
 * so nothing anywhere can mistake this for a success.
 */
export async function recordFailed(itemId: string, parentId: string, snapshot: PushSnapshot, message: string): Promise<void> {
  const text = message.slice(0, 1000)
  await prisma.$executeRaw`
    INSERT INTO "gsf_push_state" (
      "item_id", "parent_id", "price", "sale_price", "currency", "availability", "sent_at", "confirmed", "last_error", "failed_at"
    )
    VALUES (
      ${itemId}, ${parentId}, ${snapshot.price}::numeric, ${snapshot.salePrice ?? null}::numeric, ${snapshot.currency},
      ${snapshot.availability}, CURRENT_TIMESTAMP, false, ${text}, CURRENT_TIMESTAMP
    )
    ON CONFLICT ("item_id") DO UPDATE SET
      "parent_id" = EXCLUDED."parent_id",
      "price" = EXCLUDED."price",
      "sale_price" = EXCLUDED."sale_price",
      "currency" = EXCLUDED."currency",
      "availability" = EXCLUDED."availability",
      "confirmed" = false,
      "last_error" = EXCLUDED."last_error",
      "failed_at" = CURRENT_TIMESTAMP,
      "reconciled_at" = NULL,
      "reconcile_result" = NULL,
      "reconcile_detail" = NULL
  `
}

/** Forgets items we have taken back out of the supplemental source. */
export async function forgetItems(itemIds: readonly string[]): Promise<number> {
  let removed = 0
  for (const itemId of itemIds) {
    removed += await prisma.$executeRaw`DELETE FROM "gsf_push_state" WHERE "item_id" = ${itemId}`
  }
  return removed
}

/**
 * The items the hourly check should ask Google about.
 *
 * Least recently checked first, never checked ahead of all of them, and nothing
 * sent within the grace period: Merchant Center processes a product input
 * asynchronously, so an item asked about a minute after it was sent disagrees
 * for a perfectly innocent reason and would be reported as drift.
 */
export async function sampleForReconcile(limit: number, graceMinutes: number): Promise<PushStateRow[]> {
  const take = Math.min(Math.max(0, Math.trunc(limit)), 200)
  if (take === 0) return []
  const minutes = Math.max(0, Math.trunc(graceMinutes))
  const rows = await prisma.$queryRawUnsafe<RawStateRow[]>(
    `SELECT ${STATE_COLUMNS} FROM "gsf_push_state"
     WHERE "failed_at" IS NULL
       AND "sent_at" < CURRENT_TIMESTAMP - make_interval(mins => $1::int)
     ORDER BY "reconciled_at" ASC NULLS FIRST, "sent_at" ASC
     LIMIT $2::int`,
    minutes,
    take,
  )
  return rows.map(toStateRow)
}

/** What one comparison found. `detail` is only written on a disagreement - a
 *  row that agrees has nothing worth keeping and the screen says so. */
export async function recordReconcile(itemId: string, result: 'agrees' | 'differs', detail: unknown): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "gsf_push_state"
    SET "reconciled_at" = CURRENT_TIMESTAMP,
        "reconcile_result" = ${result},
        "reconcile_detail" = ${detail === undefined ? null : JSON.stringify(detail)}::jsonb
    WHERE "item_id" = ${itemId}
  `
}

export type PushTotals = {
  tracked: number
  unconfirmed: number
  failed: number
  differs: number
  /** Null when nothing has ever been compared. NOT the same as "they all agree". */
  reconciledAt: Date | null
}

export async function readPushTotals(): Promise<PushTotals> {
  const rows = await prisma.$queryRaw<Array<{ tracked: bigint; unconfirmed: bigint; failed: bigint; differs: bigint; reconciled_at: Date | null }>>`
    SELECT COUNT(*)::bigint AS tracked,
           COUNT(*) FILTER (WHERE "confirmed" = false AND "failed_at" IS NULL)::bigint AS unconfirmed,
           COUNT(*) FILTER (WHERE "failed_at" IS NOT NULL)::bigint AS failed,
           COUNT(*) FILTER (WHERE "reconcile_result" = 'differs')::bigint AS differs,
           MAX("reconciled_at") AS reconciled_at
    FROM "gsf_push_state"
  `
  const row = rows[0]
  return {
    tracked: Number(row?.tracked ?? 0),
    unconfirmed: Number(row?.unconfirmed ?? 0),
    failed: Number(row?.failed ?? 0),
    differs: Number(row?.differs ?? 0),
    reconciledAt: row?.reconciled_at ?? null,
  }
}

/** The most recent refusals, for the panel. Newest first. */
export async function readRecentFailures(limit: number): Promise<PushStateRow[]> {
  const take = Math.min(Math.max(1, Math.trunc(limit)), 100)
  const rows = await prisma.$queryRawUnsafe<RawStateRow[]>(
    `SELECT ${STATE_COLUMNS} FROM "gsf_push_state"
     WHERE "failed_at" IS NOT NULL
     ORDER BY "failed_at" DESC
     LIMIT $1::int`,
    take,
  )
  return rows.map(toStateRow)
}

/** The items Google is holding something different for. Newest comparison first. */
export async function readDisagreements(limit: number): Promise<PushStateRow[]> {
  const take = Math.min(Math.max(1, Math.trunc(limit)), 100)
  const rows = await prisma.$queryRawUnsafe<RawStateRow[]>(
    `SELECT ${STATE_COLUMNS} FROM "gsf_push_state"
     WHERE "reconcile_result" = 'differs'
     ORDER BY "reconciled_at" DESC
     LIMIT $1::int`,
    take,
  )
  return rows.map(toStateRow)
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export type PushRunRow = {
  claimedAt: Date | null
  startedAt: Date | null
  finishedAt: Date | null
  status: 'ok' | 'part' | 'failed' | null
  sent: number
  failed: number
  removed: number
  lastError: string | null
  reconciledAt: Date | null
  reconcileChecked: number
  reconcileDiffers: number
}

type RawRunRow = {
  claimed_at: Date | null
  started_at: Date | null
  finished_at: Date | null
  status: string | null
  sent: number
  failed: number
  removed: number
  last_error: string | null
  reconciled_at: Date | null
  reconcile_checked: number
  reconcile_differs: number
}

function toRunRow(row: RawRunRow | undefined): PushRunRow {
  const status = row?.status
  return {
    claimedAt: row?.claimed_at ?? null,
    startedAt: row?.started_at ?? null,
    finishedAt: row?.finished_at ?? null,
    status: status === 'ok' || status === 'part' || status === 'failed' ? status : null,
    sent: Number(row?.sent ?? 0),
    failed: Number(row?.failed ?? 0),
    removed: Number(row?.removed ?? 0),
    lastError: row?.last_error ?? null,
    reconciledAt: row?.reconciled_at ?? null,
    reconcileChecked: Number(row?.reconcile_checked ?? 0),
    reconcileDiffers: Number(row?.reconcile_differs ?? 0),
  }
}

const RUN_COLUMNS = `"claimed_at", "started_at", "finished_at", "status", "sent", "failed", "removed",
  "last_error", "reconciled_at", "reconcile_checked", "reconcile_differs"`

export async function readPushRun(): Promise<PushRunRow> {
  const rows = await prisma.$queryRawUnsafe<RawRunRow[]>(`SELECT ${RUN_COLUMNS} FROM "gsf_push_run" WHERE "id" = 'singleton'`)
  return toRunRow(rows[0])
}

/**
 * Claims the right to be the run.
 *
 * Two conditions, and both matter:
 *   - nobody else holds the claim (or whoever does has been holding it long
 *     enough to be presumed dead);
 *   - the last run started at least `minGapSeconds` ago. A save kicks the
 *     worker, so without this a bulk edit of five hundred products would be
 *     five hundred runs. The hourly check passes 0, because being on a timer is
 *     its own gap.
 *
 * Returns false when the claim went to somebody else, or the gap has not
 * passed. It is an UPDATE ... WHERE, so two machines racing produce exactly one
 * winner however close together they arrive.
 */
export async function claimPushRun(minGapSeconds: number): Promise<boolean> {
  const gap = Math.max(0, Math.trunc(minGapSeconds))
  const claimed = await prisma.$executeRaw`
    UPDATE "gsf_push_run"
    SET "claimed_at" = CURRENT_TIMESTAMP, "started_at" = CURRENT_TIMESTAMP
    WHERE "id" = 'singleton'
      -- Cast because make_interval takes its arguments by name, and a bare
      -- placeholder leaves Postgres unable to work out what type it is meant
      -- to be.
      AND ("claimed_at" IS NULL OR "claimed_at" < CURRENT_TIMESTAMP - make_interval(secs => ${STALE_CLAIM_SECONDS}::int))
      AND ("started_at" IS NULL OR "started_at" < CURRENT_TIMESTAMP - make_interval(secs => ${gap}::int))
  `
  return claimed > 0
}

/**
 * Lets the claim go and stamps how it went.
 *
 * `finished_at` moves here and NOWHERE else, so a run that died leaves
 * `started_at` ahead of `finished_at` and the screen can say "started, never
 * came back" rather than reporting the run before it as though it were this
 * one.
 */
export async function releasePushRun(summary: PushRunSummary): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "gsf_push_run"
    SET "claimed_at" = NULL,
        "finished_at" = CURRENT_TIMESTAMP,
        "status" = ${summary.status},
        "sent" = ${summary.sent},
        "failed" = ${summary.failed},
        "removed" = ${summary.removed},
        "last_error" = ${summary.message?.slice(0, 1000) ?? null}
    WHERE "id" = 'singleton'
  `
}

/** Lets the claim go without stamping anything - for a run that claimed the
 *  slot and then found there was nothing to do after all. */
export async function abandonPushRun(): Promise<void> {
  await prisma.$executeRaw`UPDATE "gsf_push_run" SET "claimed_at" = NULL WHERE "id" = 'singleton'`
}

/** What the sample check found. Its own stamp, because it runs on the hourly
 *  timer whether or not anything was sent. */
export async function recordReconcileRun(checked: number, differs: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "gsf_push_run"
    SET "reconciled_at" = CURRENT_TIMESTAMP, "reconcile_checked" = ${checked}, "reconcile_differs" = ${differs}
    WHERE "id" = 'singleton'
  `
}
