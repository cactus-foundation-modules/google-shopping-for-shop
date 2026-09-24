// Every SQL statement live click tracking runs.
//
// Kept together in one file because they share a set of rules that only make
// sense read side by side: what is atomic and why, what may be null, and which
// columns a visitor's browser is never allowed to decide.
//
// Nothing in here is ever handed a value straight off a request body. The
// product is resolved from the address by lib/click-tracking/resolve.ts, the
// source by lib/click-tracking/classify.ts, the keys are derived server-side,
// and the order total is read from the shop's own row. The only thing a caller
// contributes is the address it was on.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { DEDUPE_WINDOW_SECONDS, type ClickIdKind, type ClickSource } from '@/modules/google-shopping-for-shop/lib/click-tracking/types'

// ---------------------------------------------------------------------------
// The brake
// ---------------------------------------------------------------------------

/** How many landings one caller may report in a window, and how long the window
 *  is. Generous for a person - nobody opens forty tagged product pages in five
 *  minutes - and far too tight for a script trying to fill the table. */
export const BEACON_RATE_LIMIT = 40
export const BEACON_RATE_WINDOW_SECONDS = 300

/**
 * Claims one slot for this caller. False means they have had their share of
 * the window and the request should be dropped.
 *
 * ONE statement, and it has to be. Every serverless invocation is its own
 * process with its own memory, so a counter in a module-level Map is a brake
 * that resets itself on the next cold start - and on a busy site there are
 * always cold starts. Reading the row and then writing it would be no better:
 * two invocations read the same number and both write one more than it. The
 * upsert below counts inside the database, where there is exactly one copy of
 * the number, and RETURNING hands back what it became.
 *
 * The window is a rolling reset rather than a fixed clock, so a caller cannot
 * wait for the top of the minute and go again.
 */
export async function claimBeaconSlot(rateKey: string, limit = BEACON_RATE_LIMIT, windowSeconds = BEACON_RATE_WINDOW_SECONDS): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ hits: number }>>`
    INSERT INTO "gsf_beacon_rate" ("bucket_key", "window_started_at", "hits")
    VALUES (${rateKey}, CURRENT_TIMESTAMP, 1)
    ON CONFLICT ("bucket_key") DO UPDATE SET
      -- Cast because make_interval takes its arguments by name, and a bare
      -- placeholder leaves Postgres unable to infer the type.
      "window_started_at" = CASE
        WHEN "gsf_beacon_rate"."window_started_at" < CURRENT_TIMESTAMP - make_interval(secs => ${windowSeconds}::int)
        THEN CURRENT_TIMESTAMP ELSE "gsf_beacon_rate"."window_started_at" END,
      "hits" = CASE
        WHEN "gsf_beacon_rate"."window_started_at" < CURRENT_TIMESTAMP - make_interval(secs => ${windowSeconds}::int)
        THEN 1 ELSE "gsf_beacon_rate"."hits" + 1 END
    RETURNING "hits"
  `
  const hits = rows[0]?.hits
  return hits !== undefined && hits <= limit
}

// ---------------------------------------------------------------------------
// Landings
// ---------------------------------------------------------------------------

export type LandingInput = {
  productId: string
  variantId: string | null
  source: ClickSource
  /** Only ever non-null for a visitor who granted marketing consent. */
  clickId: string | null
  clickIdKind: ClickIdKind | null
  sessionKey: string
  attributionId: string | null
  consented: boolean
}

/**
 * Records a landing, or does nothing because this visitor has already been
 * counted on this product in the last half hour.
 *
 * Returns the row's id when one was written, null when it was a repeat. The
 * caller cares: a repeat still refreshes the consenting visitor's cookie (the
 * newest click is the one a sale belongs to) but must not be counted twice.
 *
 * Deduped twice on purpose - see the note on `dedupe_bucket` in migration 023.
 * The NOT EXISTS gives the rolling half-hour an owner would describe; the
 * unique index catches two requests that arrive at the same instant and both
 * pass it.
 */
export async function recordLanding(input: LandingInput): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "gsf_click_events" (
      "product_id", "variant_id", "source", "click_id", "click_id_kind",
      "session_key", "attribution_id", "consented", "dedupe_bucket"
    )
    SELECT ${input.productId}::text, ${input.variantId}::text, ${input.source}::text,
           ${input.clickId}::text, ${input.clickIdKind}::text,
           ${input.sessionKey}::text, ${input.attributionId}::text, ${input.consented}::boolean,
           floor(extract(epoch FROM CURRENT_TIMESTAMP) / ${DEDUPE_WINDOW_SECONDS}::int)::bigint
    WHERE NOT EXISTS (
      SELECT 1 FROM "gsf_click_events" e
      WHERE e."session_key" = ${input.sessionKey}
        AND e."product_id" = ${input.productId}
        AND e."landed_at" > CURRENT_TIMESTAMP - make_interval(secs => ${DEDUPE_WINDOW_SECONDS}::int)
    )
    ON CONFLICT ("session_key", "product_id", "dedupe_bucket") DO NOTHING
    RETURNING "id"
  `
  return rows[0]?.id ?? null
}

export type AttributionClick = {
  id: string
  landedAt: Date
  productId: string
  source: ClickSource
}

/**
 * The most recent landing this browser's attribution cookie names, or null.
 *
 * Last click wins, which is what "most recent" spells: a shopper who came back
 * through a second listing is credited to the second one.
 *
 * Only ever called with an id read off the request's own httpOnly cookie. There
 * is no route that takes an attribution id from a body or a query string, which
 * is what stops anyone reading somebody else's.
 */
export async function lastClickFor(attributionId: string): Promise<AttributionClick | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string; landed_at: Date; product_id: string; source: string }>>`
    SELECT "id", "landed_at", "product_id", "source"
    FROM "gsf_click_events"
    WHERE "attribution_id" = ${attributionId}
    ORDER BY "landed_at" DESC
    LIMIT 1
  `
  const row = rows[0]
  if (!row) return null
  return { id: row.id, landedAt: row.landed_at, productId: row.product_id, source: row.source === 'paid' ? 'paid' : 'free' }
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

export type AttributeOrderInput = {
  orderId: string
  orderNumber: string
  clickEventId: string
  landedAt: Date
  /** Set only where the shop itself already says the money is in. The browser
   *  never contributes this, or the figure beside it. */
  confirmed: { at: Date; value: string; currency: string } | null
}

/**
 * Joins an order to the landing that led to it.
 *
 * First writer wins: an order already credited to a click is left exactly as it
 * was, because a refresh of the confirmation page is not a second sale and the
 * attribution was settled the first time. That is the same rule core's own
 * conversion seam applies in the browser, applied again here where it cannot be
 * skipped.
 *
 * Returns true when this call created the row.
 */
export async function attributeOrder(input: AttributeOrderInput): Promise<boolean> {
  const seconds = Math.max(0, Math.round((Date.now() - input.landedAt.getTime()) / 1000))
  const value = input.confirmed ? new Prisma.Decimal(input.confirmed.value) : null
  const rows = await prisma.$queryRaw<Array<{ order_id: string }>>`
    INSERT INTO "gsf_attributed_orders" (
      "order_id", "order_number", "click_event_id", "seconds_to_purchase",
      "confirmed_at", "order_value", "currency"
    )
    VALUES (
      ${input.orderId}::text, ${input.orderNumber}::text, ${input.clickEventId}::text, ${seconds}::bigint,
      ${input.confirmed?.at ?? null}::timestamp(3), ${value}::decimal, ${input.confirmed?.currency ?? null}::text
    )
    ON CONFLICT ("order_id") DO NOTHING
    RETURNING "order_id"
  `
  return rows.length > 0
}

/**
 * Whether this order is waiting on a confirmation.
 *
 * Asked first by the `shop.order-paid` observer so that the overwhelming
 * majority of orders - every sale on every shop that never switched click
 * tracking on, and every sale that did not come from Google on the ones that
 * did - cost one indexed primary-key lookup and nothing else. Reading the order
 * row to get a figure nothing is waiting for would be a query per sale, for
 * ever, on installs that get no use out of this at all.
 */
export async function hasPendingAttribution(orderId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ order_id: string }>>`
    SELECT "order_id" FROM "gsf_attributed_orders"
    WHERE "order_id" = ${orderId} AND "confirmed_at" IS NULL
    LIMIT 1
  `
  return rows.length > 0
}

/**
 * Stamps an order as paid for, with the figure the shop itself holds.
 *
 * Called from the `shop.order-paid` observer, which fires exactly once per
 * order whenever the money actually arrives - which on a card is usually a
 * moment BEFORE the shopper's confirmation page settles and on a bank transfer
 * can be days after. So this updates a row it did not create and may find none
 * at all, and neither is a fault: an order nothing attributed is simply an
 * order that did not come from Google as far as this module can tell.
 *
 * `confirmed_at IS NULL` in the WHERE, so a second announcement can never
 * restate a figure that has already been recorded.
 */
export async function confirmAttributedOrder(input: {
  orderId: string
  value: string
  currency: string
  confirmedAt: Date
}): Promise<boolean> {
  const updated = await prisma.$executeRaw`
    UPDATE "gsf_attributed_orders"
    SET "confirmed_at" = ${input.confirmedAt}::timestamp(3),
        "order_value" = ${new Prisma.Decimal(input.value)}::decimal,
        "currency" = ${input.currency}::text
    WHERE "order_id" = ${input.orderId} AND "confirmed_at" IS NULL
  `
  return updated > 0
}

// ---------------------------------------------------------------------------
// Withdrawal
// ---------------------------------------------------------------------------

export type ForgetResult = { landings: number; attributions: number; adsUploads: number }

/**
 * Somebody has withdrawn their consent. Erase everything that was only ever
 * held because they gave it.
 *
 * What goes:
 *   - the Google click identifier, which is the one field here that could be
 *     handed back to Google to identify the person;
 *   - the attribution id, which is the thread joining their visits together;
 *   - the sale-to-click joins, because a row saying "order DW000123 came from
 *     this click" names a person's order and their browsing in one line, and
 *     that join existed only by permission;
 *   - the same join on anything Google Ads has already been told about, which
 *     is the same claim written down a second time.
 *
 * The kind of click goes with it. "This order came from a Google ad click, of
 * the gclid sort" is the same claim as the join itself, one field smaller, and
 * leaving it behind would have made the sentence above untrue.
 *
 * What stays in the Google Ads table, and why: the ORDER ID and the fact that
 * Google was told about it. Not because it is nice to keep, but because
 * deleting it would have the next run tell Google about the same sale again -
 * and the upload holds no click identifier of its own, so after this there is
 * nothing in it that says whose visit it was. What has already gone to Google
 * is Google's to erase, and the wiki says how to ask them.
 *
 * What stays: the landing itself, as a count. Which product, when, and whether
 * it came from a free listing or a paid one - exactly what is recorded for
 * every visitor who never agreed to anything, and exactly what a shop is
 * entitled to count without asking. Those rows are left anonymous rather than
 * deleted so last month's traffic figures do not silently change.
 *
 * `consented` goes to false with the rest, which is not bookkeeping pedantry:
 * the Reports tab counts it as "landings that could be joined to a sale", and
 * after this they cannot be. Leaving it true would report a conversion rate
 * measured against visits that can no longer convert.
 *
 * One transaction. A half-finished erasure - identifiers gone, joins still
 * standing, or the other way about - is the one outcome worse than not having
 * started.
 */
export async function forgetAttribution(attributionId: string): Promise<ForgetResult> {
  const [adsUploads, attributions, landings] = await prisma.$transaction([
    // First of all, while the landings still carry the id that finds them, and
    // before the attributions are deleted: this one reaches the click events
    // through the same id and must run while they still have it.
    prisma.$executeRaw`
      UPDATE "gsf_ads_conversion_uploads"
      SET "click_event_id" = NULL, "click_id_kind" = NULL
      WHERE "click_event_id" IN (
        SELECT "id" FROM "gsf_click_events" WHERE "attribution_id" = ${attributionId}
      )
    `,
    // Then, while the landings still carry the id that finds them.
    prisma.$executeRaw`
      DELETE FROM "gsf_attributed_orders"
      WHERE "click_event_id" IN (
        SELECT "id" FROM "gsf_click_events" WHERE "attribution_id" = ${attributionId}
      )
    `,
    prisma.$executeRaw`
      UPDATE "gsf_click_events"
      SET "click_id" = NULL, "click_id_kind" = NULL, "attribution_id" = NULL, "consented" = false
      WHERE "attribution_id" = ${attributionId}
    `,
  ])
  return { landings, attributions, adsUploads }
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

export type PruneResult = { landings: number; rateWindows: number }

/**
 * Drops landings past the retention window, and the rate-limit windows nobody
 * has touched for a day.
 *
 * `retentionDays` of 0 is "keep everything", which is a real answer and not a
 * mistake - so it prunes nothing rather than everything. Getting that the wrong
 * way round would empty the table on the next cron run of a site that had
 * deliberately asked for the lot.
 *
 * Attributions go with their landings, through the foreign key's cascade: an
 * attribution whose click has been forgotten is a claim with nothing behind it.
 */
export async function pruneClickTracking(retentionDays: number): Promise<PruneResult> {
  const landings = retentionDays > 0
    ? await prisma.$executeRaw`
        DELETE FROM "gsf_click_events"
        WHERE "landed_at" < CURRENT_TIMESTAMP - make_interval(days => ${Math.round(retentionDays)}::int)
      `
    : 0
  // Not governed by the retention setting: these hold no landing, no product
  // and nothing about a visit - only a keyed hash and a counter - and a window
  // a day old can never refuse anybody.
  const rateWindows = await prisma.$executeRaw`
    DELETE FROM "gsf_beacon_rate"
    WHERE "window_started_at" < CURRENT_TIMESTAMP - make_interval(days => 1)
  `
  return { landings, rateWindows }
}
