// What the Reports tab shows about THIS SITE'S own count of Google traffic.
//
// Sits beside the figures Google publishes, never mixed in with them. The two
// will not agree and are not meant to: Google counts a click when it hands the
// visitor over, this counts a landing when the page actually ran a script in
// their browser, and everything in between - a back button pressed before the
// page loaded, an ad blocker, a browser that refuses the request - is a
// difference. Both are honest; neither is the other's error bar.
//
// One rule runs through the whole file: a figure nobody can stand behind is not
// drawn. An empty table reads as "nothing has been recorded", never as nought
// sales; revenue is only ever money the shop itself has confirmed; and the
// share of landings that could be joined to a sale at all is reported
// alongside, because on a site where most visitors decline marketing the sales
// column is a floor rather than a count.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { isBehindCloudflare } from '@/lib/config/site'
import { calendarDateIn, instantAtWallClock } from '@/lib/config/timezone'
import { getSiteTimezone } from '@/lib/config/timezone.server'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { addDays } from '@/modules/google-shopping-for-shop/lib/performance/days'
import { resolveRange } from '@/modules/google-shopping-for-shop/lib/performance/range'
import type { ReportRange } from '@/modules/google-shopping-for-shop/lib/performance/types'
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { asClickSource, type ClickSource } from '@/modules/google-shopping-for-shop/lib/click-tracking/types'

/** How many landings the live feed shows. Enough to see the last day or two of
 *  a busy shop at a glance, few enough that a 20-second poll stays cheap. */
export const LIVE_FEED_LIMIT = 30

export type LiveTotals = {
  landings: number
  /** Of those, how many could be joined to a sale at all - the visitor agreed
   *  to marketing. The rest are counted and cannot convert, by design. */
  attributable: number
  orders: number
  /** Confirmed money only, in the shop's own currency. */
  revenue: number
  /** Orders over ATTRIBUTABLE landings, not over all of them: dividing by
   *  landings that were never able to convert would report a rate no shop could
   *  ever reach. Null where there were none, because a rate over nothing is not
   *  nought per cent. */
  conversionRate: number | null
}

export type LiveLanding = {
  id: string
  landedAt: string
  source: ClickSource
  productId: string
  productName: string
  variantId: string | null
  variantName: string | null
  consented: boolean
  order: {
    orderId: string
    orderNumber: string
    value: number | null
    currency: string | null
    confirmedAt: string | null
  } | null
}

export type LiveReport = {
  /** The site's own today, in its own timezone - not the server's. */
  today: string
  range: { range: ReportRange; from: string; to: string; days: number }
  currency: string
  totals: { free: LiveTotals; paid: LiveTotals; all: LiveTotals }
  recent: LiveLanding[]
  /** When the first landing of all was recorded, so an empty range can say
   *  "nothing in these dates" rather than "nothing ever". Null on a site that
   *  has never recorded one. */
  firstLandingAt: string | null
  settings: {
    trackingEnabled: boolean
    linkTaggingEnabled: boolean
    retentionDays: number
    /** True when the site has no ENCRYPTION_KEY, in which case the beacon
     *  refuses to record anything and the screen says so rather than showing an
     *  empty table nobody can explain. */
    keyMissing: boolean
    /** True when this request arrived through Cloudflare while core's "my
     *  traffic goes through Cloudflare" setting is OFF.
     *
     *  It is here because the consequence is invisible from the figures. Both
     *  of this module's derived keys come from the client address, and with
     *  that setting off the address core reports is CLOUDFLARE'S edge, not the
     *  visitor's. Every visitor through one Cloudflare location then shares one
     *  rate-limit bucket - forty landings per five minutes for the whole site -
     *  and lands close enough in the dedupe to be mistaken for each other, so
     *  two people looking at the same product inside half an hour count once.
     *  The figures come out quietly, badly low, and nothing about them says so.
     *
     *  Detected rather than assumed: the admin request reaching this route came
     *  through the same front door as a shopper's, so CF-Connecting-IP being
     *  present here means the site really is proxied. Null where the route did
     *  not look. */
    cloudflareMismatch: boolean | null
  }
}

export type AttributedOrderView = {
  orderId: string
  orderNumber: string
  attributedAt: string
  confirmedAt: string | null
  value: number | null
  currency: string | null
  secondsToPurchase: number
  click: {
    landedAt: string
    source: ClickSource
    productId: string
    productName: string
    variantId: string | null
    variantName: string | null
  }
  /** What was actually bought. Deliberately shown next to the landing product:
   *  an ad that sells something else is still a sale, and an owner reading only
   *  the total would never know it happened. */
  boughtItems: Array<{ productId: string | null; name: string; quantity: number }>
}

type TotalsRow = {
  source: string
  landings: bigint
  attributable: bigint
  orders: bigint
  revenue: Prisma.Decimal | null
}

function emptyTotals(): LiveTotals {
  return { landings: 0, attributable: 0, orders: 0, revenue: 0, conversionRate: null }
}

function rate(orders: number, attributable: number): number | null {
  return attributable > 0 ? orders / attributable : null
}

/** The site's own reading of the date range, as two instants. `to` is the day
 *  AFTER the last one, taken at midnight, so the comparison is half-open and a
 *  landing at 23:59:59.999 on the last day is inside it. */
function spanInstants(from: string, to: string, timezone: string): { start: Date; end: Date } {
  return {
    start: instantAtWallClock(from, '00:00', timezone),
    end: instantAtWallClock(addDays(to, 1), '00:00', timezone),
  }
}

export async function readLiveReport(input: {
  range: string
  from?: string
  to?: string
  /** Whether the request that asked for this report arrived through Cloudflare.
   *  Read off the caller's own headers, because a lib cannot see a request. */
  viaCloudflare?: boolean
}): Promise<LiveReport> {
  const [settings, shop, timezone, trustsCloudflare] = await Promise.all([
    getGsfSettings(),
    getShopConfigCached(),
    getSiteTimezone(),
    // Only asked when the caller reports a Cloudflare header, so a site that is
    // not behind one never pays for the lookup.
    input.viaCloudflare === true ? isBehindCloudflare() : Promise.resolve(true),
  ])
  const today = calendarDateIn(new Date(), timezone)
  const resolved = resolveRange({
    today,
    range: input.range,
    ...(input.from ? { from: input.from } : {}),
    ...(input.to ? { to: input.to } : {}),
    // Nothing older than the retention window can exist, so a custom range
    // reaching further back is quietly clamped rather than scanning for rows
    // that were pruned months ago. 0 is "keep everything", which has no floor.
    ...(settings.clickRetentionDays > 0 ? { earliest: addDays(today, -settings.clickRetentionDays) } : {}),
  })
  const { start, end } = spanInstants(resolved.from, resolved.to, timezone)

  const [totalsRows, recentRows, firstRows] = await Promise.all([
    // LATERAL rather than a plain LEFT JOIN, and that is not a flourish: one
    // landing can be credited with more than one order (a shopper who came back
    // and bought twice), and a plain join would then count that landing twice
    // in the landings column. Pre-aggregating per click keeps each column
    // counting the thing it is named after.
    prisma.$queryRaw<TotalsRow[]>`
      SELECT e."source" AS source,
             COUNT(*)::bigint AS landings,
             COUNT(*) FILTER (WHERE e."consented")::bigint AS attributable,
             COALESCE(SUM(a.orders), 0)::bigint AS orders,
             COALESCE(SUM(a.revenue), 0)::decimal AS revenue
      FROM "gsf_click_events" e
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::bigint AS orders, COALESCE(SUM(o."order_value"), 0)::decimal AS revenue
        FROM "gsf_attributed_orders" o
        WHERE o."click_event_id" = e."id" AND o."confirmed_at" IS NOT NULL
      ) a ON true
      WHERE e."landed_at" >= ${start} AND e."landed_at" < ${end}
      GROUP BY e."source"
    `,
    prisma.$queryRaw<Array<{
      id: string
      landed_at: Date
      source: string
      product_id: string
      product_name: string
      variant_id: string | null
      variant_name: string | null
      consented: boolean
      order_id: string | null
      order_number: string | null
      order_value: Prisma.Decimal | null
      currency: string | null
      confirmed_at: Date | null
    }>>`
      SELECT e."id", e."landed_at", e."source", e."product_id", e."variant_id", e."consented",
             p."name" AS product_name, v."name" AS variant_name,
             a."order_id", a."order_number", a."order_value", a."currency", a."confirmed_at"
      FROM "gsf_click_events" e
      JOIN "shp_products" p ON p."id" = e."product_id"
      LEFT JOIN "shp_products" v ON v."id" = e."variant_id"
      LEFT JOIN LATERAL (
        SELECT o."order_id", o."order_number", o."order_value", o."currency", o."confirmed_at"
        FROM "gsf_attributed_orders" o
        WHERE o."click_event_id" = e."id"
        ORDER BY o."attributed_at" DESC
        LIMIT 1
      ) a ON true
      WHERE e."landed_at" >= ${start} AND e."landed_at" < ${end}
      ORDER BY e."landed_at" DESC
      LIMIT ${LIVE_FEED_LIMIT}
    `,
    prisma.$queryRaw<Array<{ landed_at: Date }>>`
      SELECT "landed_at" FROM "gsf_click_events" ORDER BY "landed_at" ASC LIMIT 1
    `,
  ])

  const bySource: Record<ClickSource, LiveTotals> = { free: emptyTotals(), paid: emptyTotals() }
  for (const row of totalsRows) {
    const source = asClickSource(row.source)
    const totals = bySource[source]
    totals.landings += Number(row.landings)
    totals.attributable += Number(row.attributable)
    totals.orders += Number(row.orders)
    totals.revenue += Number(row.revenue ?? 0)
  }
  for (const source of ['free', 'paid'] as const) {
    bySource[source].conversionRate = rate(bySource[source].orders, bySource[source].attributable)
  }
  const all: LiveTotals = {
    landings: bySource.free.landings + bySource.paid.landings,
    attributable: bySource.free.attributable + bySource.paid.attributable,
    orders: bySource.free.orders + bySource.paid.orders,
    revenue: bySource.free.revenue + bySource.paid.revenue,
    conversionRate: null,
  }
  all.conversionRate = rate(all.orders, all.attributable)

  return {
    today,
    range: { range: resolved.range, from: resolved.from, to: resolved.to, days: resolved.days },
    currency: shop.currency,
    totals: { free: bySource.free, paid: bySource.paid, all },
    recent: recentRows.map((row) => ({
      id: row.id,
      landedAt: row.landed_at.toISOString(),
      source: asClickSource(row.source),
      productId: row.product_id,
      productName: row.product_name,
      variantId: row.variant_id,
      variantName: row.variant_name,
      consented: row.consented,
      order: row.order_id && row.order_number
        ? {
            orderId: row.order_id,
            orderNumber: row.order_number,
            // Null rather than 0 where nothing has confirmed the money yet: the
            // screen shows it as pending, which is what it is.
            value: row.order_value === null ? null : Number(row.order_value),
            currency: row.currency,
            confirmedAt: row.confirmed_at?.toISOString() ?? null,
          }
        : null,
    })),
    firstLandingAt: firstRows[0]?.landed_at.toISOString() ?? null,
    settings: {
      trackingEnabled: settings.clickTrackingEnabled,
      linkTaggingEnabled: settings.linkTaggingEnabled,
      retentionDays: settings.clickRetentionDays,
      keyMissing: !process.env.ENCRYPTION_KEY?.trim(),
      cloudflareMismatch: input.viaCloudflare === undefined ? null : input.viaCloudflare && !trustsCloudflare,
    },
  }
}

/** One sale, and the click it came from. Null when this order was never joined
 *  to a landing - which is every order that did not come from Google, and every
 *  order from a visitor who declined marketing. */
export async function readAttributedOrder(orderId: string): Promise<AttributedOrderView | null> {
  const rows = await prisma.$queryRaw<Array<{
    order_id: string
    order_number: string
    attributed_at: Date
    confirmed_at: Date | null
    order_value: Prisma.Decimal | null
    currency: string | null
    seconds_to_purchase: bigint
    landed_at: Date
    source: string
    product_id: string
    product_name: string
    variant_id: string | null
    variant_name: string | null
  }>>`
    SELECT a."order_id", a."order_number", a."attributed_at", a."confirmed_at", a."order_value",
           a."currency", a."seconds_to_purchase",
           e."landed_at", e."source", e."product_id", e."variant_id",
           p."name" AS product_name, v."name" AS variant_name
    FROM "gsf_attributed_orders" a
    JOIN "gsf_click_events" e ON e."id" = a."click_event_id"
    JOIN "shp_products" p ON p."id" = e."product_id"
    LEFT JOIN "shp_products" v ON v."id" = e."variant_id"
    WHERE a."order_id" = ${orderId}
  `
  const row = rows[0]
  if (!row) return null

  const items = await prisma.$queryRaw<Array<{ product_id: string | null; product_name: string; quantity: number }>>`
    SELECT "product_id", "product_name", "quantity"
    FROM "shp_order_items"
    WHERE "order_id" = ${orderId}
    ORDER BY "product_name" ASC
  `

  return {
    orderId: row.order_id,
    orderNumber: row.order_number,
    attributedAt: row.attributed_at.toISOString(),
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    value: row.order_value === null ? null : Number(row.order_value),
    currency: row.currency,
    secondsToPurchase: Number(row.seconds_to_purchase),
    click: {
      landedAt: row.landed_at.toISOString(),
      source: asClickSource(row.source),
      productId: row.product_id,
      productName: row.product_name,
      variantId: row.variant_id,
      variantName: row.variant_name,
    },
    boughtItems: items.map((item) => ({ productId: item.product_id, name: item.product_name, quantity: Number(item.quantity) })),
  }
}
