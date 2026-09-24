// Turning what Google's reports actually send into what we store.
//
// Pure, and deliberately forgiving about shape: every field in a Merchant API
// response is optional, an absent repeated field arrives as no field at all
// rather than an empty array, and int64s arrive as STRINGS. None of that may
// reach a database write, so it is all straightened out here where a test can
// see it.
//
// Confirmed against Google's own reference on 2026-09-22:
//   ProductView.itemIssues[] -> { type: { code, canonicalAttribute },
//                                 severity: { aggregatedSeverity,
//                                             severityPerReportingContext[] },
//                                 resolution }
//   ProductView.aggregatedReportingContextStatus
//   FileUpload -> { processingState, issues[], itemsTotal, itemsCreated,
//                   itemsUpdated, uploadTime }
// Note what is NOT there: a product_view item issue carries no description and
// no documentation link - only the file-level issues do. Google's fuller
// per-issue wording exists on accounts.products
// (ProductStatus.itemLevelIssues), which is one call per product and so is
// never fetched for a whole catalogue - it is fetched for ONE item when an
// owner asks. That second shape is parsed at the bottom of this file.
import {
  asFetchIssueSeverity,
  asFetchState,
  asIssueResolution,
  asIssueSeverity,
  asReportingStatus,
  type FetchIssue,
  type IssueContext,
  type IssueResolution,
  type IssueSeverity,
  type ReportingStatus,
} from '@/modules/google-shopping-for-shop/lib/health/types'

/** An item issue as it comes off the wire, every field optional. */
export type RawItemIssue = {
  type?: { code?: string; canonicalAttribute?: string }
  severity?: {
    aggregatedSeverity?: string
    severityPerReportingContext?: Array<{
      reportingContext?: string
      disapprovedCountries?: string[]
      demotedCountries?: string[]
    }>
  }
  resolution?: string
}

/** One issue, ready for the table. */
export type ParsedItemIssue = {
  code: string
  attribute: string
  severity: IssueSeverity
  resolution: IssueResolution
  contexts: IssueContext[]
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function countryList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const codes = value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim().toUpperCase()).filter(Boolean)
  return [...new Set(codes)].sort()
}

function parseContexts(raw: RawItemIssue): IssueContext[] {
  const list = raw.severity?.severityPerReportingContext
  if (!Array.isArray(list)) return []
  const contexts: IssueContext[] = []
  for (const entry of list) {
    const context = trimmed(entry?.reportingContext)
    if (!context) continue
    contexts.push({
      context,
      disapprovedCountries: countryList(entry?.disapprovedCountries),
      demotedCountries: countryList(entry?.demotedCountries),
    })
  }
  return contexts
}

/**
 * Every issue on one item, de-duplicated by (code, attribute).
 *
 * The de-duplication is not theoretical tidiness: the table is keyed on that
 * pair, so two rows with the same pair in one response would have the second
 * silently overwrite the first inside a single statement, and Postgres refuses
 * an ON CONFLICT batch that hits the same key twice ("cannot affect row a
 * second time"). Merging severities keeps the worst, which is the one worth
 * telling the owner about.
 */
export function parseItemIssues(raw: unknown): ParsedItemIssue[] {
  if (!Array.isArray(raw)) return []
  const byKey = new Map<string, ParsedItemIssue>()
  for (const entry of raw as RawItemIssue[]) {
    // Google returns "?" for a code it cannot name. It is a real code and is
    // kept; an issue with no code at all is not storable and is dropped.
    const code = trimmed(entry?.type?.code)
    if (!code) continue
    const attribute = trimmed(entry?.type?.canonicalAttribute)
    const parsed: ParsedItemIssue = {
      code,
      attribute,
      severity: asIssueSeverity(entry?.severity?.aggregatedSeverity),
      resolution: asIssueResolution(entry?.resolution),
      contexts: parseContexts(entry),
    }
    const key = `${code}\u0000${attribute}`
    const held = byKey.get(key)
    if (!held) {
      byKey.set(key, parsed)
      continue
    }
    byKey.set(key, mergeIssues(held, parsed))
  }
  return [...byKey.values()]
}

const SEVERITY_ORDER: Record<IssueSeverity, number> = { disapproved: 3, demoted: 2, pending: 1, unknown: 0 }

function mergeIssues(a: ParsedItemIssue, b: ParsedItemIssue): ParsedItemIssue {
  const worst = SEVERITY_ORDER[b.severity] > SEVERITY_ORDER[a.severity] ? b : a
  const contexts = [...a.contexts]
  for (const context of b.contexts) {
    if (!contexts.some((held) => held.context === context.context)) contexts.push(context)
  }
  return { ...worst, contexts }
}

export function parseReportingStatus(raw: unknown): ReportingStatus {
  return asReportingStatus(raw)
}

/** Google sends int64 as a decimal string, and sends nothing at all for zero.
 *  Neither of those is a number, and "nothing" is not the same as 0 - a fetch
 *  that reported no count is not a fetch that found none. */
export function parseInt64(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return null
  const parsed = Number(value.trim())
  return Number.isSafeInteger(parsed) ? parsed : null
}

/** An RFC 3339 timestamp from Google, or null when it is missing or nonsense. */
export function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** A FileUpload as it comes off the wire. */
export type RawFileUpload = {
  name?: string
  dataSourceId?: string
  processingState?: string
  issues?: Array<{
    title?: string
    description?: string
    code?: string
    count?: string | number
    severity?: string
    documentationUri?: string
  }>
  itemsTotal?: string | number
  itemsCreated?: string | number
  itemsUpdated?: string | number
  uploadTime?: string
}

export type ParsedFileUpload = {
  state: ReturnType<typeof asFetchState>
  issues: FetchIssue[]
  itemsTotal: number | null
  itemsCreated: number | null
  itemsUpdated: number | null
  uploadedAt: Date | null
}

// A file upload can carry a great many issues, and all of them go on one panel.
// Google sorts nothing, so the worst are taken first and the rest counted.
const MAX_FETCH_ISSUES = 25

export function parseFileUpload(raw: RawFileUpload | null | undefined): ParsedFileUpload {
  const issues: FetchIssue[] = []
  for (const entry of Array.isArray(raw?.issues) ? raw.issues : []) {
    const severity = asFetchIssueSeverity(entry?.severity)
    issues.push({
      title: trimmed(entry?.title) || trimmed(entry?.code) || 'Something Google did not name',
      description: trimmed(entry?.description),
      code: trimmed(entry?.code),
      count: parseInt64(entry?.count) ?? 0,
      severity,
      documentationUri: trimmed(entry?.documentationUri) || null,
    })
  }
  const order: Record<string, number> = { error: 2, warning: 1, unknown: 0 }
  issues.sort((a, b) => (order[b.severity] ?? 0) - (order[a.severity] ?? 0) || b.count - a.count)
  return {
    state: asFetchState(raw?.processingState),
    issues: issues.slice(0, MAX_FETCH_ISSUES),
    itemsTotal: parseInt64(raw?.itemsTotal),
    itemsCreated: parseInt64(raw?.itemsCreated),
    itemsUpdated: parseInt64(raw?.itemsUpdated),
    uploadedAt: parseTimestamp(raw?.uploadTime),
  }
}

/**
 * The fetch URL with its query string removed, which is the ONLY form of it
 * that may be stored or shown.
 *
 * Google's fetchUri is the address we gave it, and that address carries the
 * feed's secret key as a query parameter. The Health tab is gated on
 * `shop.products` while every other place the feed address appears needs
 * `shop.manage`, so keeping the key on this value would hand a products-only
 * user a secret they are not meant to have - through the API response as much
 * as through the rendered page. Host and path are all the owner needs in order
 * to see that Google is reading the address they think it is.
 *
 * Returns '' for anything that will not parse, rather than falling back to the
 * raw string: a URL we cannot take apart is a URL we cannot promise has no key
 * in it.
 */
export function fetchUriForDisplay(fetchUri: string | null | undefined): string {
  if (typeof fetchUri !== 'string' || fetchUri.trim() === '') return ''
  try {
    const parsed = new URL(fetchUri)
    // Built from protocol and host rather than `origin`. Google's fetch
    // settings take HTTP, HTTPS or SFTP, and `origin` is the STRING "null" for
    // any scheme the URL standard does not call special - so an SFTP data
    // source came out as "null/out/feed.xml", losing the host and reading as a
    // bug. `host` also leaves out any user:password, which an SFTP feed
    // address carries and which has no business on a screen either.
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return ''
  }
}

/**
 * Whether a URL Google says it fetches is our feed address.
 *
 * Not a string comparison: the feed URL carries a secret key as a query
 * parameter, and regenerating that key would otherwise make Google's data
 * source stop being ours the moment the owner pressed the button. Origin and
 * path are what identify the feed; the key identifies the caller.
 *
 * Matching is deliberately narrow - same host, same path - so a data source
 * pointing at some other feed on the same site is not claimed as ours.
 */
export function isOurFeedUrl(fetchUri: string, feedUrl: string): boolean {
  let theirs: URL
  let ours: URL
  try {
    theirs = new URL(fetchUri)
    ours = new URL(feedUrl)
  } catch {
    return false
  }
  if (theirs.host.toLowerCase() !== ours.host.toLowerCase()) return false
  const strip = (path: string) => path.replace(/\/+$/, '')
  if (strip(theirs.pathname) !== strip(ours.pathname)) return false
  // The product feed, the review feed and the promotions source all share one
  // path and differ only by `content`, so that one parameter does count.
  return (theirs.searchParams.get('content') ?? '') === (ours.searchParams.get('content') ?? '')
}

// ---------------------------------------------------------------------------
// Google's own words about ONE item (accounts.products)
// ---------------------------------------------------------------------------
//
// A second, richer source than the daily report, used one item at a time when
// an owner asks. Confirmed against Google's own reference on 2026-09-22:
//
//   GET products/v1/accounts/{account}/products/{product}
//   -> Product.productStatus.itemLevelIssues[] -> { code, description, detail,
//      documentation, attribute, reportingContext, resolution, severity,
//      applicableCountries }
//
// Two traps live here, and both cost a 404 rather than a wrong answer, which
// is the only reason they are survivable:
//
//  1. The {product} segment in v1 is `contentLanguage~feedLabel~offerId` -
//     THREE parts. It is the reports API whose product_view.id carries a
//     fourth (`channel~`), and v1beta's product name did too. Passing the
//     report's id straight through would ask for a product that does not
//     exist.
//  2. ItemLevelIssue.severity is its OWN enum - NOT_IMPACTED / DEMOTED /
//     DISAPPROVED - and is not the AggregatedIssueSeverity the report sends.
//     It has no PENDING, and it has a NOT_IMPACTED the report has no word for.

/** One issue as accounts.products describes it. Every field optional. */
export type RawItemLevelIssue = {
  code?: string
  description?: string
  detail?: string
  documentation?: string
  attribute?: string
  reportingContext?: string
  resolution?: string
  severity?: string
  applicableCountries?: string[]
}

export type RawProduct = {
  name?: string
  productStatus?: { itemLevelIssues?: RawItemLevelIssue[] }
}

/** Google's wording for one issue, ready to store and to show. */
export type IssueExplanation = {
  code: string
  attribute: string
  /** Google's short sentence, '' when it sent none. */
  description: string
  /** Google's longer sentence, '' when it sent none. */
  detail: string
  documentationUrl: string | null
  /** Google's per-issue severity, its own vocabulary mapped onto ours.
   *  'unknown' covers both NOT_IMPACTED and anything new. */
  severity: IssueSeverity
  resolution: IssueResolution
  /** Which reporting context Google was talking about, verbatim. */
  reportingContext: string
  applicableCountries: string[]
}

// ItemLevelIssue.severity, which is NOT the report's AggregatedIssueSeverity.
// NOT_IMPACTED has no counterpart in our four, and becomes 'unknown' rather
// than being quietly promoted to something that sounds worse.
const ITEM_LEVEL_SEVERITY: Record<string, IssueSeverity> = {
  DISAPPROVED: 'disapproved',
  DEMOTED: 'demoted',
}

/** Every issue on one product, as Google explains them. */
export function parseItemLevelIssues(raw: RawProduct | null | undefined): IssueExplanation[] {
  const list = raw?.productStatus?.itemLevelIssues
  if (!Array.isArray(list)) return []
  const explanations: IssueExplanation[] = []
  for (const entry of list) {
    const code = trimmed(entry?.code)
    // No code means nothing to match it against the row it explains.
    if (!code) continue
    explanations.push({
      code,
      attribute: trimmed(entry?.attribute),
      description: trimmed(entry?.description),
      detail: trimmed(entry?.detail),
      documentationUrl: trimmed(entry?.documentation) || null,
      severity: typeof entry?.severity === 'string'
        ? ITEM_LEVEL_SEVERITY[entry.severity.trim().toUpperCase()] ?? 'unknown'
        : 'unknown',
      resolution: asIssueResolution(entry?.resolution),
      reportingContext: trimmed(entry?.reportingContext),
      applicableCountries: countryList(entry?.applicableCountries),
    })
  }
  return explanations
}

/** True when Google gave us something worth showing. An issue with a code and
 *  no words is not an explanation, and the screen must say so rather than
 *  drawing an empty box. */
export function hasWords(explanation: IssueExplanation): boolean {
  return explanation.description !== '' || explanation.detail !== '' || explanation.documentationUrl !== null
}

/**
 * The `{product}` segment of a products_v1 resource name.
 *
 * Always base64url encoded, unpadded, which is what Google recommends for
 * every id and REQUIRES for any containing `/`, `%` or `~`. A shop whose SKUs
 * carry a slash is not unusual, and the plain form would break on exactly
 * those and nowhere else - which is the worst kind of bug to ship.
 *
 * Returns null when the feed label is not set: without it there is no name to
 * build, and guessing one asks Google about a product that does not exist.
 *
 * Google also documents a legacy-local form, `local~contentLanguage~feedLabel~offerId`.
 * It is unreachable here: Cactus has no local inventory, so nothing this
 * module sends Google is ever a local product.
 */
export function productResourceSegment(opts: { contentLanguage: string; feedLabel: string | null; offerId: string }): string | null {
  const feedLabel = opts.feedLabel?.trim() ?? ''
  const offerId = opts.offerId.trim()
  if (feedLabel === '' || offerId === '' || opts.contentLanguage.trim() === '') return null
  const plain = `${opts.contentLanguage.trim()}~${feedLabel}~${offerId}`
  return Buffer.from(plain, 'utf8').toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}
