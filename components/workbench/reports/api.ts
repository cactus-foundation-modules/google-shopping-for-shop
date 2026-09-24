// The Reports tab's calls to its admin routes. Failures come back as a thrown
// Error carrying the route's own plain-English message, the same as every
// other part of the workbench.
import { API_BASE } from '@/modules/google-shopping-for-shop/components/workbench/api'
import type { PerformanceReport } from '@/modules/google-shopping-for-shop/lib/performance/report'
import type { ProductSort, ReportRange } from '@/modules/google-shopping-for-shop/lib/performance/types'
import type { BestSellerGranularity } from '@/modules/google-shopping-for-shop/lib/best-sellers/types'
import type { RefreshReportsResult } from '@/modules/google-shopping-for-shop/lib/performance/refresh-types'
import type { AttributedOrderView, LiveReport } from '@/modules/google-shopping-for-shop/lib/click-tracking/report'
import type { AdsReport } from '@/modules/google-shopping-for-shop/lib/google-ads/report'

export type { PerformanceReport, RefreshReportsResult }

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : fallback
    throw new Error(message)
  }
  if (body === null) throw new Error(fallback)
  return body as T
}

export type ReportQueryParams = {
  range: ReportRange
  from: string
  to: string
  page: number
  perPage: number
  sort: ProductSort
  search: string
}

export const DEFAULT_REPORT_QUERY: ReportQueryParams = {
  range: '30',
  from: '',
  to: '',
  page: 1,
  perPage: 25,
  sort: 'clicks',
  search: '',
}

export async function fetchReport(query: ReportQueryParams, signal?: AbortSignal): Promise<PerformanceReport> {
  const params = new URLSearchParams({
    range: query.range,
    page: String(query.page),
    perPage: String(query.perPage),
    sort: query.sort,
  })
  // Only sent on a custom range: a stale pair of dates left in the address bar
  // must not quietly narrow "last 30 days".
  if (query.range === 'custom') {
    if (query.from) params.set('from', query.from)
    if (query.to) params.set('to', query.to)
  }
  if (query.search) params.set('search', query.search)
  const body = await readJson<{ report: PerformanceReport }>(
    await fetch(`${API_BASE}/reports?${params}`, { cache: 'no-store', ...(signal ? { signal } : {}) }),
    'Could not load the Google figures',
  )
  return body.report
}

/** Asks Google for its figures now. On a first run over a quarter of history
 *  this will not finish in one press, and the answer says so. */
export async function refreshReports(): Promise<RefreshReportsResult> {
  return readJson<RefreshReportsResult>(
    await fetch(`${API_BASE}/reports/refresh`, { method: 'POST' }),
    'Could not fetch the Google figures',
  )
}

export type ReportSettingsPatch = {
  importEnabled?: boolean
  backfillDays?: number
  retentionDays?: number
  bestSellersEnabled?: boolean
  bestSellersCategoryIds?: string
  bestSellersGranularity?: BestSellerGranularity
  bestSellersLimit?: number
}

export async function saveReportSettings(patch: ReportSettingsPatch): Promise<PerformanceReport> {
  const body = await readJson<{ report: PerformanceReport }>(
    await fetch(`${API_BASE}/reports`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
    'Could not save those settings',
  )
  return body.report
}

// ---------------------------------------------------------------------------
// This site's own live figures
// ---------------------------------------------------------------------------

export type { AttributedOrderView, LiveReport }

export async function fetchLiveReport(
  query: Pick<ReportQueryParams, 'range' | 'from' | 'to'>,
  signal?: AbortSignal,
): Promise<LiveReport> {
  const params = new URLSearchParams({ range: query.range })
  // Only sent on a custom range, for the same reason the Google report does it:
  // a stale pair of dates left in the address bar must not quietly narrow
  // "last 30 days".
  if (query.range === 'custom') {
    if (query.from) params.set('from', query.from)
    if (query.to) params.set('to', query.to)
  }
  const body = await readJson<{ report: LiveReport }>(
    await fetch(`${API_BASE}/tracking?${params}`, { cache: 'no-store', ...(signal ? { signal } : {}) }),
    "Could not load this site's own figures",
  )
  return body.report
}

// ---------------------------------------------------------------------------
// Google Ads: what the paid half cost
// ---------------------------------------------------------------------------

export type { AdsReport }

export async function fetchAdsReport(
  query: Pick<ReportQueryParams, 'range' | 'from' | 'to'>,
  signal?: AbortSignal,
): Promise<AdsReport> {
  const params = new URLSearchParams({ range: query.range })
  // Only on a custom range, for the same reason the two above do it.
  if (query.range === 'custom') {
    if (query.from) params.set('from', query.from)
    if (query.to) params.set('to', query.to)
  }
  const body = await readJson<{ report: AdsReport }>(
    await fetch(`${API_BASE}/ads/report?${params}`, { cache: 'no-store', ...(signal ? { signal } : {}) }),
    'Could not load what your ads cost',
  )
  return body.report
}

export type TrackingSettingsPatch = {
  linkTaggingEnabled?: boolean
  trackingEnabled?: boolean
  retentionDays?: number
}

export async function saveTrackingSettings(patch: TrackingSettingsPatch): Promise<LiveReport> {
  const body = await readJson<{ report: LiveReport }>(
    await fetch(`${API_BASE}/tracking`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
    'Could not save those settings',
  )
  return body.report
}

/** One attributed sale. 404 comes back as a thrown Error carrying the route's
 *  own wording, which the panel shows in place of the detail. */
export async function fetchAttributedOrder(orderId: string, signal?: AbortSignal): Promise<AttributedOrderView> {
  const body = await readJson<{ order: AttributedOrderView }>(
    await fetch(`${API_BASE}/tracking/order?orderId=${encodeURIComponent(orderId)}`, {
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    }),
    'Could not load that sale',
  )
  return body.order
}
