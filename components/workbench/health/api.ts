// The Health tab's calls to its admin routes. Failures come back as a thrown
// Error carrying the route's own plain-English message, the same as every
// other part of the workbench.
import { API_BASE } from '@/modules/google-shopping-for-shop/components/workbench/api'
import type { HealthReport } from '@/modules/google-shopping-for-shop/lib/health/report'
import type { DataSourceOrigin } from '@/modules/google-shopping-for-shop/lib/health/feed-fetch'
import type { FeedFetchStatus, FetchUnavailableReason, IssueSeverity } from '@/modules/google-shopping-for-shop/lib/health/types'
import type { ExplainOutcome } from '@/modules/google-shopping-for-shop/lib/health/explain'

export type { HealthReport }

/** What the refresh button gets back. `unavailable` is a normal answer, not a
 *  failure: "we could not find out" has to read differently from "all is well". */
export type FeedCheckResult =
  | { status: 'ok'; origin: DataSourceOrigin; fetch: FeedFetchStatus; alerted: boolean }
  | { status: 'unavailable'; reason: FetchUnavailableReason; message: string; detail: string | null; alerted: boolean }

export type RefreshIssuesResult = {
  checkedAt: string
  products: number
  matched: number
  /** Null when Google answered with no rows - see issuesSkipped. */
  issues: number | null
  disapprovedItems: number | null
  /** Google returned nothing at all, so the ledger was left exactly as it
   *  was. Not an all clear, and the tab says so. */
  issuesSkipped: boolean
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : fallback
    throw new Error(message)
  }
  if (body === null) throw new Error(fallback)
  return body as T
}

export type HealthQueryParams = {
  page: number
  perPage: number
  code: string
  severity: IssueSeverity | ''
}

export async function fetchHealth(query: HealthQueryParams, signal?: AbortSignal): Promise<HealthReport> {
  const params = new URLSearchParams({ page: String(query.page), perPage: String(query.perPage) })
  if (query.code) params.set('code', query.code)
  if (query.severity) params.set('severity', query.severity)
  const body = await readJson<{ report: HealthReport }>(
    await fetch(`${API_BASE}/health?${params}`, { cache: 'no-store', ...(signal ? { signal } : {}) }),
    'Could not load the health figures',
  )
  return body.report
}

/** Asks Google how its last fetch of the feed went. */
export async function checkFeedFetch(): Promise<FeedCheckResult> {
  return readJson<FeedCheckResult>(
    await fetch(`${API_BASE}/health/refresh`, { method: 'POST' }),
    'Could not check the feed with Google',
  )
}

/** Re-reads Google's report on every item, which is what brings fresh issues.
 *  The same call the Products tab's Refresh makes: one report answers both. */
export async function refreshItemIssues(): Promise<RefreshIssuesResult> {
  return readJson<RefreshIssuesResult>(
    await fetch(`${API_BASE}/items/refresh`, { method: 'POST' }),
    'Could not refresh what Google says about your items',
  )
}

export type { ExplainOutcome }

/**
 * Google's own words about ONE item, fetched when the owner presses the
 * button. One Merchant API call per press; the server caches the answer onto
 * the rows it explains, so pressing again is free until the daily check sees
 * the issue afresh.
 *
 * `force` is what the "ask Google again" link sends.
 */
export async function explainItem(itemId: string, force = false): Promise<ExplainOutcome> {
  const response = await fetch(`${API_BASE}/health/explain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId, force }),
  })
  return readJson<ExplainOutcome>(response, 'Could not ask Google about that item')
}
