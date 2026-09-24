// The Google Ads Query Language this module sends.
//
// Pure string building, so every query can be read and tested without a Google
// Ads account - which matters more here than anywhere else in the module,
// because a query language is executed by no typechecker, no linter and no
// build. A reserved word or a misspelt field is a 400 from Google at run time
// and nothing at all before it. This module has already shipped one of those.
//
// Checked against Google's own field reference and the v25 .proto definitions
// on 2026-09-23. The rules that shape what is below:
//
//   - GAQL is written in snake_case whichever interface sends it, even though
//     the ANSWER comes back in lowerCamelCase.
//   - There is no parameter binding. Every value goes into the string, so the
//     only values allowed in are ones proved to be dates.
//   - `shopping_performance_view` carries the product segments; the spend is on
//     `metrics`. Selecting any further segment (title, brand, campaign) splits
//     a day's spend across its values, and the store is keyed on day and item.
//   - "You can only order by fields specified in the SELECT clause."

/** What the spend import asks for, and nothing else. Verified field by field
 *  against Google's reference for shopping_performance_view. */
const SPEND_FIELDS = [
  'segments.date',
  'segments.product_item_id',
  'metrics.cost_micros',
  'metrics.clicks',
  'metrics.impressions',
  // Google Ads' OWN conversion figures for the item, from whatever conversion
  // tracking that account has. Read for the per-item table; never mixed with
  // this site's own attributed sales.
  'metrics.conversions',
  'metrics.conversions_value',
] as const

/**
 * A day, safe to put between quotes.
 *
 * There is no parameter binding in GAQL: the date becomes syntax. Every day
 * reaching here has already been through isDayString, but this is the last gate
 * before a value becomes part of a query, so it refuses anything that is not
 * four digits, two digits and two digits rather than trusting the caller twice.
 */
function dayLiteral(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`Not a date a report can be asked for: ${day}`)
  return day
}

/** One window of the daily spend report, oldest day first so the import can
 *  write a day to the database the moment the reader has moved past it. */
export function adsSpendQuery(options: { from: string; to: string }): string {
  return (
    `SELECT ${SPEND_FIELDS.join(', ')}`
    + ' FROM shopping_performance_view'
    + ` WHERE segments.date BETWEEN '${dayLiteral(options.from)}' AND '${dayLiteral(options.to)}'`
    + ' ORDER BY segments.date ASC'
  )
}

/** The account's own details. One row, always. The currency is what every
 *  cost_micros is denominated in and the timezone is what every `segments.date`
 *  is measured in - neither is ours to assume. */
export const ADS_ACCOUNT_QUERY =
  'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer'

/**
 * The conversion actions this module could upload against.
 *
 * `UPLOAD_CLICKS` is Google's enum for what the Google Ads screens call "Import
 * from clicks". `primary_for_goal` is selected because it is the whole
 * safeguard against double counting, and it is read from Google rather than
 * assumed from what we asked for.
 *
 * DELIBERATELY NOT filtered on `status = 'ENABLED'`. A paused tracker is one
 * the owner switched off in the Google Ads screens, and hiding it here meant
 * the setup found neither the recorded one nor one by name, went on to create a
 * second with the same name, and handed the owner Google's DUPLICATE_NAME
 * refusal instead of "that tracker is switched off at Google Ads". The status
 * is selected and judged afterwards, where there are words for it.
 */
export const ADS_CONVERSION_ACTIONS_QUERY =
  'SELECT conversion_action.resource_name, conversion_action.id, conversion_action.name,'
  + ' conversion_action.type, conversion_action.status, conversion_action.category,'
  + ' conversion_action.primary_for_goal'
  + ' FROM conversion_action'
  + " WHERE conversion_action.type = 'UPLOAD_CLICKS'"

/**
 * One named conversion action, by resource name.
 *
 * Read after creating one, on "Check the connection", and again at the top of
 * EVERY upload run - because "we asked for secondary" and "Google still says it
 * is secondary" are two different claims, and a week-old answer says nothing
 * about what somebody changed in the Google Ads screens yesterday.
 *
 * The resource name is checked rather than trusted: it becomes syntax, and the
 * only shape Google ever issues is customers/{digits}/conversionActions/{digits}.
 */
export function adsConversionActionQuery(resourceName: string): string {
  if (!/^customers\/\d+\/conversionActions\/\d+$/.test(resourceName)) {
    throw new Error('Not a conversion action name Google would recognise')
  }
  return (
    'SELECT conversion_action.resource_name, conversion_action.id, conversion_action.name,'
    + ' conversion_action.type, conversion_action.status, conversion_action.category,'
    + ' conversion_action.primary_for_goal'
    + ' FROM conversion_action'
    + ` WHERE conversion_action.resource_name = '${resourceName}'`
  )
}
