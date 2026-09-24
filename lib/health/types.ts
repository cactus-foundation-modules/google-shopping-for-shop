// The shapes the Health tab works in, and the translation from Google's words
// into ours.
//
// Pure: no database, no fetch, no Prisma. Both the server and the browser
// import this, and every rule in it is testable on its own.
//
// Google's vocabulary is kept at the edge. Everything inside this module talks
// in the lower-case unions below, because Google has renamed these enums before
// (DISCOVERY_ADS to DEMAND_GEN_ADS, mid-2025) and a rename should cost one
// mapping table rather than a search through every screen.

/** How badly one issue hurts, across every reporting context it touches.
 *  'unknown' is Google saying UNSPECIFIED, or saying nothing at all - never our
 *  guess at what it probably meant. */
export const ISSUE_SEVERITIES = ['disapproved', 'demoted', 'pending', 'unknown'] as const
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number]

/** Whose move it is. */
export const ISSUE_RESOLUTIONS = ['merchant_action', 'pending_processing', 'unknown'] as const
export type IssueResolution = (typeof ISSUE_RESOLUTIONS)[number]

/** Google's overall verdict on one item. */
export const REPORTING_STATUSES = ['eligible', 'limited', 'pending', 'not-eligible', 'unknown'] as const
export type ReportingStatus = (typeof REPORTING_STATUSES)[number]

/** The state of Google's last fetch of a data source. */
export const FETCH_STATES = ['succeeded', 'failed', 'in_progress', 'unknown'] as const
export type FetchState = (typeof FETCH_STATES)[number]

/** How severely a whole-file issue reads. Google's own two, plus our shrug. */
export const FETCH_ISSUE_SEVERITIES = ['error', 'warning', 'unknown'] as const
export type FetchIssueSeverity = (typeof FETCH_ISSUE_SEVERITIES)[number]

/** One reporting context an issue bites in, with the countries it bites in. */
export type IssueContext = {
  /** Google's own context name, e.g. 'SHOPPING_ADS'. Kept verbatim: it is a
   *  label on a screen, not something we branch on. */
  context: string
  disapprovedCountries: string[]
  demotedCountries: string[]
}

/** One open or closed issue against one item. */
export type ItemIssue = {
  itemId: string
  code: string
  /** '' where the issue is not about one particular field. */
  attribute: string
  severity: IssueSeverity
  resolution: IssueResolution
  /** Google's own sentence, where something has fetched one.
   *
   *  The daily check reads product_view, which carries neither this nor the
   *  link below. Google's fuller wording lives on accounts.products
   *  (ProductStatus.itemLevelIssues) and is one call per product, so it is
   *  never fetched in bulk - it is filled in one item at a time when an owner
   *  presses "Explain this" (lib/health/explain.ts). Null means nobody has
   *  asked about this row yet. */
  description: string | null
  documentationUrl: string | null
  contexts: IssueContext[]
  detectedAt: string
  lastSeenAt: string
  /** Null while the issue is still being reported. */
  resolvedAt: string | null
}

const SEVERITY_BY_GOOGLE: Record<string, IssueSeverity> = {
  DISAPPROVED: 'disapproved',
  DEMOTED: 'demoted',
  PENDING: 'pending',
}

const RESOLUTION_BY_GOOGLE: Record<string, IssueResolution> = {
  MERCHANT_ACTION: 'merchant_action',
  PENDING_PROCESSING: 'pending_processing',
}

const STATUS_BY_GOOGLE: Record<string, ReportingStatus> = {
  ELIGIBLE: 'eligible',
  ELIGIBLE_LIMITED: 'limited',
  PENDING: 'pending',
  NOT_ELIGIBLE_OR_DISAPPROVED: 'not-eligible',
}

const FETCH_STATE_BY_GOOGLE: Record<string, FetchState> = {
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  IN_PROGRESS: 'in_progress',
}

const FETCH_SEVERITY_BY_GOOGLE: Record<string, FetchIssueSeverity> = {
  ERROR: 'error',
  WARNING: 'warning',
}

/** Anything Google did not spell one of its own ways becomes 'unknown', which
 *  the screens say out loud rather than dressing up as good news. */
export function asIssueSeverity(value: unknown): IssueSeverity {
  return typeof value === 'string' ? SEVERITY_BY_GOOGLE[value.trim().toUpperCase()] ?? 'unknown' : 'unknown'
}

export function asIssueResolution(value: unknown): IssueResolution {
  return typeof value === 'string' ? RESOLUTION_BY_GOOGLE[value.trim().toUpperCase()] ?? 'unknown' : 'unknown'
}

export function asReportingStatus(value: unknown): ReportingStatus {
  return typeof value === 'string' ? STATUS_BY_GOOGLE[value.trim().toUpperCase()] ?? 'unknown' : 'unknown'
}

export function asFetchState(value: unknown): FetchState {
  return typeof value === 'string' ? FETCH_STATE_BY_GOOGLE[value.trim().toUpperCase()] ?? 'unknown' : 'unknown'
}

export function asFetchIssueSeverity(value: unknown): FetchIssueSeverity {
  return typeof value === 'string' ? FETCH_SEVERITY_BY_GOOGLE[value.trim().toUpperCase()] ?? 'unknown' : 'unknown'
}

/** Rows read back out of our own table, where the value was normalised on the
 *  way in. A value written by a newer version this one does not know is still
 *  read, as 'unknown', rather than throwing on the way to a screen. */
export function storedSeverity(value: unknown): IssueSeverity {
  return ISSUE_SEVERITIES.includes(value as IssueSeverity) ? (value as IssueSeverity) : 'unknown'
}

export function storedResolution(value: unknown): IssueResolution {
  return ISSUE_RESOLUTIONS.includes(value as IssueResolution) ? (value as IssueResolution) : 'unknown'
}

export function storedReportingStatus(value: unknown): ReportingStatus | null {
  if (value === null || value === undefined) return null
  return REPORTING_STATUSES.includes(value as ReportingStatus) ? (value as ReportingStatus) : 'unknown'
}

export function storedFetchState(value: unknown): FetchState {
  return FETCH_STATES.includes(value as FetchState) ? (value as FetchState) : 'unknown'
}

export const SEVERITY_LABELS: Record<IssueSeverity, string> = {
  disapproved: 'Turned down',
  demoted: 'Shown less often',
  pending: 'Google is still checking',
  unknown: 'Not known',
}

export const REPORTING_STATUS_LABELS: Record<ReportingStatus, string> = {
  eligible: 'Showing everywhere',
  limited: 'Showing in some places only',
  pending: 'Google is still checking',
  'not-eligible': 'Not being shown',
  unknown: 'Not known',
}

export const FETCH_STATE_LABELS: Record<FetchState, string> = {
  succeeded: 'Read successfully',
  failed: 'Could not be read',
  in_progress: 'Being read now',
  unknown: 'Not known',
}

/** How a Google attribute name reads to somebody who has never seen their API.
 *  Google prefixes its own canonical names with a namespace letter and a colon
 *  ('n:brand'), which means nothing to anyone here. */
export function attributeLabel(attribute: string): string {
  const bare = attribute.includes(':') ? attribute.slice(attribute.indexOf(':') + 1) : attribute
  return bare.replace(/[_-]+/g, ' ').trim()
}

// Google publishes hundreds of issue codes and no machine-readable list of what
// each one means, so there is no table to look one up in. Rather than invent a
// sentence per code - which would be a lie the first time Google added one -
// the code itself is made readable and left as Google's own words. Anything
// more than that comes from Merchant Center, which every issue links to.
/** 'image_link_broken' -> 'Image link broken'. */
export function issueCodeLabel(code: string): string {
  const words = code.replace(/[_-]+/g, ' ').trim()
  if (words === '') return 'Unnamed problem'
  if (words === '?') return 'Problem Google did not name'
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** One line under the code: which field, where it bites. Empty when there is
 *  nothing honest to add. */
export function issueDetailLine(issue: Pick<ItemIssue, 'attribute' | 'contexts'>): string {
  const parts: string[] = []
  const field = attributeLabel(issue.attribute)
  if (field) parts.push(`Field: ${field}`)
  const countries = new Set<string>()
  for (const context of issue.contexts) {
    for (const country of [...context.disapprovedCountries, ...context.demotedCountries]) countries.add(country)
  }
  if (countries.size > 0) parts.push(`In ${[...countries].sort().join(', ')}`)
  return parts.join(' · ')
}

/** One whole-file complaint about the last fetch. */
export type FetchIssue = {
  title: string
  description: string
  code: string
  count: number
  severity: FetchIssueSeverity
  documentationUri: string | null
}

/** The last fetch of one data source, as we hold it. */
export type FeedFetchStatus = {
  dataSourceId: string
  displayName: string | null
  fetchUri: string | null
  state: FetchState
  itemsTotal: number | null
  itemsCreated: number | null
  itemsUpdated: number | null
  issues: FetchIssue[]
  /** When Google fetched, per Google. Null when it never has. */
  uploadedAt: string | null
  /** When we last asked Google. */
  checkedAt: string
}

/** Why we have no feed fetch status to show, when we have none. Each one needs
 *  different words on the screen, so each one is its own answer rather than a
 *  shared null. */
export const FETCH_UNAVAILABLE_REASONS = [
  'no-credentials',
  'no-merchant-id',
  'no-site-url',
  'not-found',
  'denied',
  'error',
] as const
export type FetchUnavailableReason = (typeof FETCH_UNAVAILABLE_REASONS)[number]

export const FETCH_UNAVAILABLE_COPY: Record<FetchUnavailableReason, string> = {
  'no-credentials': 'No Google key has been saved yet, so there is nothing to ask with.',
  'no-merchant-id': 'Fill in your Merchant Center account number on the Google Shopping settings tab and this can be checked.',
  'no-site-url': 'This site does not know its own address yet, so the feed cannot be matched to a Google feed.',
  'not-found': 'Google has no scheduled fetch pointing at this feed address. Add the feed address in Merchant Center, or type the feed number in on the settings tab.',
  denied: 'Google would not let this key read your feed settings. It needs at least the "Standard" access level in Merchant Center.',
  error: 'Google could not be asked just now. This is not an all clear: try again in a moment.',
}
