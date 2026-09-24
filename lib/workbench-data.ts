// The server-side state behind the Google Shopping workbench: every feed item
// as a workbench row, held in memory between requests.
//
// Pattern: a read-through cache in two layers, each keyed by what it depends on.
//
//  1. The catalogue - what the feed build decides (titles, prices, codes,
//     photos). Building it is the whole feed: thousands of queries and several
//     seconds on a real catalogue. It is read once, served for FRESH_FOR_MS,
//     then served stale while a re-read runs after the response, up to
//     USABLE_FOR_MS, after which a request waits for a new read. Nothing the
//     workbench edits lives in it, so staleness only ever means "a price or
//     product name changed in the shop in the last few minutes".
//
//     Except when what decides the build itself changes - a feed rule, a
//     product's feed choice or typed-in fields - which is fingerprinted too
//     (readWorkbenchFingerprints' `rules`). A held catalogue built under any
//     other fingerprint is not served at all: the request waits for a new
//     build, so a rule saved on one screen shows on the next request, on any
//     server instance.
//
//  2. What the workbench edits or Google reports - title templates, match
//     reports, and the item issues Google raises.
//     Fingerprinted on every request (a count and a hash sum over each table,
//     milliseconds), and re-read only when a fingerprint moves. An edit made
//     from any server instance shows on the very next request everywhere.
//
// Search, filters and paging then run over the joined rows in memory, which is
// what turns a search from "rebuild the feed" into a few milliseconds.
import { after } from 'next/server'
import { collectFeedItems, type FeedRulesRun, type FeedTitleSource } from '@/modules/google-shopping-for-shop/lib/feed-data'
import { EMPTY_OUTCOME, type Exclusion, type ManualChoice, type RuleOutcome } from '@/modules/google-shopping-for-shop/lib/feed-rules/evaluate'
import { CUSTOM_LABEL_SLOTS } from '@/modules/google-shopping-for-shop/lib/feed-rules/types'
import type { FeedItem } from '@/modules/google-shopping-for-shop/lib/feed-xml'
import { getAllTitleTemplates } from '@/modules/google-shopping-for-shop/lib/title-templates'
import { sortWorkbench } from '@/modules/google-shopping-for-shop/lib/workbench-filter'
import { readItemIssueSummaries, type ItemIssueSummary } from '@/modules/google-shopping-for-shop/lib/health/item-issues'
import { readMatchSnapshots, readWorkbenchFingerprints } from '@/modules/google-shopping-for-shop/lib/workbench-tables'
import type { SortOrder } from '@/modules/google-shopping-for-shop/lib/workbench-query'
import {
  baseSearchText,
  buildWorkbenchView,
  summariseWorkbench,
  type MatchSnapshot,
  type RuleEffects,
  type WorkbenchBaseItem,
  type WorkbenchSummary,
  type WorkbenchView,
} from '@/modules/google-shopping-for-shop/lib/workbench-view'

const FRESH_FOR_MS = 5 * 60_000
const USABLE_FOR_MS = 60 * 60_000

type CatalogueSnapshot = {
  readAt: number
  /** When the read began, so a slow read cannot overwrite a newer one. */
  startedAt: number
  /** The `rules` fingerprint the read was started under. */
  rulesFingerprint: string
  items: WorkbenchBaseItem[]
  /** Products the feed held back (no photo), counted so the workbench can say. */
  withheldCount: number
  /** The feed rules as this build ran them, for the Feed Rules preview. */
  rules: FeedRulesRun
}

type Fingerprinted<T> = { fingerprint: string; value: T }

type JoinedRows = {
  key: string
  views: WorkbenchView[]
  byId: Map<string, WorkbenchView>
  listingSizes: Map<string, number>
  summary: WorkbenchSummary
  sorted: Map<SortOrder, WorkbenchView[]>
}

/** Everything a workbench request needs, joined and ready to filter. */
export type WorkbenchState = {
  /** Changes whenever any row could have: the browser uses it to skip
   *  re-sending the summary it already has. */
  key: string
  views: readonly WorkbenchView[]
  byId: ReadonlyMap<string, WorkbenchView>
  summary: WorkbenchSummary
  catalogueReadAt: Date
  /** True while a stale catalogue is served and a re-read runs behind it. */
  catalogueStale: boolean
  withheldCount: number
  rules: FeedRulesRun
  sorted: (order: SortOrder) => readonly WorkbenchView[]
  listingSize: (view: WorkbenchView) => number
}

// Per server instance. Nothing here is the record of anything - every value
// can be rebuilt from the database at any time, which is what makes holding it
// in memory safe.
const cache: {
  catalogue: CatalogueSnapshot | null
  reading: Promise<CatalogueSnapshot> | null
  /** The fingerprint the running read was started under. */
  readingFingerprint: string | null
  templates: Fingerprinted<Map<string, string>> | null
  snapshots: Fingerprinted<Map<string, MatchSnapshot>> | null
  issues: Fingerprinted<Map<string, ItemIssueSummary>> | null
  joined: JoinedRows | null
} = { catalogue: null, reading: null, readingFingerprint: null, templates: null, snapshots: null, issues: null, joined: null }

/** What the rules did to one item, in the shape the row shows. */
export function ruleEffectsOf(outcome: RuleOutcome, manual: ManualChoice): RuleEffects {
  const exclusion: Exclusion | null = outcome.exclusion
  const labels: RuleEffects['labels'] = []
  for (const slot of CUSTOM_LABEL_SLOTS) {
    const label = outcome.labels[slot]
    if (label) labels.push({ slot, value: label.value, rule: label.rule })
  }
  const identifierNotes: RuleEffects['identifierNotes'] = []
  if (outcome.identifiers.brand) identifierNotes.push({ text: `Brand sent as "${outcome.identifiers.brand.value}"`, rule: outcome.identifiers.brand.rule })
  if (outcome.identifiers.mpnFromSku) identifierNotes.push({ text: 'MPN taken from the SKU', rule: outcome.identifiers.mpnFromSku })
  if (outcome.identifiers.noIdentifiers) identifierNotes.push({ text: 'Sent as having no identifiers', rule: outcome.identifiers.noIdentifiers })
  return {
    feedStatus: exclusion === null ? 'in' : exclusion.by,
    excludedBy: exclusion?.by === 'rule' ? exclusion.rule : null,
    keptInOverRule: outcome.keptInOverRule,
    manualChoice: manual,
    labels,
    ruleTitle: outcome.titleTemplate,
    identifierNotes,
    matched: outcome.matched,
  }
}

function toBaseItem(item: FeedItem, feedIndex: number, source: FeedTitleSource | undefined, rules: RuleEffects): WorkbenchBaseItem {
  const originalTitle = source?.originalTitle ?? item.title
  const parentTitle = source?.parentTitle ?? originalTitle
  const context = source?.context ?? {}
  const sku = context.sku ?? ''
  return {
    id: item.id,
    groupId: item.itemGroupId ?? null,
    feedIndex,
    originalTitle,
    parentTitle,
    context,
    sku,
    mpn: item.mpn ?? '',
    gtin: item.gtin ?? '',
    brand: item.brand ?? '',
    identifierExists: item.identifierExists,
    productType: item.productType ?? '',
    googleProductCategory: item.googleProductCategory ?? '',
    priceAmount: item.salePrice ?? item.price,
    regularPrice: item.price,
    currency: item.currency,
    availability: item.availability,
    imageUrl: item.imageLinks[0] ?? '',
    url: item.link,
    searchText: baseSearchText([item.id, originalTitle, parentTitle, sku, item.mpn, item.gtin, item.brand, item.productType]),
    rules,
  }
}

async function readCatalogue(siteUrl: string, rulesFingerprint: string): Promise<CatalogueSnapshot> {
  const startedAt = Date.now()
  const { items, excluded, withheld, titleSources, rules } = await collectFeedItems(siteUrl)
  const manualById = new Map(rules.subjects.map((subject) => [subject.itemId, subject.manual]))
  const base = (item: FeedItem, feedIndex: number) =>
    toBaseItem(item, feedIndex, titleSources.get(item.id), ruleEffectsOf(rules.outcomes.get(item.id) ?? EMPTY_OUTCOME, manualById.get(item.id) ?? 'rules'))
  // What the feed sends first, in feed order; what it keeps back after it,
  // which is only ever on screen when asked for.
  const rows = [...items, ...excluded.map((entry) => entry.item)]
  return {
    readAt: Date.now(),
    startedAt,
    rulesFingerprint,
    items: rows.map(base),
    withheldCount: withheld.length,
    rules,
  }
}

/** Starts a catalogue read, or joins the one already running under the same
 *  fingerprint - twenty requests arriving during a cold start build the feed
 *  once, not twenty times. A read running under an older fingerprint is not
 *  joined: it is building what the rules said a moment ago. */
function catalogueRead(siteUrl: string, rulesFingerprint: string): Promise<CatalogueSnapshot> {
  if (cache.reading && cache.readingFingerprint === rulesFingerprint) return cache.reading
  const reading = readCatalogue(siteUrl, rulesFingerprint)
    .then((snapshot) => {
      // Two reads can overlap when the rules change mid-read; the one started
      // later is the one that knows about the change, whichever ends first.
      if (!cache.catalogue || snapshot.startedAt >= cache.catalogue.startedAt) cache.catalogue = snapshot
      return snapshot
    })
    .finally(() => {
      if (cache.reading === reading) {
        cache.reading = null
        cache.readingFingerprint = null
      }
    })
  cache.reading = reading
  cache.readingFingerprint = rulesFingerprint
  return reading
}

async function currentCatalogue(siteUrl: string, force: boolean, rulesFingerprint: string): Promise<{ snapshot: CatalogueSnapshot; stale: boolean }> {
  const held = cache.catalogue
  const age = held ? Date.now() - held.readAt : Infinity
  const outdated = held !== null && held.rulesFingerprint !== rulesFingerprint
  if (force || !held || outdated || age > USABLE_FOR_MS) return { snapshot: await catalogueRead(siteUrl, rulesFingerprint), stale: false }
  if (age <= FRESH_FOR_MS) return { snapshot: held, stale: false }
  if (!cache.reading) {
    // After the response, inside the same invocation's time budget: the owner
    // gets the list now and the next request gets the fresh one.
    after(async () => {
      try {
        await catalogueRead(siteUrl, rulesFingerprint)
      } catch (error) {
        console.error('[google-shopping] background catalogue read failed:', error)
      }
    })
  }
  return { snapshot: held, stale: true }
}

async function currentTemplates(fingerprint: string): Promise<Map<string, string>> {
  if (cache.templates?.fingerprint === fingerprint) return cache.templates.value
  const value = await getAllTitleTemplates()
  cache.templates = { fingerprint, value }
  return value
}

async function currentSnapshots(fingerprint: string): Promise<Map<string, MatchSnapshot>> {
  if (cache.snapshots?.fingerprint === fingerprint) return cache.snapshots.value
  const value = await readMatchSnapshots()
  cache.snapshots = { fingerprint, value }
  return value
}

async function currentIssues(fingerprint: string): Promise<Map<string, ItemIssueSummary>> {
  if (cache.issues?.fingerprint === fingerprint) return cache.issues.value
  const value = await readItemIssueSummaries()
  cache.issues = { fingerprint, value }
  return value
}

function joinRows(
  key: string,
  catalogue: CatalogueSnapshot,
  templates: Map<string, string>,
  snapshots: Map<string, MatchSnapshot>,
  issues: Map<string, ItemIssueSummary>,
): JoinedRows {
  const views = catalogue.items.map((item) => buildWorkbenchView(item, templates.get(item.id), snapshots.get(item.id), issues.get(item.id)))
  const listingSizes = new Map<string, number>()
  for (const view of views) {
    if (view.groupId) listingSizes.set(view.groupId, (listingSizes.get(view.groupId) ?? 0) + 1)
  }
  return {
    key,
    views,
    byId: new Map(views.map((view) => [view.id, view])),
    listingSizes,
    summary: summariseWorkbench(views),
    sorted: new Map([['feed', views]]),
  }
}

/** The workbench's rows as of now. `forceCatalogue` waits for a fresh read of
 *  the shop rather than serving the one held. */
export async function loadWorkbench(siteUrl: string, options: { forceCatalogue?: boolean } = {}): Promise<WorkbenchState> {
  // Fingerprints first: whether the held catalogue may be served at all
  // depends on the rules one.
  const fingerprints = await readWorkbenchFingerprints()
  const { snapshot, stale } = await currentCatalogue(siteUrl, options.forceCatalogue ?? false, fingerprints.rules)
  const [templates, snapshots, issues] = await Promise.all([
    currentTemplates(fingerprints.templates),
    currentSnapshots(fingerprints.snapshots),
    currentIssues(fingerprints.issues),
  ])

  const key = `${snapshot.readAt}|${fingerprints.templates}|${fingerprints.snapshots}|${fingerprints.issues}`
  const joined = cache.joined?.key === key ? cache.joined : joinRows(key, snapshot, templates, snapshots, issues)
  cache.joined = joined

  return {
    key,
    views: joined.views,
    byId: joined.byId,
    summary: joined.summary,
    catalogueReadAt: new Date(snapshot.readAt),
    catalogueStale: stale,
    withheldCount: snapshot.withheldCount,
    rules: snapshot.rules,
    sorted: (order) => {
      const held = joined.sorted.get(order)
      if (held) return held
      const sorted = sortWorkbench(joined.views, order)
      joined.sorted.set(order, sorted)
      return sorted
    },
    listingSize: (view) => (view.groupId ? joined.listingSizes.get(view.groupId) ?? 1 : 1),
  }
}
