// Google's best sellers answer, turned into rows we can store.
//
// Pure. Field names and types checked against Google's published discovery
// document for reports_v1 on 2026-09-23:
//   rank, previousRank, reportCategoryId   int64, and therefore STRINGS
//   reportDate                             google.type.Date { year, month, day }
//   variantGtins                           array of string
//   relativeDemand, previousRelativeDemand RELATIVE_DEMAND_ENUM_*
//   relativeDemandChange                   SINKER | FLAT | RISER
//   inventoryStatus, brandInventoryStatus  IN_STOCK | OUT_OF_STOCK | NOT_IN_INVENTORY
import { dayFromGoogle } from '@/modules/google-shopping-for-shop/lib/performance/days'
import {
  asDemandChange,
  asGranularity,
  asInventoryStatus,
  asRelativeDemand,
  type BestSellerRow,
} from '@/modules/google-shopping-for-shop/lib/best-sellers/types'

type ClusterView = {
  reportDate?: unknown
  reportGranularity?: unknown
  reportCountryCode?: unknown
  reportCategoryId?: unknown
  rank?: unknown
  previousRank?: unknown
  title?: unknown
  brand?: unknown
  categoryL1?: unknown
  categoryL2?: unknown
  categoryL3?: unknown
  categoryL4?: unknown
  categoryL5?: unknown
  relativeDemand?: unknown
  previousRelativeDemand?: unknown
  relativeDemandChange?: unknown
  inventoryStatus?: unknown
  brandInventoryStatus?: unknown
  variantGtins?: unknown
}

type BrandView = Omit<ClusterView, 'title' | 'categoryL1' | 'categoryL2' | 'categoryL3' | 'categoryL4' | 'categoryL5' | 'inventoryStatus' | 'brandInventoryStatus' | 'variantGtins'>

export type BestSellersClusterResult = { bestSellersProductClusterView?: ClusterView }
export type BestSellersBrandResult = { bestSellersBrandView?: BrandView }

/** An int64 Google sent as a string. */
function asRank(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null
  const parsed = Number(value.trim())
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** Google's category id, kept as text: an identifier we compare and print,
 *  never count with. */
function categoryId(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
  return /^\d+$/.test(raw) ? raw : null
}

/** "Furniture > Office Furniture > Office Chairs" from Google's five levels.
 *  Null where Google sent none of them. */
function categoryPath(view: ClusterView): string | null {
  const parts = [view.categoryL1, view.categoryL2, view.categoryL3, view.categoryL4, view.categoryL5]
    .map(text)
    .filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join(' > ') : null
}

/** Google's example GTINs, deduplicated and cleaned. Anything that is not a
 *  run of digits is not a barcode and is dropped rather than stored as one. */
function gtins(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const digits = entry.trim()
    if (/^\d{8,14}$/.test(digits)) out.add(digits)
  }
  return [...out]
}

/**
 * One product cluster row, or null when it is not one we can file.
 *
 * The date, granularity, country, category and rank are the key. A row missing
 * any of them has nowhere to go and is dropped rather than stored under a
 * made-up one.
 */
export function parseClusterRow(result: BestSellersClusterResult): BestSellerRow | null {
  const view = result.bestSellersProductClusterView
  if (!view) return null
  const reportDate = dayFromGoogle(view.reportDate)
  const country = text(view.reportCountryCode)
  const category = categoryId(view.reportCategoryId)
  const rank = asRank(view.rank)
  if (!reportDate || !country || !category || rank === null) return null

  return {
    kind: 'cluster',
    reportDate,
    granularity: asGranularity(view.reportGranularity),
    countryCode: country.toUpperCase(),
    categoryId: category,
    rank,
    previousRank: asRank(view.previousRank),
    title: text(view.title),
    brand: text(view.brand),
    categoryPath: categoryPath(view),
    relativeDemand: asRelativeDemand(view.relativeDemand),
    previousRelativeDemand: asRelativeDemand(view.previousRelativeDemand),
    demandChange: asDemandChange(view.relativeDemandChange),
    inventoryStatus: asInventoryStatus(view.inventoryStatus),
    brandInventoryStatus: asInventoryStatus(view.brandInventoryStatus),
    variantGtins: gtins(view.variantGtins),
  }
}

/** One brand row. Everything a cluster carries that a brand does not is null
 *  or 'unknown' rather than absent, so both kinds share one table and one
 *  reader. */
export function parseBrandRow(result: BestSellersBrandResult): BestSellerRow | null {
  const view = result.bestSellersBrandView
  if (!view) return null
  const reportDate = dayFromGoogle(view.reportDate)
  const country = text(view.reportCountryCode)
  const category = categoryId(view.reportCategoryId)
  const rank = asRank(view.rank)
  if (!reportDate || !country || !category || rank === null) return null

  return {
    kind: 'brand',
    reportDate,
    granularity: asGranularity(view.reportGranularity),
    countryCode: country.toUpperCase(),
    categoryId: category,
    rank,
    previousRank: asRank(view.previousRank),
    title: null,
    brand: text(view.brand),
    categoryPath: null,
    relativeDemand: asRelativeDemand(view.relativeDemand),
    previousRelativeDemand: asRelativeDemand(view.previousRelativeDemand),
    demandChange: asDemandChange(view.relativeDemandChange),
    // The brand report carries no inventory status of its own. 'unknown' is
    // the honest answer, and the screen shows it as "not known" rather than
    // as a brand this shop does not stock.
    inventoryStatus: 'unknown',
    brandInventoryStatus: 'unknown',
    variantGtins: [],
  }
}
