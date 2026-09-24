// Reading what Google Ads sends back.
//
// Pure, and separate from the calls that fetch it, so every shape in Google's
// documentation can be put through these functions without an account.
//
// Two traps in the JSON encoding, both of which look like working code until
// the numbers are wrong:
//
//   - An int64 arrives as a STRING. `metrics.cost_micros`, `metrics.clicks` and
//     `metrics.impressions` are all int64, so `row.metrics.clicks` is "41" and
//     not 41. JavaScript would happily add that to another string.
//   - A double arrives as a number. `metrics.conversions` and
//     `metrics.conversions_value` are doubles, so they do NOT need the same
//     treatment - and running them through a string parser would be fine right
//     up until Google sent one in exponent notation.
//
// And one trap in the data itself: `segments.product_item_id` comes back LOWER
// CASE, whatever case the item id has in Merchant Center. It is stored exactly
// as sent and joined through lower() on both sides. See migration 025.
import type { AdsRow } from '@/modules/google-shopping-for-shop/lib/google-ads/client'

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** An int64 out of JSON. A string of digits is the normal case; a number is
 *  accepted because Google has been known to send small ones that way. Anything
 *  else is null, never 0 - a figure we could not read and a figure of nothing
 *  must not look the same. */
export function int64(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim())
  return null
}

/** A double out of JSON. */
export function float(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export type AdsSpendRow = {
  /** 'YYYY-MM-DD' in the Google Ads account's timezone, which Google chooses. */
  day: string
  /** Google's `segments.product_item_id`, exactly as sent - lower case and all. */
  itemId: string
  costMicros: bigint
  clicks: bigint
  impressions: bigint
  /** Google Ads' own conversion count for the item, or null where it reported
   *  none. Never this site's attributed sales. */
  conversions: number | null
  conversionsValue: number | null
}

/**
 * One row of the shopping spend report, or null when it is not one.
 *
 * A row with no date or no item id is dropped rather than guessed at: both are
 * half of the primary key, and a row filed under the wrong day is worse than a
 * row that never arrived. A missing METRIC is treated as zero, which is what
 * Google means by leaving one out of a row it did send.
 */
export function parseAdsSpendRow(row: AdsRow): AdsSpendRow | null {
  const segments = record(row.segments)
  const metrics = record(row.metrics)
  const day = text(segments?.date)
  const itemId = text(segments?.productItemId)
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !itemId) return null
  return {
    day,
    itemId,
    costMicros: int64(metrics?.costMicros) ?? 0n,
    clicks: int64(metrics?.clicks) ?? 0n,
    impressions: int64(metrics?.impressions) ?? 0n,
    conversions: float(metrics?.conversions),
    conversionsValue: float(metrics?.conversionsValue),
  }
}

export type AdsAccount = {
  id: string | null
  name: string | null
  currency: string | null
  timeZone: string | null
}

/** The account's own details. Every field is optional in Google's schema, so
 *  every one of them can come back null and the screens say "not known" rather
 *  than inventing a currency. */
export function parseAdsAccount(row: AdsRow | undefined): AdsAccount {
  const customer = record(row?.customer)
  return {
    id: text(customer?.id),
    name: text(customer?.descriptiveName),
    currency: text(customer?.currencyCode)?.toUpperCase() ?? null,
    timeZone: text(customer?.timeZone),
  }
}

export type AdsConversionAction = {
  resourceName: string
  id: string | null
  name: string | null
  type: string | null
  status: string | null
  category: string | null
  /**
   * What Google says. NULL means Google did not send the field at all, which
   * has to be treated as "not known" and never as false: the whole protection
   * against double-counting a sale rests on this being a positive answer from
   * Google, and a missing field read as "secondary" would be exactly the
   * accident it is there to prevent.
   */
  primaryForGoal: boolean | null
}

/** One conversion action, or null when the row carries no resource name to
 *  hang it on. */
export function parseAdsConversionAction(row: AdsRow): AdsConversionAction | null {
  const action = record(row.conversionAction)
  const resourceName = text(action?.resourceName)
  if (!resourceName) return null
  return {
    resourceName,
    id: text(action?.id),
    name: text(action?.name),
    type: text(action?.type)?.toUpperCase() ?? null,
    status: text(action?.status)?.toUpperCase() ?? null,
    category: text(action?.category)?.toUpperCase() ?? null,
    primaryForGoal: typeof action?.primaryForGoal === 'boolean' ? action.primaryForGoal : null,
  }
}

/**
 * The resource name out of a mutate answer.
 *
 * `conversionActions:mutate` replies with `{ results: [{ resourceName }] }`.
 * Null when the reply could not be read, which the caller records as "sent but
 * not confirmed" rather than as a success - the same rule the price push
 * follows.
 */
export function parseMutateResourceName(reply: unknown): string | null {
  const results = record(reply)?.results
  if (!Array.isArray(results)) return null
  return text(record(results[0])?.resourceName)
}
