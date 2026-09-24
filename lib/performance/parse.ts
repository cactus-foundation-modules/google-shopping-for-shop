// Google's answer, turned into rows we can store.
//
// Pure. Every field is read defensively and nothing is guessed: a figure Google
// did not send comes back as null, and null travels all the way to the screen
// as "Google does not report this" rather than being flattened into a zero
// somebody might act on.
//
// Field names and types checked against Google's published discovery document
// for reports_v1 on 2026-09-23:
//   clicks, impressions          int64, and therefore arrive as STRINGS
//   clickThroughRate             double
//   conversions                  double
//   conversionValue              Price { amountMicros (int64 string), currencyCode }
//   date                         google.type.Date { year, month, day }
//   marketingMethod              ORGANIC | ADS | MARKETING_METHOD_ENUM_UNSPECIFIED
import { dayFromGoogle } from '@/modules/google-shopping-for-shop/lib/performance/days'
import { asMarketingMethod, type PerformanceRow } from '@/modules/google-shopping-for-shop/lib/performance/types'

/** One row of the report as Google sends it. Everything optional, because
 *  Google only sets what the query asked for and we ask for different things
 *  depending on whether conversions were accepted. */
export type ProductPerformanceResult = {
  productPerformanceView?: {
    date?: unknown
    offerId?: unknown
    marketingMethod?: unknown
    clicks?: unknown
    impressions?: unknown
    clickThroughRate?: unknown
    conversions?: unknown
    conversionValue?: { amountMicros?: unknown; currencyCode?: unknown }
  }
}

/** An int64 Google sent as a string. Anything that is not a whole number is
 *  not a count, and comes back null rather than as a NaN dressed up as 0. */
export function asCount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return null
  const parsed = Number(value.trim())
  return Number.isSafeInteger(parsed) ? parsed : null
}

/** A double. Finite or nothing - an Infinity or a NaN on a chart is a chart
 *  with no axis. */
export function asRate(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) ? parsed : null
}

/** An int64 of millionths, kept as a bigint all the way to the column: money
 *  divided into floats and added back up is money that does not balance. */
export function asMicros(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return null
  try {
    return BigInt(value.trim())
  } catch {
    return null
  }
}

/**
 * One report row, or null when it is not one we can file.
 *
 * A row with no day or no offer id has nowhere to go - the two of them plus the
 * marketing method ARE the key - so it is dropped rather than stored under a
 * made-up one. Google has never been seen to send one; it costs a line to be
 * sure it could not poison a day's figures if it did.
 */
export function parsePerformanceRow(result: ProductPerformanceResult): PerformanceRow | null {
  const view = result.productPerformanceView
  if (!view) return null
  const day = dayFromGoogle(view.date)
  const itemId = typeof view.offerId === 'string' ? view.offerId.trim() : ''
  if (!day || itemId === '') return null

  const currency = typeof view.conversionValue?.currencyCode === 'string' ? view.conversionValue.currencyCode.trim() : ''
  const valueMicros = asMicros(view.conversionValue?.amountMicros)

  return {
    day,
    itemId,
    method: asMarketingMethod(view.marketingMethod),
    // A row Google sent with no clicks at all is a row with no clicks, which
    // is a real and common answer; zero is right here and null is not.
    clicks: asCount(view.clicks) ?? 0,
    impressions: asCount(view.impressions) ?? 0,
    clickThroughRate: asRate(view.clickThroughRate),
    conversions: asRate(view.conversions),
    conversionValueMicros: valueMicros,
    // A currency with no amount behind it says nothing, so the two travel
    // together or not at all.
    conversionCurrency: valueMicros === null || currency === '' ? null : currency,
  }
}

/**
 * Two readings of the same (day, offer, method) added together.
 *
 * There should never be two: the query selects three segments and Google
 * aggregates over the rest, so each key appears once. This exists because
 * "should never" is not "cannot", and the alternative - an upsert that keeps
 * whichever row arrived last - would lose the other one's clicks silently,
 * which is the one failure nobody would ever notice.
 */
export function mergeRows(a: PerformanceRow, b: PerformanceRow): PerformanceRow {
  const clicks = a.clicks + b.clicks
  const impressions = a.impressions + b.impressions
  const conversions = a.conversions === null && b.conversions === null ? null : (a.conversions ?? 0) + (b.conversions ?? 0)
  const value = a.conversionValueMicros === null && b.conversionValueMicros === null
    ? null
    : (a.conversionValueMicros ?? 0n) + (b.conversionValueMicros ?? 0n)
  return {
    day: a.day,
    itemId: a.itemId,
    method: a.method,
    clicks,
    impressions,
    // Worked out again rather than averaged. Two rates have no meaningful
    // average without their denominators, and here we have them.
    clickThroughRate: impressions > 0 ? clicks / impressions : null,
    conversions,
    conversionValueMicros: value,
    conversionCurrency: a.conversionCurrency ?? b.conversionCurrency,
  }
}
