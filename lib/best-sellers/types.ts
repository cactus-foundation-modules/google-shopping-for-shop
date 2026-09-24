// What Google says is selling, in our own words.
//
// Pure: no database, no fetch, no Prisma. Google's vocabulary is mapped at this
// edge and nowhere else, the same way lib/health/types.ts does it.
//
// The one thing worth knowing before reading any of this: GOOGLE'S BEST SELLERS
// REPORT CARRIES NO OFFER IDS. It ranks product CLUSTERS - a grouping of every
// retailer's listings for the same thing - and brands. There is nothing in it
// to join to our feed on. The two honest answers to "do I sell this?" are
// Google's own inventoryStatus, which says whether the cluster is in your
// product data source, and the example GTINs, which can be matched against the
// shop's own barcodes. Both are used; neither is presented as more certain than
// it is.

export const BEST_SELLER_KINDS = ['cluster', 'brand'] as const
export type BestSellerKind = (typeof BEST_SELLER_KINDS)[number]

export function isBestSellerKind(value: unknown): value is BestSellerKind {
  return typeof value === 'string' && (BEST_SELLER_KINDS as readonly string[]).includes(value)
}

/** Google's ranking timeframe. Their own words, upper case, because the value
 *  travels verbatim into the query. */
export const BEST_SELLER_GRANULARITIES = ['WEEKLY', 'MONTHLY'] as const
export type BestSellerGranularity = (typeof BEST_SELLER_GRANULARITIES)[number]

export function asGranularity(value: unknown): BestSellerGranularity {
  const wanted = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return (BEST_SELLER_GRANULARITIES as readonly string[]).includes(wanted)
    ? (wanted as BestSellerGranularity)
    : 'WEEKLY'
}

export const GRANULARITY_LABELS: Record<BestSellerGranularity, string> = {
  WEEKLY: 'Week by week',
  MONTHLY: 'Month by month',
}

/** How much of the top seller's demand this one gets. */
export const RELATIVE_DEMANDS = ['very-low', 'low', 'medium', 'high', 'very-high', 'unknown'] as const
export type RelativeDemand = (typeof RELATIVE_DEMANDS)[number]

const DEMAND_BY_GOOGLE: Record<string, RelativeDemand> = {
  VERY_LOW: 'very-low',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  VERY_HIGH: 'very-high',
}

export function asRelativeDemand(value: unknown): RelativeDemand {
  return typeof value === 'string' ? DEMAND_BY_GOOGLE[value.trim().toUpperCase()] ?? 'unknown' : 'unknown'
}

export function storedRelativeDemand(value: unknown): RelativeDemand {
  return RELATIVE_DEMANDS.includes(value as RelativeDemand) ? (value as RelativeDemand) : 'unknown'
}

export const DEMAND_LABELS: Record<RelativeDemand, string> = {
  'very-low': 'Very low',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  'very-high': 'Very high',
  unknown: 'Not known',
}

/** Which way the demand went since the previous week or month. */
export const DEMAND_CHANGES = ['riser', 'flat', 'sinker', 'unknown'] as const
export type DemandChange = (typeof DEMAND_CHANGES)[number]

const CHANGE_BY_GOOGLE: Record<string, DemandChange> = {
  RISER: 'riser',
  FLAT: 'flat',
  SINKER: 'sinker',
}

export function asDemandChange(value: unknown): DemandChange {
  return typeof value === 'string' ? CHANGE_BY_GOOGLE[value.trim().toUpperCase()] ?? 'unknown' : 'unknown'
}

export function storedDemandChange(value: unknown): DemandChange {
  return DEMAND_CHANGES.includes(value as DemandChange) ? (value as DemandChange) : 'unknown'
}

export const CHANGE_LABELS: Record<DemandChange, string> = {
  riser: 'Rising',
  flat: 'Steady',
  sinker: 'Falling',
  unknown: 'Not known',
}

/** Google's own answer to whether the thing is in your product data source.
 *  Note their caveat: it ignores the report's country filter. */
export const INVENTORY_STATUSES = ['in-stock', 'out-of-stock', 'not-in-inventory', 'unknown'] as const
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number]

const INVENTORY_BY_GOOGLE: Record<string, InventoryStatus> = {
  IN_STOCK: 'in-stock',
  OUT_OF_STOCK: 'out-of-stock',
  NOT_IN_INVENTORY: 'not-in-inventory',
}

export function asInventoryStatus(value: unknown): InventoryStatus {
  return typeof value === 'string' ? INVENTORY_BY_GOOGLE[value.trim().toUpperCase()] ?? 'unknown' : 'unknown'
}

export function storedInventoryStatus(value: unknown): InventoryStatus {
  return INVENTORY_STATUSES.includes(value as InventoryStatus) ? (value as InventoryStatus) : 'unknown'
}

export const INVENTORY_LABELS: Record<InventoryStatus, string> = {
  'in-stock': 'In your catalogue, in stock',
  'out-of-stock': 'In your catalogue, out of stock',
  'not-in-inventory': 'Not in your catalogue',
  unknown: 'Not known',
}

/** One row of either best sellers report, as we store it. */
export type BestSellerRow = {
  kind: BestSellerKind
  /** 'YYYY-MM-DD': the first day of the week or month the ranking covers. */
  reportDate: string
  granularity: BestSellerGranularity
  countryCode: string
  /** Google's numeric product category id, as text. */
  categoryId: string
  rank: number
  previousRank: number | null
  /** The cluster's title. Null on a brand row. */
  title: string | null
  brand: string | null
  /** Google's own taxonomy trail for the cluster. Null on a brand row. */
  categoryPath: string | null
  relativeDemand: RelativeDemand
  previousRelativeDemand: RelativeDemand
  demandChange: DemandChange
  inventoryStatus: InventoryStatus
  brandInventoryStatus: InventoryStatus
  variantGtins: string[]
}

/** Whether this shop sells the thing, and on whose authority.
 *
 *  'matched'    we found one of Google's example GTINs in the shop's own
 *               barcodes. The strongest answer, and the only one that can
 *               name a product.
 *  'google'     Google says it is in the product data source, but we could
 *               not match a barcode - often because Google gave no example
 *               GTINs, or because the shop's barcodes are its own.
 *  'no'         Google says it is not in the data source and nothing matched.
 *  'unknown'    Google said nothing useful and there was nothing to match on.
 *               Shown as "not known", never as a no. */
export const CATALOGUE_VERDICTS = ['matched', 'google', 'no', 'unknown'] as const
export type CatalogueVerdict = (typeof CATALOGUE_VERDICTS)[number]

export const VERDICT_LABELS: Record<CatalogueVerdict, string> = {
  matched: 'You sell this',
  google: 'Google says you list this',
  no: 'Not in your catalogue',
  unknown: 'Not known',
}

/**
 * The verdict, from the two things we have.
 *
 * A barcode match wins outright: it names a product, which nothing else here
 * can. Google's own inventory status answers next. Everything else is "not
 * known", never a no - telling an owner they do not sell something they do
 * sell is how a report stops being believed.
 */
export function catalogueVerdict(input: { matchedProductId: string | null; inventoryStatus: InventoryStatus }): CatalogueVerdict {
  if (input.matchedProductId) return 'matched'
  if (input.inventoryStatus === 'in-stock' || input.inventoryStatus === 'out-of-stock') return 'google'
  if (input.inventoryStatus === 'not-in-inventory') return 'no'
  return 'unknown'
}

/** Why a best sellers fetch did nothing. Same reasoning as the performance
 *  import's own list: each needs its own words, and both the job and the
 *  screen name them. */
export const BEST_SELLERS_SKIP_REASONS = ['no-credentials', 'no-merchant-id', 'switched-off'] as const
export type BestSellersSkipReason = (typeof BEST_SELLERS_SKIP_REASONS)[number]

export const BEST_SELLERS_SKIP_COPY: Record<BestSellersSkipReason, string> = {
  'no-credentials': 'No Google key has been saved yet, so there is nothing to ask with.',
  'no-merchant-id': 'Fill in your Merchant Center account number on the Google Shopping settings tab and these rankings can be fetched.',
  'switched-off': 'Best sellers is switched off, so nothing was brought in.',
}
