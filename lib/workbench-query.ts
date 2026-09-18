// The Google Shopping workbench's list query: what the owner is looking for,
// how it is ordered and which page of it they are on.
//
// One definition shared by the browser (which keeps it in the address bar) and
// the server (which filters by it), so a link copied out of the workbench opens
// the same list for anyone, and the export and the bulk "everything matching"
// actions act on exactly the rows on screen. Pure - safe to import anywhere.
import { z } from 'zod'

export const MATCH_FILTERS = ['all', 'matched', 'unmatched', 'unknown'] as const
export const OVERRIDE_FILTERS = ['all', 'overridden', 'plain'] as const
export const ISSUE_FILTERS = ['all', 'any', 'unknown-token', 'too-long', 'out-of-date', 'no-gtin', 'no-brand', 'no-identifiers'] as const
export const PRICE_FILTERS = ['all', 'dearer', 'cheaper', 'level', 'no-benchmark'] as const
export const SORT_ORDERS = ['feed', 'title', 'price-asc', 'price-desc', 'gap-desc', 'gap-asc', 'length-desc'] as const
export const PAGE_SIZES = [25, 50, 100, 200] as const

export type MatchFilter = (typeof MATCH_FILTERS)[number]
export type OverrideFilter = (typeof OVERRIDE_FILTERS)[number]
export type IssueFilter = (typeof ISSUE_FILTERS)[number]
export type IssueCode = Exclude<IssueFilter, 'all' | 'any'>
export type PriceFilter = (typeof PRICE_FILTERS)[number]
export type SortOrder = (typeof SORT_ORDERS)[number]
export type PageSize = (typeof PAGE_SIZES)[number]

export const ISSUE_CODES: readonly IssueCode[] = ISSUE_FILTERS.filter(
  (issue): issue is IssueCode => issue !== 'all' && issue !== 'any',
)

/** How each issue reads to an owner, short enough for a chip. */
export const ISSUE_LABELS: Record<IssueCode, string> = {
  'unknown-token': 'Unknown token',
  'too-long': 'Title over 150 characters',
  'out-of-date': "Google's title is out of date",
  'no-gtin': 'No barcode (GTIN)',
  'no-brand': 'No brand',
  'no-identifiers': 'Sent as "no identifiers"',
}

export const SORT_LABELS: Record<SortOrder, string> = {
  feed: 'Feed order (listings together)',
  title: 'Title A-Z',
  'price-asc': 'Price, low to high',
  'price-desc': 'Price, high to low',
  'gap-desc': 'Dearest against typical',
  'gap-asc': 'Cheapest against typical',
  'length-desc': 'Longest title first',
}

export type WorkbenchQuery = {
  /** Free text. Every word must appear somewhere in the item. */
  search: string
  match: MatchFilter
  override: OverrideFilter
  issue: IssueFilter
  price: PriceFilter
  /** Exact brand, or '' for any. */
  brand: string
  /** Category trail prefix, e.g. "Office Chairs" or "Office Chairs > Task Chairs". */
  category: string
  /** One listing's variations only (the parent product id), or '' for all. */
  group: string
  sort: SortOrder
  page: number
  perPage: PageSize
}

export const DEFAULT_WORKBENCH_QUERY: WorkbenchQuery = {
  search: '',
  match: 'all',
  override: 'all',
  issue: 'all',
  price: 'all',
  brand: '',
  category: '',
  group: '',
  sort: 'feed',
  page: 1,
  perPage: 50,
}

// Address-bar names. Short, and none of them `tab`, which the host page owns.
const PARAM = {
  search: 'q',
  match: 'match',
  override: 'override',
  issue: 'issue',
  price: 'price',
  brand: 'brand',
  category: 'category',
  group: 'listing',
  sort: 'sort',
  page: 'page',
  perPage: 'per',
} as const satisfies Record<keyof WorkbenchQuery, string>

// Every field falls back to its default rather than failing: a hand-edited or
// stale link should open the workbench, not an error.
const QuerySchema = z.object({
  search: z.string().trim().max(200).catch(DEFAULT_WORKBENCH_QUERY.search),
  match: z.enum(MATCH_FILTERS).catch(DEFAULT_WORKBENCH_QUERY.match),
  override: z.enum(OVERRIDE_FILTERS).catch(DEFAULT_WORKBENCH_QUERY.override),
  issue: z.enum(ISSUE_FILTERS).catch(DEFAULT_WORKBENCH_QUERY.issue),
  price: z.enum(PRICE_FILTERS).catch(DEFAULT_WORKBENCH_QUERY.price),
  brand: z.string().trim().max(200).catch(DEFAULT_WORKBENCH_QUERY.brand),
  category: z.string().trim().max(500).catch(DEFAULT_WORKBENCH_QUERY.category),
  group: z.string().trim().max(100).catch(DEFAULT_WORKBENCH_QUERY.group),
  sort: z.enum(SORT_ORDERS).catch(DEFAULT_WORKBENCH_QUERY.sort),
  page: z.coerce.number().int().min(1).max(100_000).catch(DEFAULT_WORKBENCH_QUERY.page),
  perPage: z.coerce
    .number()
    .refine((value): value is PageSize => (PAGE_SIZES as readonly number[]).includes(value))
    .catch(DEFAULT_WORKBENCH_QUERY.perPage),
})

/** The query as a JSON body carries it (bulk actions). Same fallbacks. */
export function parseWorkbenchQueryObject(input: unknown): WorkbenchQuery {
  const source = typeof input === 'object' && input !== null ? input : {}
  return QuerySchema.parse({ ...DEFAULT_WORKBENCH_QUERY, ...source })
}

/** Reads the query out of URL search params, ignoring anything it does not own. */
export function parseWorkbenchQuery(params: URLSearchParams): WorkbenchQuery {
  const raw: Partial<Record<keyof WorkbenchQuery, string>> = {}
  for (const key of Object.keys(PARAM) as Array<keyof WorkbenchQuery>) {
    const value = params.get(PARAM[key])
    if (value !== null) raw[key] = value
  }
  return parseWorkbenchQueryObject(raw)
}

/** Writes the query into `params`, leaving out defaults so links stay short and
 *  leaving alone every parameter it does not own (the host page's `tab`). */
export function writeWorkbenchQuery(query: WorkbenchQuery, params: URLSearchParams): URLSearchParams {
  for (const key of Object.keys(PARAM) as Array<keyof WorkbenchQuery>) {
    const value = query[key]
    if (value === DEFAULT_WORKBENCH_QUERY[key] || value === '') params.delete(PARAM[key])
    else params.set(PARAM[key], String(value))
  }
  return params
}

/** True when anything narrows the list - the "Clear filters" test. Sort and
 *  page size are preferences, not filters. */
export function isFilteredQuery(query: WorkbenchQuery): boolean {
  return query.search !== ''
    || query.match !== 'all'
    || query.override !== 'all'
    || query.issue !== 'all'
    || query.price !== 'all'
    || query.brand !== ''
    || query.category !== ''
    || query.group !== ''
}
