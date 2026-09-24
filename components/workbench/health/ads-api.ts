// The Google Ads panel's calls to its own admin routes. Failures come back as a
// thrown Error carrying the route's own plain-English message, the same as
// every other part of the workbench.
import { API_BASE } from '@/modules/google-shopping-for-shop/components/workbench/api'
import type { AdsView } from '@/modules/google-shopping-for-shop/lib/google-ads/view'
import type { AdsAccessReport } from '@/modules/google-shopping-for-shop/lib/google-ads/access-check'
import type { ConversionActionOutcome } from '@/modules/google-shopping-for-shop/lib/google-ads/conversion-action'
import type { UploadOutcome } from '@/modules/google-shopping-for-shop/lib/google-ads/upload'
import type { SpendImportOutcome } from '@/modules/google-shopping-for-shop/lib/google-ads/spend-import'

export type { AdsView, AdsAccessReport, ConversionActionOutcome, UploadOutcome, SpendImportOutcome }

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : fallback
    throw new Error(message)
  }
  if (body === null) throw new Error(fallback)
  return body as T
}

/** The panel, from our own tables and the environment. No call to Google. */
export async function fetchAds(signal?: AbortSignal): Promise<AdsView> {
  const body = await readJson<{ ads: AdsView }>(
    await fetch(`${API_BASE}/ads`, { cache: 'no-store', ...(signal ? { signal } : {}) }),
    'Could not read the Google Ads figures',
  )
  return body.ads
}

export async function setAds(patch: {
  enabled?: boolean
  spendImportEnabled?: boolean
  uploadEnabled?: boolean
  backfillDays?: number
  retentionDays?: number
}): Promise<AdsView> {
  const body = await readJson<{ ads: AdsView }>(
    await fetch(`${API_BASE}/ads`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
    'Could not change that',
  )
  return body.ads
}

/** Asks Google what this connection can do. Changes nothing. */
export async function checkAdsConnection(): Promise<AdsAccessReport> {
  const body = await readJson<{ access: AdsAccessReport }>(
    await fetch(`${API_BASE}/ads/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job: 'check' }),
    }),
    'Could not check your Google Ads connection',
  )
  return body.access
}

/** Finds or makes the sales tracker, and makes sure Google has it as secondary.
 *  This one writes to the account. */
export async function connectAdsTracker(): Promise<{ outcome: ConversionActionOutcome; ads: AdsView }> {
  return readJson<{ outcome: ConversionActionOutcome; ads: AdsView }>(
    await fetch(`${API_BASE}/ads/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job: 'connect' }),
    }),
    'Could not set up the Google Ads sales tracker',
  )
}

/** Sends whatever sales are waiting, now. */
export async function runAdsUpload(): Promise<{ outcome: UploadOutcome; ads: AdsView }> {
  return readJson<{ outcome: UploadOutcome; ads: AdsView }>(
    await fetch(`${API_BASE}/ads/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job: 'upload' }),
    }),
    'Could not send your sales to Google Ads',
  )
}

/** Fetches what the ads cost, now. */
export async function runAdsSpendFetch(): Promise<{ outcome: SpendImportOutcome; ads: AdsView }> {
  return readJson<{ outcome: SpendImportOutcome; ads: AdsView }>(
    await fetch(`${API_BASE}/ads/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job: 'spend' }),
    }),
    'Could not fetch what your ads cost',
  )
}
