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
//  2. What the workbench edits - title templates and Google's match reports.
//     Fingerprinted on every request (a count and a hash sum over each table,
//     milliseconds), and re-read only when a fingerprint moves. An edit made
//     from any server instance shows on the very next request everywhere.
//
// Search, filters and paging then run over the joined rows in memory, which is
// what turns a search from "rebuild the feed" into a few milliseconds.
import { after } from 'next/server'
import { collectFeedItems, type FeedTitleSource } from '@/modules/google-shopping-for-shop/lib/feed-data'
import type { FeedItem } from '@/modules/google-shopping-for-shop/lib/feed-xml'
import { getAllTitleTemplates } from '@/modules/google-shopping-for-shop/lib/title-templates'
import { sortWorkbench } from '@/modules/google-shopping-for-shop/lib/workbench-filter'
import { readMatchSnapshots, readWorkbenchFingerprints } from '@/modules/google-shopping-for-shop/lib/workbench-tables'
import type { SortOrder } from '@/modules/google-shopping-for-shop/lib/workbench-query'
import {
  baseSearchText,
  buildWorkbenchView,
  summariseWorkbench,
  type MatchSnapshot,
  type WorkbenchBaseItem,
  type WorkbenchSummary,
  type WorkbenchView,
} from '@/modules/google-shopping-for-shop/lib/workbench-view'

const FRESH_FOR_MS = 5 * 60_000
const USABLE_FOR_MS = 60 * 60_000

type CatalogueSnapshot = {
  readAt: number
  items: WorkbenchBaseItem[]
  /** Products the feed held back (no photo), counted so the workbench can say. */
  withheldCount: number
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
  sorted: (order: SortOrder) => readonly WorkbenchView[]
  listingSize: (view: WorkbenchView) => number
}

// Per server instance. Nothing here is the record of anything - every value
// can be rebuilt from the database at any time, which is what makes holding it
// in memory safe.
const cache: {
  catalogue: CatalogueSnapshot | null
  reading: Promise<CatalogueSnapshot> | null
  templates: Fingerprinted<Map<string, string>> | null
  snapshots: Fingerprinted<Map<string, MatchSnapshot>> | null
  joined: JoinedRows | null
} = { catalogue: null, reading: null, templates: null, snapshots: null, joined: null }

function toBaseItem(item: FeedItem, feedIndex: number, source: FeedTitleSource | undefined): WorkbenchBaseItem {
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
  }
}

async function readCatalogue(siteUrl: string): Promise<CatalogueSnapshot> {
  const { items, withheld, titleSources } = await collectFeedItems(siteUrl)
  return {
    readAt: Date.now(),
    items: items.map((item, feedIndex) => toBaseItem(item, feedIndex, titleSources.get(item.id))),
    withheldCount: withheld.length,
  }
}

/** Starts a catalogue read, or joins the one already running - twenty requests
 *  arriving during a cold start build the feed once, not twenty times. */
function catalogueRead(siteUrl: string): Promise<CatalogueSnapshot> {
  if (cache.reading) return cache.reading
  const reading = readCatalogue(siteUrl)
    .then((snapshot) => {
      cache.catalogue = snapshot
      return snapshot
    })
    .finally(() => {
      if (cache.reading === reading) cache.reading = null
    })
  cache.reading = reading
  return reading
}

async function currentCatalogue(siteUrl: string, force: boolean): Promise<{ snapshot: CatalogueSnapshot; stale: boolean }> {
  const held = cache.catalogue
  const age = held ? Date.now() - held.readAt : Infinity
  if (force || !held || age > USABLE_FOR_MS) return { snapshot: await catalogueRead(siteUrl), stale: false }
  if (age <= FRESH_FOR_MS) return { snapshot: held, stale: false }
  if (!cache.reading) {
    // After the response, inside the same invocation's time budget: the owner
    // gets the list now and the next request gets the fresh one.
    after(async () => {
      try {
        await catalogueRead(siteUrl)
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

function joinRows(key: string, catalogue: CatalogueSnapshot, templates: Map<string, string>, snapshots: Map<string, MatchSnapshot>): JoinedRows {
  const views = catalogue.items.map((item) => buildWorkbenchView(item, templates.get(item.id), snapshots.get(item.id)))
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
  const [{ snapshot, stale }, fingerprints] = await Promise.all([
    currentCatalogue(siteUrl, options.forceCatalogue ?? false),
    readWorkbenchFingerprints(),
  ])
  const [templates, snapshots] = await Promise.all([
    currentTemplates(fingerprints.templates),
    currentSnapshots(fingerprints.snapshots),
  ])

  const key = `${snapshot.readAt}|${fingerprints.templates}|${fingerprints.snapshots}`
  const joined = cache.joined?.key === key ? cache.joined : joinRows(key, snapshot, templates, snapshots)
  cache.joined = joined

  return {
    key,
    views: joined.views,
    byId: joined.byId,
    summary: joined.summary,
    catalogueReadAt: new Date(snapshot.readAt),
    catalogueStale: stale,
    withheldCount: snapshot.withheldCount,
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
