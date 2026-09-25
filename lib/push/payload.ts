// Turning one built feed row into the body Merchant API wants, and back again.
//
// Pure. The feed build stays the single authority on what an item's price and
// availability ARE; this only says how to spell them for the API, which is not
// how they are spelled in the XML:
//
//   XML        <g:availability>in_stock</g:availability>   <g:price>900.50 GBP</g:price>
//   Merchant   availability: "IN_STOCK"      price: { amountMicros: "900500000", currencyCode: "GBP" }
//
// Both were checked against Google's own products_v1 discovery document
// (revision 20260923) rather than remembered from the older Content API, where
// price was a string like "900.50" and availability was lower case. Sending
// either of those here is a 400 at best and a silently ignored attribute at
// worst.
import type { FeedItem } from '@/modules/google-shopping-for-shop/lib/feed-xml'
import {
  isGoogleAvailability,
  type FeedAvailability,
  type GoogleAvailability,
  type GooglePrice,
  type ProductInputBody,
  type PushSnapshot,
} from '@/modules/google-shopping-for-shop/lib/push/types'

/** The feed's own availability words, in Google's API spelling. */
const TO_GOOGLE: Record<FeedAvailability, GoogleAvailability> = {
  in_stock: 'IN_STOCK',
  out_of_stock: 'OUT_OF_STOCK',
  preorder: 'PREORDER',
  backorder: 'BACKORDER',
}

export function googleAvailability(availability: FeedAvailability): GoogleAvailability {
  return TO_GOOGLE[availability]
}

/**
 * Major units to Google's micros, as the string its int64 field wants.
 *
 * `Math.round` before the string, not after: 1.1 * 1e6 is 1100000.0000000002 in
 * binary floating point, and `String()` of that is a number Google rejects. A
 * price is two decimal places, so rounding to the nearest micro cannot lose
 * anything a shop meant.
 */
export function toMicros(amount: number): string {
  if (!Number.isFinite(amount)) throw new Error('A price that is not a number cannot be sent to Google')
  return String(Math.round(amount * 1_000_000))
}

/** Google's micros back to major units, for comparing what it holds against
 *  what we sent. Returns null for anything that is not a figure - Google's
 *  field is a string and an empty one means "not set", not zero. */
export function fromMicros(micros: unknown): number | null {
  if (typeof micros !== 'string' && typeof micros !== 'number') return null
  // Number('') is 0, and an empty string here means "Google is not holding a
  // figure", not "Google is holding nothing at all" - which would read as a
  // free product and, worse, as a disagreement with every price we ever sent.
  if (typeof micros === 'string' && micros.trim() === '') return null
  const value = Number(micros)
  if (!Number.isFinite(value)) return null
  return Math.round(value / 10_000) / 100
}

export function toGooglePrice(amount: number, currency: string): GooglePrice {
  return { amountMicros: toMicros(amount), currencyCode: currency }
}

/**
 * What this item's price and availability are, right now, according to the
 * feed.
 *
 * A sale price equal to or above the regular price is dropped rather than sent.
 * Google treats that as an error on the item, and the feed XML already declines
 * to render one - sending it here would put a disapproval on a product the feed
 * itself considers perfectly fine.
 */
export function snapshotOf(item: FeedItem): PushSnapshot {
  const salePrice = item.salePrice !== undefined && item.salePrice > 0 && item.salePrice < item.price
    ? item.salePrice
    : undefined
  return {
    price: item.price,
    ...(salePrice === undefined ? {} : { salePrice }),
    currency: item.currency,
    availability: googleAvailability(item.availability),
  }
}

/** True when two snapshots say the same thing, to the penny. What stops an
 *  unchanged item being sent again on every run. */
export function sameSnapshot(a: PushSnapshot, b: PushSnapshot): boolean {
  return a.price === b.price
    && (a.salePrice ?? null) === (b.salePrice ?? null)
    && a.currency === b.currency
    && a.availability === b.availability
}

/** The figure a shopper actually pays: the offer where one is running, the
 *  regular price where not. */
function payable(snapshot: PushSnapshot): number {
  return snapshot.salePrice ?? snapshot.price
}

/**
 * True when Google is showing the offer this site sent. What the hourly check
 * asks, and deliberately looser than `sameSnapshot`, which asks whether we have
 * already sent something.
 *
 * Google does not only read what it is sent. It also reads the product page,
 * and a page that publishes a struck-through "was" price (schema.org
 * StrikethroughPrice - an RRP, say) is filed by Merchant Center as the regular
 * price, with the figure we sent moved down into the sale price. Sent £153.60,
 * Google showing "£391.20, on offer at £153.60": that is the page, word for
 * word, and not a disagreement.
 *
 * So the price to pay, the currency and the stock have to match, and the
 * regular price has to match too UNLESS Google is showing a "was" figure of its
 * own. What that still catches: an offer we sent that Google dropped (it would
 * be showing the regular price with no offer), and any figure to pay that is
 * not ours.
 */
export function googleShowsSameOffer(sent: PushSnapshot, google: PushSnapshot): boolean {
  return payable(sent) === payable(google)
    && (sent.price === google.price || google.salePrice !== undefined)
    && sent.currency === google.currency
    && sent.availability === google.availability
}

/** A snapshot as it was stored in a reconcile detail, read back. Null for
 *  anything that is not one - including a Google side recorded as missing. */
export function snapshotFromStored(value: unknown): PushSnapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (typeof row.price !== 'number' || typeof row.currency !== 'string' || !isGoogleAvailability(row.availability)) return null
  return {
    price: row.price,
    ...(typeof row.salePrice === 'number' ? { salePrice: row.salePrice } : {}),
    currency: row.currency,
    availability: row.availability,
  }
}

/**
 * The insert body for one item.
 *
 * offerId, contentLanguage and feedLabel are all REQUIRED on a ProductInput and
 * all three are immutable once the product exists, so they have to match what
 * the feed already publishes or Google files this against a second product
 * nobody is advertising.
 *
 * `versionNumber` is deliberately absent. Google's own field documentation says
 * of it: "Do not set this field for insertions into supplemental data sources."
 * It is the obvious guard against an out-of-order write and it is not available
 * to us, which is why the reconcile exists instead.
 */
export function buildProductInput(
  item: FeedItem,
  options: { contentLanguage: string; feedLabel: string },
): ProductInputBody {
  const snapshot = snapshotOf(item)
  return {
    offerId: item.id,
    contentLanguage: options.contentLanguage,
    feedLabel: options.feedLabel,
    productAttributes: {
      price: toGooglePrice(snapshot.price, snapshot.currency),
      ...(snapshot.salePrice === undefined ? {} : { salePrice: toGooglePrice(snapshot.salePrice, snapshot.currency) }),
      availability: snapshot.availability,
    },
  }
}

type RawProduct = {
  productAttributes?: {
    price?: { amountMicros?: unknown; currencyCode?: unknown }
    salePrice?: { amountMicros?: unknown; currencyCode?: unknown }
    availability?: unknown
  }
}

/**
 * What Google says it holds for one item, in the same shape we store.
 *
 * Null when Google's reply carries no price or no availability we recognise. A
 * half-read reply must never be treated as a complete one: "Google holds no
 * price for this" and "we could not read Google's answer" would otherwise look
 * identical, and one of them is a reason to raise an alarm.
 */
export function snapshotFromProduct(raw: unknown): PushSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null
  const attributes = (raw as RawProduct).productAttributes
  if (!attributes) return null

  const price = fromMicros(attributes.price?.amountMicros)
  const currency = typeof attributes.price?.currencyCode === 'string' ? attributes.price.currencyCode : null
  const availability = typeof attributes.availability === 'string' ? attributes.availability.toUpperCase() : null
  if (price === null || currency === null || !isGoogleAvailability(availability)) return null

  const sale = fromMicros(attributes.salePrice?.amountMicros)
  return {
    price,
    ...(sale === null || sale <= 0 ? {} : { salePrice: sale }),
    currency,
    availability,
  }
}
