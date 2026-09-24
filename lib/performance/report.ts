// Everything the Reports tab shows, gathered in one read.
//
// Deliberately cheap, like the Health tab's: sums and one page of items out of
// our own tables. NOTHING HERE CALLS GOOGLE. Asking Google again is the refresh
// button, because a Merchant API round trip on every open would make this the
// slowest screen in the admin and would spend the account's quota on people
// glancing at it.
//
// The honesty rules, all three of which this screen could break easily:
//
//   - These are GOOGLE'S figures, not the shop's, and they run about a day
//     behind. Every headline carries that caption.
//   - A day with no rows imported is not a day with no clicks. The trend fills
//     gaps as "nothing imported" rather than as zero.
//   - A conversion figure Google does not report is null, not nought. Paid
//     rows never carry one, which is Google's rule and not a fault here.
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { hasGoogleCredentials } from '@/modules/google-shopping-for-shop/lib/google/credentials'
import { merchantCentreItemUrl } from '@/modules/google-shopping-for-shop/lib/merchant-centre-url'
import { daysInRange, todayUtc } from '@/modules/google-shopping-for-shop/lib/performance/days'
import { resolveRange, type ResolvedRange } from '@/modules/google-shopping-for-shop/lib/performance/range'
import { planImport } from '@/modules/google-shopping-for-shop/lib/performance/plan'
import {
  readPerformanceExtent,
  readProductPerformance,
  readTotalsByMethod,
  readTrend,
  type ProductPerformanceRow,
} from '@/modules/google-shopping-for-shop/lib/performance/store'
import { rateOf, type MarketingMethod, type PerformanceTotals, type ProductSort } from '@/modules/google-shopping-for-shop/lib/performance/types'
import { readBestSellers, type BestSellerRowView } from '@/modules/google-shopping-for-shop/lib/best-sellers/store'
import { resolveBestSellerCategories } from '@/modules/google-shopping-for-shop/lib/best-sellers/import'
import type { BestSellerGranularity } from '@/modules/google-shopping-for-shop/lib/best-sellers/types'

export const REPORT_PAGE_SIZES = [25, 50, 100] as const

/** A ceiling on how deep a category is shown, whatever the owner set. The cap
 *  is applied PER CATEGORY in SQL (see readBestSellers), so this trims the
 *  bottom of each list rather than dropping whole categories; anything left
 *  out is counted and said on screen. */
const BEST_SELLER_ROWS_PER_CATEGORY = 100

/** One point on the trend chart.
 *
 *  `imported` false means no row exists for that day at all. Drawn as a gap,
 *  never as a zero: a day nothing was fetched for and a day nobody clicked
 *  draw identically otherwise, and only one of them is a fact. */
export type TrendDay = {
  day: string
  imported: boolean
  organicClicks: number
  organicImpressions: number
  adsClicks: number
  adsImpressions: number
}

export type ProductRow = ProductPerformanceRow & {
  /** Merchant Center's own page for this item, or null where the account
   *  number has not been filled in and there is no address to build. */
  merchantCentreUrl: string | null
}

export type PerformanceReport = {
  /** The dates actually being shown. */
  range: ResolvedRange
  /** Today as this server sees it, so the browser can label "yesterday"
   *  without disagreeing with the server about what day it is. */
  today: string
  totals: {
    organic: PerformanceTotals
    ads: PerformanceTotals
    /** Both together, plus anything Google filed under a method we do not
     *  recognise - which is counted here and nowhere else. */
    all: PerformanceTotals
  }
  trend: TrendDay[]
  products: { rows: ProductRow[]; total: number; page: number; pageCount: number; perPage: number; sort: ProductSort }
  bestSellers: {
    clusters: BestSellerRowView[]
    brands: BestSellerRowView[]
    /** The newest ranking date held, or null where none is. */
    reportDate: string | null
    granularity: BestSellerGranularity
    /** Rankings held but not shown, because the per-category cap trimmed
     *  them. Said on screen rather than left as a short list. */
    truncated: number
    /** How deep each category is shown. */
    perCategory: number
    /** True when the depth above is this module's own ceiling rather than the
     *  owner's larger setting, so the screen can say whose number it is. */
    perCategoryCapped: boolean
    /** Rankings held that this view is NOT showing - a different granularity,
     *  a different country, or a category no longer configured. Non-zero with
     *  no rows at all means the owner has just changed a setting, which reads
     *  nothing like "Google has no rankings for you" and must not be shown as
     *  though it did. */
    heldElsewhere: number
    enabled: boolean
    checkedAt: string | null
  }
  /** What the import has and has not managed. */
  state: {
    /** Null means nobody has ever asked Google for these figures. NOT the
     *  same as "nothing happened", and the tab says so. */
    checkedAt: string | null
    /** The oldest and newest day held, for "we have figures from X to Y". */
    heldFrom: string | null
    heldTo: string | null
    rowsHeld: number
    /** The cursor: everything up to here is imported and settled. */
    importedThrough: string | null
    /** False once Google has refused a query carrying conversion metrics, so
     *  the empty column can be explained rather than wondered at. Null means
     *  it has never been tried. */
    conversionsAvailable: boolean | null
    /** True while the backfill still has history to fetch. */
    backfilling: boolean
    /** When an import last FAILED, and what was said. Cleared by the next run
     *  that succeeds, so a value here means the most recent attempt died -
     *  which the tab says instead of "last fetched", because a screen must
     *  never report a fetch that did not happen. */
    failedAt: string | null
    lastError: string | null
    /** When the conversions answer above was last learned, so the screen can
     *  date a refusal instead of stating it as a standing fact about the
     *  account. Null means nobody has ever got an answer either way. */
    conversionsCheckedAt: string | null
  }
  /** Whether a refresh could even be attempted, and what is missing if not. */
  can: { refresh: boolean; credentials: boolean; merchantId: boolean }
  settings: {
    importEnabled: boolean
    backfillDays: number
    retentionDays: number
    bestSellersEnabled: boolean
    bestSellersCategoryIds: string
    bestSellersGranularity: BestSellerGranularity
    bestSellersLimit: number
  }
}

/** The shape readBestSellers answers with, for the branch that does not call
 *  it. Named rather than inlined so both arms of the ternary agree on a type
 *  rather than one of them being `never[]`. */
const NO_SELLERS: { rows: BestSellerRowView[]; reportDate: string | null; truncated: number; heldElsewhere: number } = {
  rows: [], reportDate: null, truncated: 0, heldElsewhere: 0,
}

export type ReportQuery = {
  range: string
  from?: string
  to?: string
  page: number
  perPage: number
  sort: ProductSort
  search: string
}

function sumTotals(parts: readonly PerformanceTotals[]): PerformanceTotals {
  const clicks = parts.reduce((total, part) => total + part.clicks, 0)
  const impressions = parts.reduce((total, part) => total + part.impressions, 0)
  const reporting = parts.filter((part) => part.conversions !== null)
  return {
    clicks,
    impressions,
    clickThroughRate: rateOf(clicks, impressions),
    conversions: reporting.length > 0 ? reporting.reduce((total, part) => total + (part.conversions ?? 0), 0) : null,
    conversionValue: reporting.length > 0 ? reporting.reduce((total, part) => total + (part.conversionValue ?? 0), 0) : null,
    conversionCurrency: reporting.find((part) => part.conversionCurrency !== null)?.conversionCurrency ?? null,
  }
}

export async function readPerformanceReport(query: ReportQuery, now: Date = new Date()): Promise<PerformanceReport> {
  const settings = await getGsfSettings()
  const today = todayUtc(now)
  const extent = await readPerformanceExtent()

  const range = resolveRange({
    today,
    range: query.range,
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
    ...(extent.from ? { earliest: extent.from } : {}),
  })

  const perPage = Math.min(Math.max(1, Math.trunc(query.perPage)), 200)
  const page = Math.max(1, Math.trunc(query.page))

  // Only what is configured NOW: switching weekly to monthly leaves last
  // week's rows in the table, and showing them beside the monthly ones would
  // read as one ranking made of two. The same goes for a category the owner
  // has dropped - it is filtered out of the view, not deleted, so putting it
  // back shows its last ranking straight away rather than after a fetch.
  //
  // The category list is resolved exactly the way the import resolves it, so
  // the screen can only ever show categories the next fetch would ask about.
  const sellersQuery = {
    granularity: settings.bestSellersGranularity,
    countryCode: settings.shippingCountry,
    perCategory: Math.min(settings.bestSellersLimit, BEST_SELLER_ROWS_PER_CATEGORY),
    categoryIds: settings.bestSellersEnabled ? await resolveBestSellerCategories(settings.bestSellersCategoryIds) : [],
  }

  const [byMethod, trendRows, products, clusters, brands] = await Promise.all([
    readTotalsByMethod(range.from, range.to),
    readTrend(range.from, range.to),
    readProductPerformance({
      from: range.from,
      to: range.to,
      limit: perPage,
      offset: (page - 1) * perPage,
      sort: query.sort,
      search: query.search,
    }),
    settings.bestSellersEnabled ? readBestSellers('cluster', sellersQuery) : Promise.resolve(NO_SELLERS),
    settings.bestSellersEnabled ? readBestSellers('brand', sellersQuery) : Promise.resolve(NO_SELLERS),
  ])

  // Filled out to one point per day so the chart has an even x axis, with
  // days nothing was imported for marked as such rather than drawn as zero.
  const byDay = new Map(trendRows.map((point) => [point.day, point]))
  const trend: TrendDay[] = daysInRange(range.from, range.to).map((day) => {
    const point = byDay.get(day)
    return {
      day,
      imported: point !== undefined,
      organicClicks: point?.organic.clicks ?? 0,
      organicImpressions: point?.organic.impressions ?? 0,
      adsClicks: point?.ads.clicks ?? 0,
      adsImpressions: point?.ads.impressions ?? 0,
    }
  })

  const methods: MarketingMethod[] = ['organic', 'ads', 'unknown']
  return {
    range,
    today,
    totals: {
      organic: byMethod.organic,
      ads: byMethod.ads,
      all: sumTotals(methods.map((method) => byMethod[method])),
    },
    trend,
    products: {
      rows: products.rows.map((row) => ({
        ...row,
        merchantCentreUrl: settings.merchantId
          ? merchantCentreItemUrl({ merchantId: settings.merchantId, offerId: row.itemId, feedLabel: settings.feedLabel })
          : null,
      })),
      total: products.total,
      page,
      pageCount: Math.max(1, Math.ceil(products.total / perPage)),
      perPage,
      sort: query.sort,
    },
    bestSellers: {
      clusters: clusters.rows,
      brands: brands.rows,
      reportDate: clusters.reportDate ?? brands.reportDate,
      granularity: settings.bestSellersGranularity,
      truncated: clusters.truncated + brands.truncated,
      perCategory: sellersQuery.perCategory,
      perCategoryCapped: settings.bestSellersLimit > BEST_SELLER_ROWS_PER_CATEGORY,
      heldElsewhere: clusters.heldElsewhere + brands.heldElsewhere,
      enabled: settings.bestSellersEnabled,
      checkedAt: settings.bestSellersCheckedAt?.toISOString() ?? null,
    },
    state: {
      checkedAt: settings.performanceCheckedAt?.toISOString() ?? null,
      heldFrom: extent.from,
      heldTo: extent.to,
      rowsHeld: extent.rows,
      importedThrough: settings.performanceImportedThrough,
      conversionsAvailable: settings.performanceConversionsAvailable,
      conversionsCheckedAt: settings.performanceConversionsCheckedAt?.toISOString() ?? null,
      failedAt: settings.performanceFailedAt?.toISOString() ?? null,
      lastError: settings.performanceLastError,
      // Worked out by the same planner the import itself uses, so the screen
      // and the job can never disagree about whether there is history left to
      // fetch.
      backfilling: settings.performanceImportEnabled && planImport({
        today,
        importedThrough: settings.performanceImportedThrough,
        backfillDays: settings.performanceBackfillDays,
      }).backfilling,
    },
    can: {
      refresh: hasGoogleCredentials() && settings.merchantId !== null,
      credentials: hasGoogleCredentials(),
      merchantId: settings.merchantId !== null,
    },
    settings: {
      importEnabled: settings.performanceImportEnabled,
      backfillDays: settings.performanceBackfillDays,
      retentionDays: settings.performanceRetentionDays,
      bestSellersEnabled: settings.bestSellersEnabled,
      bestSellersCategoryIds: settings.bestSellersCategoryIds ?? '',
      bestSellersGranularity: settings.bestSellersGranularity,
      bestSellersLimit: settings.bestSellersLimit,
    },
  }
}
