// The Merchant Center Query Language this module sends for performance figures.
//
// Pure string building, so the queries can be read and tested without a Google
// account - which matters more here than usual, because a query language is
// executed by no typechecker, no linter and no test suite. A reserved word or a
// misspelt field is a 400 from Google at run time and nothing at all before it.
//
// Checked against Google's published discovery document for reports_v1 on
// 2026-09-23. The rules that shape what is below:
//
//   - "Condition on `date` is required in the `WHERE` clause" (ProductPerformanceView.date).
//   - "You must select at least one metrics field in performance queries."
//   - "Segment fields cannot be selected in queries without also selecting at
//     least one metric field."
//   - "You can only order by fields specified in the `SELECT` clause."
//   - Dates are ISO 8601 in quotes: `date BETWEEN '2021-01-01' AND '2021-01-31'`.

/** The three segments, and no others. Every extra segment splits a day's
 *  clicks across its values, and the store is keyed on exactly these three.
 *  See migration 022 for the full reasoning. */
const SEGMENTS = [
  'product_performance_view.date',
  'product_performance_view.offer_id',
  'product_performance_view.marketing_method',
] as const

/** What every account can be asked for. */
const CORE_METRICS = [
  'product_performance_view.clicks',
  'product_performance_view.impressions',
  'product_performance_view.click_through_rate',
] as const

/** Google's reference marks these "available only for the `FREE` traffic
 *  source", so they arrive on organic rows and not on paid ones. What it does
 *  not say is whether an account that cannot have them at all is answered with
 *  nulls or with a refusal - so the import asks for them, and falls back to the
 *  core metrics alone if Google turns the whole query down. */
const CONVERSION_METRICS = [
  'product_performance_view.conversions',
  'product_performance_view.conversion_value',
] as const

export type PerformanceQueryOptions = {
  /** 'YYYY-MM-DD', inclusive. */
  from: string
  to: string
  /** False sends the core metrics alone - the fallback after a refusal. */
  withConversions: boolean
}

/**
 * One window of the daily performance report.
 *
 * Ordered by date so the import can flush a day to the database the moment the
 * reader has moved past it, rather than holding a whole quarter in memory.
 */
export function performanceQuery(options: PerformanceQueryOptions): string {
  const fields = [
    ...SEGMENTS,
    ...CORE_METRICS,
    ...(options.withConversions ? CONVERSION_METRICS : []),
  ]
  return (
    `SELECT ${fields.join(', ')}`
    + ' FROM product_performance_view'
    + ` WHERE product_performance_view.date BETWEEN '${dayLiteral(options.from)}' AND '${dayLiteral(options.to)}'`
    + ' ORDER BY product_performance_view.date ASC'
  )
}

/**
 * A day, safe to put between quotes.
 *
 * There is no parameter binding in this query language: the date goes into the
 * string. Every day reaching here has already been through isDayString, but
 * this is the last gate before a value becomes syntax, so it refuses anything
 * that is not four digits, two digits and two digits rather than trusting the
 * caller twice.
 */
function dayLiteral(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`Not a date a report can be asked for: ${day}`)
  return day
}
