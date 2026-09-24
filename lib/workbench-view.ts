// One workbench row, worked out: the catalogue half the feed build decided,
// joined to the two halves that change between builds - the owner's title
// template and Google's last match report - with the title rendered, the
// problems named and our price set against the typical one.
//
// Pure. The server builds every row with it; the types are what the browser
// receives.
import { clip, type FeedAvailability } from '@/modules/google-shopping-for-shop/lib/feed-xml'
import { GOOGLE_TITLE_MAX, renderTitleTemplate, type TitleTemplateContext } from '@/modules/google-shopping-for-shop/lib/title-template-render'
import { ISSUE_CODES, type IssueCode } from '@/modules/google-shopping-for-shop/lib/workbench-query'
import type { ItemIssueSummary } from '@/modules/google-shopping-for-shop/lib/health/item-issues'
import type { IssueSeverity, ReportingStatus } from '@/modules/google-shopping-for-shop/lib/health/types'
import type { CustomLabelSlot, RuleRef } from '@/modules/google-shopping-for-shop/lib/feed-rules/types'
import type { ManualChoice } from '@/modules/google-shopping-for-shop/lib/feed-rules/evaluate'

/** Whether the item goes to Google: 'in' it does; 'rule' a feed rule keeps it
 *  out; 'hand' the owner's own "never send" on the product or variation does. */
export type FeedStatus = 'in' | 'rule' | 'hand'

/** What the feed rules did to one item, for the row to say so. */
export type RuleEffects = {
  feedStatus: FeedStatus
  /** The Exclude rule keeping it out, when feedStatus is 'rule'. */
  excludedBy: RuleRef | null
  /** An Exclude rule matched, and the owner's own "always send" beat it. */
  keptInOverRule: RuleRef | null
  /** The owner's own say on this item, after a variation defers to its listing. */
  manualChoice: ManualChoice
  labels: Array<{ slot: CustomLabelSlot; value: string; rule: RuleRef }>
  /** The template a rule sends, when the item has none of its own. */
  ruleTitle: { template: string; rule: RuleRef } | null
  /** Identifier changes a rule made, in the owner's words. */
  identifierNotes: Array<{ text: string; rule: RuleRef }>
  /** Every switched-on rule the item meets, list order, for "filter by rule". */
  matched: RuleRef[]
}

export const NO_RULE_EFFECTS: RuleEffects = {
  feedStatus: 'in',
  excludedBy: null,
  keptInOverRule: null,
  manualChoice: 'rules',
  labels: [],
  ruleTitle: null,
  identifierNotes: [],
  matched: [],
}

/** The catalogue half of a row: everything the feed build decides. Cached
 *  between requests, so it holds nothing the owner can change from the
 *  workbench itself. */
export type WorkbenchBaseItem = {
  /** Feed item id: the variation's own product id, or the standalone product's. */
  id: string
  /** The listing (parent product) a variation belongs to; null when standalone. */
  groupId: string | null
  /** Position in the feed, which keeps a listing's variations together. */
  feedIndex: number
  /** The title the item carries with no template. */
  originalTitle: string
  parentTitle: string
  /** Tokens a template can use, and what each renders as. */
  context: TitleTemplateContext
  sku: string
  mpn: string
  gtin: string
  brand: string
  /** false = the feed tells Google this item has no identifiers at all. */
  identifierExists: boolean
  /** The shop's category trail, e.g. "Office Chairs > Task Chairs". */
  productType: string
  googleProductCategory: string
  /** What a shopper pays today: the sale price while an offer runs. */
  priceAmount: number
  /** The regular price, which equals priceAmount when nothing is on offer. */
  regularPrice: number
  currency: string
  availability: FeedAvailability
  imageUrl: string
  url: string
  /** Lower-cased search text from the fields above. */
  searchText: string
  rules: RuleEffects
}

/** Google's last report on one item, as gsf_item_match_status holds it. */
export type MatchSnapshot = {
  matched: boolean
  merchantTitle: string | null
  benchmarkAmountMicros: string | null
  benchmarkCurrency: string | null
  /** Google's overall verdict. Null on a row written before this column
   *  existed, which reads the same as "no word yet" and never as "fine". */
  reportingStatus: ReportingStatus | null
  checkedAt: Date
}

export type MatchState = 'matched' | 'unmatched' | 'unknown'

export type PricePosition = 'dearer' | 'cheaper' | 'level' | 'no-benchmark'

export type WorkbenchView = WorkbenchBaseItem & {
  /** The item's own template, as typed on this screen. A rule's template is
   *  not this: it is `rules.ruleTitle`, and only applies when this is null. */
  titleTemplate: string | null
  /** The rule whose template the feed is sending, when the item has none of
   *  its own. */
  titleFromRule: RuleRef | null
  /** The title the feed sends today. */
  renderedTitle: string
  unknownTokens: string[]
  matched: MatchState
  /** The title Google held at its last report, '' when it has not reported. */
  merchantTitle: string
  benchmarkAmountMicros: string
  benchmarkCurrency: string
  /** Google's typical price from other sellers, major units. */
  benchmarkAmount: number | null
  /** Our price against the typical one, in whole percent: 12 = 12% dearer. */
  gapPercent: number | null
  pricePosition: PricePosition
  checkedAt: string | null
  issues: IssueCode[]
  /** Google's own verdict, null where Google has not reported on this item. */
  reportingStatus: ReportingStatus | null
  /** Google's open issues against this item: the worst severity and every
   *  code. Null where Google has reported nothing against it - which is not
   *  the same as Google never having looked. */
  googleIssues: { worst: IssueSeverity; codes: string[] } | null
  /** searchText plus the parts that change between requests. */
  haystack: string
}

/** A row as the browser receives it: the view less its search index. */
export type WorkbenchRow = Omit<WorkbenchView, 'searchText' | 'haystack' | 'feedIndex'> & {
  /** Items in the same listing, this one included; 1 when standalone. */
  listingSize: number
}

export type FacetCount = { value: string; count: number }

export type RuleFacet = { id: string; name: string; count: number }

export type WorkbenchSummary = {
  /** Items going to Google. Everything below counts these only, apart from
   *  `outOfFeed` and `rules`. */
  total: number
  /** Items built and then kept out: by a rule, or by the owner's own choice. */
  outOfFeed: { rule: number; hand: number }
  /** Each rule and how many items it touches, in or out of the feed. */
  rules: RuleFacet[]
  matched: number
  unmatched: number
  unknown: number
  overridden: number
  anyIssue: number
  issues: Record<IssueCode, number>
  /** Items by what GOOGLE makes of them. `none` counts items Google has
   *  reported on and had nothing to say about; items Google has never
   *  reported on are in neither. */
  google: { any: number; none: number; disapproved: number; demoted: number; pending: number }
  /** Google's issue codes across the feed, most items first. */
  googleCodes: FacetCount[]
  prices: Record<PricePosition, number>
  /** Most common first. */
  brands: FacetCount[]
  /** The first two levels of every category trail, alphabetical, so a parent
   *  sits directly above its children. */
  categories: FacetCount[]
  lastCheckedAt: string | null
}

function comparableTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().toLowerCase()
}

function benchmarkOf(snapshot: MatchSnapshot | undefined, currency: string): number | null {
  if (!snapshot?.benchmarkAmountMicros) return null
  // A benchmark in another currency cannot be set against ours honestly.
  if (snapshot.benchmarkCurrency && snapshot.benchmarkCurrency !== currency) return null
  const amount = Number(snapshot.benchmarkAmountMicros) / 1_000_000
  return Number.isFinite(amount) && amount > 0 ? amount : null
}

function pricePositionOf(gapPercent: number | null): PricePosition {
  if (gapPercent === null) return 'no-benchmark'
  if (gapPercent > 0) return 'dearer'
  if (gapPercent < 0) return 'cheaper'
  return 'level'
}

function issuesOf(item: WorkbenchBaseItem, renderedTitle: string, unknownTokens: string[], merchantTitle: string): IssueCode[] {
  const found: Record<IssueCode, boolean> = {
    'unknown-token': unknownTokens.length > 0,
    'too-long': renderedTitle.length > GOOGLE_TITLE_MAX,
    // Google has reported, and what it holds is not what the feed now sends
    // (clipped as the feed clips it) - usually a template change the next
    // fetch has not picked up yet.
    'out-of-date': merchantTitle !== '' && comparableTitle(merchantTitle) !== comparableTitle(clip(renderedTitle, GOOGLE_TITLE_MAX)),
    'no-gtin': item.gtin === '',
    'no-brand': item.brand === '',
    'no-identifiers': !item.identifierExists,
  }
  return ISSUE_CODES.filter((code) => found[code])
}

export function buildWorkbenchView(
  item: WorkbenchBaseItem,
  template: string | undefined,
  snapshot: MatchSnapshot | undefined,
  googleIssues?: ItemIssueSummary | undefined,
): WorkbenchView {
  const titleTemplate = template?.trim() || null
  const ruleTitle = titleTemplate === null ? item.rules.ruleTitle : null
  const rendered = renderTitleTemplate(titleTemplate ?? ruleTitle?.template, item.context, item.originalTitle)
  const merchantTitle = snapshot?.merchantTitle?.trim() ?? ''
  const benchmarkAmount = benchmarkOf(snapshot, item.currency)
  const gapPercent = benchmarkAmount === null ? null : Math.round(((item.priceAmount - benchmarkAmount) / benchmarkAmount) * 100)
  return {
    ...item,
    titleTemplate,
    titleFromRule: ruleTitle?.rule ?? null,
    renderedTitle: rendered.title,
    unknownTokens: rendered.unknownTokens,
    matched: snapshot === undefined ? 'unknown' : snapshot.matched ? 'matched' : 'unmatched',
    merchantTitle,
    benchmarkAmountMicros: snapshot?.benchmarkAmountMicros ?? '',
    benchmarkCurrency: snapshot?.benchmarkCurrency ?? '',
    benchmarkAmount,
    gapPercent,
    pricePosition: pricePositionOf(gapPercent),
    checkedAt: snapshot?.checkedAt.toISOString() ?? null,
    issues: issuesOf(item, rendered.title, rendered.unknownTokens, merchantTitle),
    reportingStatus: snapshot?.reportingStatus ?? null,
    googleIssues: googleIssues ?? null,
    // Google's issue codes go in the search index, so typing "image_link_broken"
    // into the box finds exactly the items it is open against.
    haystack: [
      item.searchText,
      rendered.title.toLowerCase(),
      merchantTitle.toLowerCase(),
      titleTemplate?.toLowerCase() ?? '',
      googleIssues?.codes.join(' ').toLowerCase() ?? '',
    ].join('\n'),
  }
}

/** The fixed part of an item's search text, built once per catalogue read. */
export function baseSearchText(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join('\n').toLowerCase()
}

export function toWorkbenchRow(view: WorkbenchView, listingSize: number): WorkbenchRow {
  const { searchText: _searchText, haystack: _haystack, feedIndex: _feedIndex, ...row } = view
  return { ...row, listingSize }
}

function countBy(values: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

/** "A > B > C" -> ["A", "A > B"]: the levels a category filter offers. */
export function categoryLevels(productType: string): string[] {
  const parts = productType.split('>').map((part) => part.trim()).filter(Boolean)
  return parts.slice(0, 2).map((_part, index) => parts.slice(0, index + 1).join(' > '))
}

export function summariseWorkbench(allViews: WorkbenchView[]): WorkbenchSummary {
  const outOfFeed = { rule: 0, hand: 0 }
  const ruleCounts = new Map<string, RuleFacet>()
  const views: WorkbenchView[] = []
  for (const view of allViews) {
    if (view.rules.feedStatus === 'in') views.push(view)
    else outOfFeed[view.rules.feedStatus]++
    for (const ref of view.rules.matched) {
      const facet = ruleCounts.get(ref.id)
      if (facet) facet.count++
      else ruleCounts.set(ref.id, { id: ref.id, name: ref.name, count: 1 })
    }
  }
  const issues: Record<IssueCode, number> = { 'unknown-token': 0, 'too-long': 0, 'out-of-date': 0, 'no-gtin': 0, 'no-brand': 0, 'no-identifiers': 0 }
  const google = { any: 0, none: 0, disapproved: 0, demoted: 0, pending: 0 }
  const googleCodeCounts = new Map<string, number>()
  const prices: Record<PricePosition, number> = { dearer: 0, cheaper: 0, level: 0, 'no-benchmark': 0 }
  let matched = 0
  let unmatched = 0
  let overridden = 0
  let anyIssue = 0
  let lastCheckedAt: string | null = null
  for (const view of views) {
    if (view.matched === 'matched') matched++
    else if (view.matched === 'unmatched') unmatched++
    if (view.titleTemplate !== null) overridden++
    if (view.issues.length > 0) anyIssue++
    for (const code of view.issues) issues[code]++
    if (view.googleIssues) {
      google.any++
      // 'unknown' is a severity Google sent that we do not recognise; it is
      // counted as a problem but sits in none of the three named buckets
      // rather than being filed under a guess.
      if (view.googleIssues.worst !== 'unknown') google[view.googleIssues.worst]++
      for (const code of view.googleIssues.codes) googleCodeCounts.set(code, (googleCodeCounts.get(code) ?? 0) + 1)
    } else if (view.checkedAt !== null) {
      google.none++
    }
    prices[view.pricePosition]++
    if (view.checkedAt && (lastCheckedAt === null || view.checkedAt > lastCheckedAt)) lastCheckedAt = view.checkedAt
  }
  const brands = [...countBy(views.map((view) => view.brand).filter(Boolean))]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
  const categories = [...countBy(views.flatMap((view) => categoryLevels(view.productType)))]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => a.value.localeCompare(b.value))
  const googleCodes = [...googleCodeCounts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
  return {
    total: views.length,
    outOfFeed,
    rules: [...ruleCounts.values()].sort((a, b) => a.name.localeCompare(b.name)),
    matched,
    unmatched,
    unknown: views.length - matched - unmatched,
    overridden,
    anyIssue,
    issues,
    google,
    googleCodes,
    prices,
    brands,
    categories,
    lastCheckedAt,
  }
}
