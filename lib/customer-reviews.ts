// Google Customer Reviews: what the order confirmation page hands Google's own
// survey opt-in.
//
// Google asks for five things - the merchant account, the order, the customer's
// email, where it is going and when it should arrive - and the last of those is
// the only one the shop has to work out. Everything here is server-side on
// purpose: the email never travels to the browser except on the confirmation
// page of the order it belongs to, proven by the order's own signed receipt
// token, and an order the caller cannot prove is theirs simply has no opt-in.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getOrderByNumber, getOrderItems } from '@/modules/shop/lib/db/orders'
import { verifyOrderReceiptToken } from '@/modules/shop/lib/order-receipt-token'
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { getProductDataForProducts } from '@/modules/google-shopping-for-shop/lib/product-data'
import { getDeliveryTiming } from '@/modules/google-shopping-for-shop/lib/delivery-timing'
import { normaliseGtin } from '@/modules/google-shopping-for-shop/lib/feed-xml'
import type { GsfOptInStyle } from '@/modules/google-shopping-for-shop/lib/types'

/** Exactly the payload Google's surveyoptin.render() takes, and nothing else. */
export type CustomerReviewsOptIn = {
  merchantId: number
  orderId: string
  email: string
  deliveryCountry: string
  estimatedDeliveryDate: string
  optInStyle: GsfOptInStyle
  /** Barcodes of what was bought, where the shop knows them. Optional to
   *  Google, and what lets a survey answer become a product review rather than
   *  only a seller rating. */
  gtins: string[]
}

/**
 * Working days from a date, counting Monday to Friday only.
 *
 * Deliberately blind to bank holidays. The shop's own delivery module knows
 * about those and is where a real promise comes from; this is an estimate on a
 * survey invitation, and a date two days out costs a customer an email arriving
 * slightly early, not a missed delivery. Exported for its own test.
 */
export function addWorkingDays(from: Date, days: number): Date {
  const date = new Date(from.getTime())
  let left = Math.max(0, Math.floor(days))
  while (left > 0) {
    date.setUTCDate(date.getUTCDate() + 1)
    const day = date.getUTCDay()
    if (day !== 0 && day !== 6) left--
  }
  return date
}

/** YYYY-MM-DD, which is the only date format Google's opt-in accepts. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

// The slowest thing in the order decides when the order arrives: a customer
// whose desk comes next week and whose chair comes tomorrow has not had their
// order until the desk turns up. Where the delivery module knows nothing about
// a product, the shop-wide fallback stands in for it rather than the line being
// treated as instant.
function daysToArrive(
  productIds: string[],
  timing: Map<string, { handlingDays: number; transitDays: number }>,
  fallbackDays: number,
): number {
  let slowest = 0
  for (const productId of productIds) {
    const row = timing.get(productId)
    const days = row ? row.handlingDays + row.transitDays : fallbackDays
    if (days > slowest) slowest = days
  }
  return productIds.length === 0 ? fallbackDays : slowest
}

type BarcodeRow = { id: string; barcode: string | null }

// Barcodes for what was actually bought. The ordered row is the variation the
// customer chose, so its own barcode is the right one; the parent's Google tab
// stands in where a shop keeps one barcode for the product as a whole.
async function gtinsFor(productIds: string[]): Promise<string[]> {
  const unique = [...new Set(productIds)].filter(Boolean)
  if (unique.length === 0) return []
  const [rows, data] = await Promise.all([
    prisma.$queryRaw<BarcodeRow[]>`
      SELECT "id", "barcode" FROM "shp_products" WHERE "id" IN (${Prisma.join(unique)})
    `,
    getProductDataForProducts(unique),
  ])
  const barcodes = new Map(rows.map((row) => [row.id, row.barcode]))
  const gtins = new Set<string>()
  for (const productId of unique) {
    const gtin = normaliseGtin(barcodes.get(productId) ?? null) ?? normaliseGtin(data.get(productId)?.gtin ?? null)
    if (gtin) gtins.add(gtin)
  }
  return [...gtins]
}

/**
 * The opt-in for one order, or null where there should not be one.
 *
 * Null covers every case, and always for the same reason - there is nothing
 * honest to send: the module is off, no Merchant Center account has been typed
 * in, the token does not belong to this order, the order does not exist, or it
 * has not been paid for. A survey invitation for an unpaid order is an
 * invitation to review something nobody has yet been sold.
 */
export async function buildCustomerReviewsOptIn(
  orderNumber: string,
  token: string | null,
): Promise<CustomerReviewsOptIn | null> {
  const settings = await getGsfSettings()
  if (!settings.customerReviewsEnabled) return null
  // Google's field is a number, and the column holds digits as text. A merchant
  // id that does not survive the trip is no id at all.
  const merchantId = Number(settings.merchantId ?? '')
  if (!Number.isSafeInteger(merchantId) || merchantId <= 0) return null

  if (!verifyOrderReceiptToken(orderNumber, token)) return null
  const order = await getOrderByNumber(orderNumber)
  if (!order) return null
  // AWAITING_CONFIRMATION is a bank transfer somebody has promised to make; the
  // shop counts it as a sale, but it is not yet a delivery to survey.
  if (order.paymentStatus !== 'PAID') return null
  if (!order.customerEmail) return null

  const items = await getOrderItems(order.id)
  const productIds = items.map((item) => item.productId).filter((id): id is string => !!id)
  const timing = await getDeliveryTiming(productIds)
  const days = daysToArrive(productIds, timing, settings.customerReviewsDeliveryDays)

  return {
    merchantId,
    orderId: order.orderNumber,
    email: order.customerEmail,
    // Where the parcel goes, not where the card is registered - the survey is
    // about the delivery.
    deliveryCountry: (order.shippingAddress?.country || 'GB').toUpperCase(),
    // Counted from when the money arrived - which is when a shop starts picking
    // - and from the order date only where that is not recorded. Counting from
    // today instead would tell a customer reopening their confirmation next
    // month that their desk is arriving next month.
    estimatedDeliveryDate: isoDate(addWorkingDays(order.paidAt ?? order.createdAt, days)),
    optInStyle: settings.customerReviewsStyle,
    gtins: await gtinsFor(productIds),
  }
}
