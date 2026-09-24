// The Merchant Center Query Language for the two best sellers reports.
//
// Pure string building, for the same reason lib/performance/query.ts is: a
// query language is executed by no typechecker, no linter and no build. A
// misspelt field is a 400 from Google at run time and silence before it.
//
// Checked against Google's published discovery document for reports_v1 on
// 2026-09-23. The rules it states, each of which shows up below:
//
//   - report_granularity: "Required in the `SELECT` clause. Condition on
//     `report_granularity` is required in the `WHERE` clause."
//   - report_country_code: same - required in SELECT, required in WHERE.
//   - report_category_id: "Required in the `SELECT` clause. If a `WHERE`
//     condition on `report_category_id` is not specified in the query,
//     rankings for all top-level categories are returned."
//   - report_date: "Required in the `SELECT` clause. If a `WHERE` condition on
//     `report_date` is not specified, the latest available weekly or monthly
//     report is returned." We never specify one - the latest is what a shop
//     wants - so the date comes back rather than going in.
//   - "You can only order by fields specified in the `SELECT` clause."
import type { BestSellerGranularity } from '@/modules/google-shopping-for-shop/lib/best-sellers/types'

/** Every field of best_sellers_product_cluster_view worth storing. */
const CLUSTER_FIELDS = [
  'best_sellers_product_cluster_view.report_date',
  'best_sellers_product_cluster_view.report_granularity',
  'best_sellers_product_cluster_view.report_country_code',
  'best_sellers_product_cluster_view.report_category_id',
  'best_sellers_product_cluster_view.rank',
  'best_sellers_product_cluster_view.previous_rank',
  'best_sellers_product_cluster_view.title',
  'best_sellers_product_cluster_view.brand',
  'best_sellers_product_cluster_view.category_l1',
  'best_sellers_product_cluster_view.category_l2',
  'best_sellers_product_cluster_view.category_l3',
  'best_sellers_product_cluster_view.category_l4',
  'best_sellers_product_cluster_view.category_l5',
  'best_sellers_product_cluster_view.relative_demand',
  'best_sellers_product_cluster_view.previous_relative_demand',
  'best_sellers_product_cluster_view.relative_demand_change',
  'best_sellers_product_cluster_view.inventory_status',
  'best_sellers_product_cluster_view.brand_inventory_status',
  'best_sellers_product_cluster_view.variant_gtins',
] as const

const BRAND_FIELDS = [
  'best_sellers_brand_view.report_date',
  'best_sellers_brand_view.report_granularity',
  'best_sellers_brand_view.report_country_code',
  'best_sellers_brand_view.report_category_id',
  'best_sellers_brand_view.rank',
  'best_sellers_brand_view.previous_rank',
  'best_sellers_brand_view.brand',
  'best_sellers_brand_view.relative_demand',
  'best_sellers_brand_view.previous_relative_demand',
  'best_sellers_brand_view.relative_demand_change',
] as const

export type BestSellersQueryOptions = {
  granularity: BestSellerGranularity
  /** ISO 3166-1 alpha-2. The shop's shipping country. */
  countryCode: string
  /**
   * ONE of Google's numeric category ids, or null for no category condition
   * at all - which Google answers with "rankings for all top-level categories".
   *
   * One rather than a list, because LIMIT applies to the whole answer and not
   * to each category in it: a query naming five categories with LIMIT 50 gives
   * fifty rows shared between them, which is a top ten dressed up as a top
   * fifty. The importer asks once per category instead.
   */
  categoryId: string | null
  /** Rows to take. Google's list is long and the top of it is the point. */
  limit: number
}

export function clusterQuery(options: BestSellersQueryOptions): string {
  return build('best_sellers_product_cluster_view', CLUSTER_FIELDS, options)
}

export function brandQuery(options: BestSellersQueryOptions): string {
  return build('best_sellers_brand_view', BRAND_FIELDS, options)
}

function build(table: string, fields: readonly string[], options: BestSellersQueryOptions): string {
  const where = [
    `${table}.report_granularity = '${granularityLiteral(options.granularity)}'`,
    `${table}.report_country_code = '${countryLiteral(options.countryCode)}'`,
  ]
  if (options.categoryId !== null) {
    where.push(`${table}.report_category_id = ${categoryLiteral(options.categoryId)}`)
  }
  return (
    `SELECT ${fields.join(', ')}`
    + ` FROM ${table}`
    + ` WHERE ${where.join(' AND ')}`
    + ` ORDER BY ${table}.rank ASC`
    + ` LIMIT ${limitLiteral(options.limit)}`
  )
}

// There is no parameter binding in this query language, so every value below
// becomes syntax. Each one is checked here rather than trusted from the
// caller: this is the last gate, and a settings column an owner can type into
// is exactly the sort of thing that reaches it.

function granularityLiteral(value: BestSellerGranularity): string {
  if (value !== 'WEEKLY' && value !== 'MONTHLY') throw new Error(`Not a ranking timeframe: ${String(value)}`)
  return value
}

function countryLiteral(value: string): string {
  const code = value.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(code)) throw new Error(`Not a country a ranking can be asked for: ${value}`)
  return code
}

function categoryLiteral(value: string): string {
  const id = value.trim()
  if (!/^\d{1,18}$/.test(id)) throw new Error(`Not a Google category number: ${value}`)
  return id
}

function limitLiteral(value: number): string {
  const limit = Math.trunc(value)
  if (!Number.isFinite(limit) || limit < 1 || limit > 1000) throw new Error(`Not a row count: ${value}`)
  return String(limit)
}
