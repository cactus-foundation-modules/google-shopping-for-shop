// Narrowing, ordering and paging the workbench's rows by a WorkbenchQuery.
// Pure and in-memory: the server holds every row already, and a pass over
// twenty thousand of them costs a few milliseconds, where asking the database
// the same question would mean rebuilding the feed.
import type { PriceFilter, SortOrder, WorkbenchQuery } from '@/modules/google-shopping-for-shop/lib/workbench-query'
import type { WorkbenchView } from '@/modules/google-shopping-for-shop/lib/workbench-view'

/** Search words, lower-cased. A "quoted phrase" stays one word. */
export function searchTerms(search: string): string[] {
  const terms: string[] = []
  for (const match of search.toLowerCase().matchAll(/"([^"]+)"|(\S+)/g)) {
    const term = (match[1] ?? match[2] ?? '').trim()
    if (term) terms.push(term)
  }
  return terms
}

function inCategory(productType: string, category: string): boolean {
  return productType === category || productType.startsWith(`${category} > `)
}

function matchesPrice(view: WorkbenchView, price: PriceFilter): boolean {
  return price === 'all' || view.pricePosition === price
}

/** One row against every filter in the query. Search is last: it is the only
 *  test that reads strings. */
export function matchesWorkbenchQuery(view: WorkbenchView, query: WorkbenchQuery, terms: string[]): boolean {
  if (query.match !== 'all' && view.matched !== query.match) return false
  if (query.override === 'overridden' && view.titleTemplate === null) return false
  if (query.override === 'plain' && view.titleTemplate !== null) return false
  if (query.issue === 'any' && view.issues.length === 0) return false
  if (query.issue !== 'all' && query.issue !== 'any' && !view.issues.includes(query.issue)) return false
  if (!matchesPrice(view, query.price)) return false
  if (query.brand !== '' && view.brand !== query.brand) return false
  if (query.category !== '' && !inCategory(view.productType, query.category)) return false
  if (query.group !== '' && view.groupId !== query.group && view.id !== query.group) return false
  return terms.every((term) => view.haystack.includes(term))
}

/** Every row the query matches, in the order `views` arrives in. */
export function filterWorkbench(views: readonly WorkbenchView[], query: WorkbenchQuery): WorkbenchView[] {
  const terms = searchTerms(query.search)
  return views.filter((view) => matchesWorkbenchQuery(view, query, terms))
}

const collator = new Intl.Collator('en-GB', { sensitivity: 'base', numeric: true })

// Rows with no benchmark sort after every row that has one, whichever way the
// gap sort runs: "no comparison" is not the cheapest or the dearest.
function compareGap(a: WorkbenchView, b: WorkbenchView, direction: 1 | -1): number {
  if (a.gapPercent === null && b.gapPercent === null) return a.feedIndex - b.feedIndex
  if (a.gapPercent === null) return 1
  if (b.gapPercent === null) return -1
  return (a.gapPercent - b.gapPercent) * direction || a.feedIndex - b.feedIndex
}

const COMPARATORS: Record<SortOrder, (a: WorkbenchView, b: WorkbenchView) => number> = {
  feed: (a, b) => a.feedIndex - b.feedIndex,
  title: (a, b) => collator.compare(a.renderedTitle, b.renderedTitle) || a.feedIndex - b.feedIndex,
  'price-asc': (a, b) => a.priceAmount - b.priceAmount || a.feedIndex - b.feedIndex,
  'price-desc': (a, b) => b.priceAmount - a.priceAmount || a.feedIndex - b.feedIndex,
  'gap-desc': (a, b) => compareGap(a, b, -1),
  'gap-asc': (a, b) => compareGap(a, b, 1),
  'length-desc': (a, b) => b.renderedTitle.length - a.renderedTitle.length || a.feedIndex - b.feedIndex,
}

/** A sorted copy; `views` is left as it was. */
export function sortWorkbench(views: readonly WorkbenchView[], sort: SortOrder): WorkbenchView[] {
  return [...views].sort(COMPARATORS[sort])
}

export type WorkbenchPage<T> = { rows: T[]; page: number; pageCount: number; total: number }

/** One page of `rows`. A page past the end answers with the last page rather
 *  than an empty one - a filter that shrinks the list should not strand the
 *  owner on page 40 of 3. */
export function pageOf<T>(rows: readonly T[], page: number, perPage: number): WorkbenchPage<T> {
  const pageCount = Math.max(1, Math.ceil(rows.length / perPage))
  const current = Math.min(Math.max(1, page), pageCount)
  const start = (current - 1) * perPage
  return { rows: rows.slice(start, start + perPage), page: current, pageCount, total: rows.length }
}
