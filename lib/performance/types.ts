// The shapes the Reports tab works in, and the translation from Google's words
// into ours.
//
// Pure: no database, no fetch, no Prisma. Both the server and the browser
// import this. Google's vocabulary is kept at this edge and nowhere else, the
// same way lib/health/types.ts does it, because Google renames its enums and a
// rename should cost one mapping table rather than a search through every
// screen.

/** Where a click or an impression came from. 'unknown' is Google saying
 *  UNSPECIFIED, or saying nothing at all - never our guess at what it meant. */
export const MARKETING_METHODS = ['organic', 'ads', 'unknown'] as const
export type MarketingMethod = (typeof MARKETING_METHODS)[number]

const METHOD_BY_GOOGLE: Record<string, MarketingMethod> = {
  ORGANIC: 'organic',
  ADS: 'ads',
}

export function asMarketingMethod(value: unknown): MarketingMethod {
  return typeof value === 'string' ? METHOD_BY_GOOGLE[value.trim().toUpperCase()] ?? 'unknown' : 'unknown'
}

/** A value written by a newer version this one does not know is still read, as
 *  'unknown', rather than throwing on the way to a screen. */
export function storedMarketingMethod(value: unknown): MarketingMethod {
  return MARKETING_METHODS.includes(value as MarketingMethod) ? (value as MarketingMethod) : 'unknown'
}

export const MARKETING_METHOD_LABELS: Record<MarketingMethod, string> = {
  organic: 'Free listings',
  ads: 'Paid ads',
  unknown: 'Not known',
}

/** One day's figures for one offer on one marketing method, as we hold them.
 *
 *  `conversions` and `conversionValueMicros` are null where Google does not
 *  report them - which is every paid row, per Google's own reference - and
 *  null is NOT zero. Everything that adds these up keeps the two apart. */
export type PerformanceRow = {
  /** 'YYYY-MM-DD' in the Merchant Center account's timezone, which Google
   *  chooses and never tells us. */
  day: string
  itemId: string
  method: MarketingMethod
  clicks: number
  impressions: number
  /** Google's own rate for this row, or null where it sent none. Never summed
   *  or averaged: a total's rate is summed clicks over summed impressions. */
  clickThroughRate: number | null
  conversions: number | null
  conversionValueMicros: bigint | null
  conversionCurrency: string | null
}

/** Clicks, impressions and what came of them, over some span. The shape every
 *  headline figure and every chart point is in. */
export type PerformanceTotals = {
  clicks: number
  impressions: number
  /** Null where nothing was shown at all - a rate with no denominator is not
   *  zero per cent, it is no answer. */
  clickThroughRate: number | null
  /** Null where Google reported no conversions for any row in the span, which
   *  is the normal state of a paid total. */
  conversions: number | null
  conversionValue: number | null
  conversionCurrency: string | null
}

export const EMPTY_TOTALS: PerformanceTotals = {
  clicks: 0,
  impressions: 0,
  clickThroughRate: null,
  conversions: null,
  conversionValue: null,
  conversionCurrency: null,
}

/** Summed clicks over summed impressions, or null where nothing was shown.
 *  The ONLY way a rate is worked out for more than one row. */
export function rateOf(clicks: number, impressions: number): number | null {
  return impressions > 0 ? clicks / impressions : null
}

/** Google sends money as a whole number of millionths. 1_000_000 micros is one
 *  pound. Returns null rather than 0 for anything that is not a whole number,
 *  because a total of zero and "Google sent something we could not read" must
 *  not look the same. */
export function microsToUnits(micros: bigint | null): number | null {
  if (micros === null) return null
  return Number(micros) / 1_000_000
}

/** Why an import did nothing. Each one needs different words on the screen,
 *  so each is its own answer rather than a shared null. Here, in the pure
 *  module, because both the job and the screen name them - the same place
 *  lib/health/types.ts keeps FETCH_UNAVAILABLE_REASONS. */
export const IMPORT_SKIP_REASONS = ['no-credentials', 'no-merchant-id', 'switched-off', 'nothing-to-do'] as const
export type ImportSkipReason = (typeof IMPORT_SKIP_REASONS)[number]

export const IMPORT_SKIP_COPY: Record<ImportSkipReason, string> = {
  'no-credentials': 'No Google key has been saved yet, so there is nothing to ask with.',
  'no-merchant-id': 'Fill in your Merchant Center account number on the Google Shopping settings tab and these figures can be fetched.',
  'switched-off': 'Fetching Google\u2019s figures is switched off, so nothing was brought in.',
  'nothing-to-do': 'Everything Google has published so far is already here.',
}

/** How the per-product table is ordered. Lives here, in the pure module,
 *  rather than beside the query that uses it: the Reports tab draws a column
 *  header per sort, and importing the list from the file that reaches Prisma
 *  would drag the database client into the browser bundle. */
export const PRODUCT_SORTS = ['clicks', 'impressions', 'ctr', 'conversions'] as const
export type ProductSort = (typeof PRODUCT_SORTS)[number]

export function isProductSort(value: unknown): value is ProductSort {
  return typeof value === 'string' && (PRODUCT_SORTS as readonly string[]).includes(value)
}

/** The spans the headline figures are offered over. 'custom' is two dates the
 *  owner picked. */
export const REPORT_RANGES = ['today', '7', '30', '90', 'custom'] as const
export type ReportRange = (typeof REPORT_RANGES)[number]

export function isReportRange(value: unknown): value is ReportRange {
  return typeof value === 'string' && (REPORT_RANGES as readonly string[]).includes(value)
}

export const REPORT_RANGE_LABELS: Record<ReportRange, string> = {
  today: 'Today',
  '7': 'Last 7 days',
  '30': 'Last 30 days',
  '90': 'Last 90 days',
  custom: 'Pick your own dates',
}
