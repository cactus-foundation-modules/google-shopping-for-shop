// One way in to Google's Merchant API for the whole module.
//
// Before this existed, the only thing that talked to Google was the match
// refresh, and it signed its own assertion, minted a fresh token per call and
// gave up the moment Google said "slow down". Reports, shipping, item issues
// and performance figures all want the same three things - a token, a request
// that survives a rate limit, and an error a site owner can read - so they live
// here once.
//
// Shape of it:
//   getAccessToken()   signs a JWT assertion with the service-account key and
//                      swaps it for a bearer token, cached until it expires.
//   merchantRequest()  one Merchant API call, retried on 429 and 5xx.
//   searchReport()     a Reports query, followed through every page.
//
// The private key is used here and nowhere else. No token, assertion or header
// is ever logged or put into an error message.
import { createSign } from 'crypto'
import {
  CONTENT_SCOPE,
  googleCredentialsFromEnv,
  type GoogleCredentials,
} from '@/modules/google-shopping-for-shop/lib/google/credentials'
import {
  GoogleApiError,
  GoogleAuthError,
  GoogleCredentialsError,
  GoogleNetworkError,
} from '@/modules/google-shopping-for-shop/lib/google/errors'

/** Every Merchant API sub-API hangs off here: reports/v1, accounts/v1, products/v1. */
export const MERCHANT_API_BASE = 'https://merchantapi.googleapis.com'

/** How long before a token's stated expiry we stop using it. A request that
 *  leaves here with seconds left on the clock arrives at Google expired. */
const TOKEN_SKEW_MS = 60_000

/** Attempts in total, first try included. Four attempts with the backoff below
 *  spans about seven seconds, which is inside every route's own budget. */
const DEFAULT_ATTEMPTS = 4

/** First backoff. Doubles each time, plus a little jitter so a burst of items
 *  does not all come back at the same instant. */
const DEFAULT_RETRY_BASE_MS = 500

/** The most we will wait because Google asked us to. Merchant Center has been
 *  known to answer Retry-After with a number of minutes; a module route has
 *  sixty seconds in total, so anything long is a failure, not a wait. */
const MAX_RETRY_AFTER_MS = 10_000

export type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Sent as JSON. Leave out for a GET. */
  body?: unknown
  /** Total attempts including the first. 1 turns retrying off. */
  attempts?: number
  /** First backoff in milliseconds; doubles per attempt. 0 in tests. */
  retryBaseMs?: number
  /** Extra headers, e.g. an If-Match etag on a shipping settings write. */
  headers?: Record<string, string>
  /** Credentials to use. Defaults to whatever the environment holds. */
  credentials?: GoogleCredentials
  signal?: AbortSignal
}

type TokenCacheEntry = { token: string; expiresAt: number }

// Keyed by service account and scope: swapping the key on the settings tab
// gives a different email, so a stale token cannot be handed to a new key.
const tokenCache = new Map<string, TokenCacheEntry>()

// Mints in flight, by the same key. Two report queries fired off together on a
// cold cache would otherwise sign and swap two assertions for two tokens, one
// of which is immediately thrown away.
const pendingTokens = new Map<string, Promise<string>>()

/** Test seam, and what to call after the key is replaced. */
export function clearGoogleTokenCache(): void {
  tokenCache.clear()
  pendingTokens.clear()
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

/** The credentials, or a typed refusal - never a null for the caller to forget. */
export function requireGoogleCredentials(explicit?: GoogleCredentials): GoogleCredentials {
  const credentials = explicit ?? googleCredentialsFromEnv()
  if (!credentials) throw new GoogleCredentialsError('Merchant API credentials are not configured')
  return credentials
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

/** How long to wait before attempt number `attempt` (1-based, so the first
 *  retry is attempt 2). Honours Retry-After when Google sends a sane one. */
function backoffMs(attempt: number, base: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
  }
  if (base <= 0) return 0
  const straight = base * 2 ** (attempt - 2)
  return straight + Math.random() * base
}

type GoogleErrorBody = {
  error?: { message?: string; status?: string; errors?: Array<{ reason?: string }> }
  error_description?: string
}

/** Google's own sentence about what went wrong, or our fallback. Google is
 *  usually clearer about its own refusals than we could be. */
function errorMessage(body: GoogleErrorBody | null, fallback: string): string {
  return body?.error?.message?.trim() || body?.error_description?.trim() || fallback
}

function errorReason(body: GoogleErrorBody | null): string | null {
  return body?.error?.status?.trim() || body?.error?.errors?.[0]?.reason?.trim() || null
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/**
 * A bearer token for the service account, minted from a signed assertion and
 * kept until it is nearly expired.
 *
 * Google's tokens last an hour. Minting one per call cost a round trip and a
 * signature every time, and on a catalogue-wide job that is thousands of both.
 */
export async function getAccessToken(options: { credentials?: GoogleCredentials; scope?: string; attempts?: number; retryBaseMs?: number } = {}): Promise<string> {
  const credentials = requireGoogleCredentials(options.credentials)
  const scope = options.scope ?? CONTENT_SCOPE
  const key = `${credentials.clientEmail}\u0000${scope}\u0000${credentials.tokenUri}`

  const cached = tokenCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.token

  const inFlight = pendingTokens.get(key)
  if (inFlight) return inFlight

  const mint = mintAccessToken(key, credentials, scope, options)
  pendingTokens.set(key, mint)
  try {
    return await mint
  } finally {
    pendingTokens.delete(key)
  }
}

async function mintAccessToken(
  key: string,
  credentials: GoogleCredentials,
  scope: string,
  options: { attempts?: number; retryBaseMs?: number },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64Url(JSON.stringify({
    iss: credentials.clientEmail,
    scope,
    aud: credentials.tokenUri,
    exp: now + 3600,
    iat: now,
  }))}`
  let signature: Buffer
  try {
    signature = createSign('RSA-SHA256').update(unsigned).sign(credentials.privateKey)
  } catch {
    // The message from node's signer quotes the key material back at you, so it
    // is deliberately not passed on.
    throw new GoogleCredentialsError('That service-account key could not be used to sign a request. Paste the JSON key file again.')
  }
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${unsigned}.${base64Url(signature)}`,
  })

  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS)
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS
  let lastError: Error = new GoogleAuthError()
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleep(backoffMs(attempt, retryBaseMs, null))
    let response: Response
    try {
      response = await fetch(credentials.tokenUri, { method: 'POST', body })
    } catch (error) {
      lastError = new GoogleNetworkError(error instanceof Error ? error.message : 'Could not reach Google to sign in')
      continue
    }
    const json = await readJson(response) as (GoogleErrorBody & { access_token?: string; expires_in?: number }) | null
    if (response.ok && json?.access_token) {
      const lifetimeMs = (typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 3600) * 1000
      tokenCache.set(key, { token: json.access_token, expiresAt: Date.now() + Math.max(0, lifetimeMs - TOKEN_SKEW_MS) })
      return json.access_token
    }
    const message = errorMessage(json, 'Merchant API authentication failed')
    // A bad key is a bad key however many times it is offered; only Google
    // being busy is worth another go.
    if (response.status !== 429 && response.status < 500) throw new GoogleAuthError(message)
    lastError = new GoogleAuthError(message)
  }
  throw lastError
}

/**
 * One Merchant API call.
 *
 * `path` is everything after the host, e.g. `reports/v1/accounts/123/reports:search`.
 * Retries a rate limit or a wobble at Google's end; never retries a refusal.
 */
export async function merchantRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const credentials = requireGoogleCredentials(options.credentials)
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS)
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS
  const url = `${MERCHANT_API_BASE}/${path.replace(/^\//, '')}`

  let lastError: Error = new GoogleNetworkError()
  let attempt = 1
  // Set when the coming attempt is a retry of something that failed, which is
  // the only time we wait first. A token refresh is not that: nothing was busy,
  // the token was simply spent.
  let waitFirst = false
  // A 401 is usually a stale token rather than a bad key, so the cache is
  // emptied and the call goes round again on a fresh one without using up an
  // attempt. Once only - a revoked key answers 401 for ever, and this must not
  // become a loop.
  let refreshed = false

  while (attempt <= attempts) {
    if (waitFirst) {
      const retryAfter = lastError instanceof GoogleApiError ? lastError.retryAfter : null
      await sleep(backoffMs(attempt, retryBaseMs, retryAfter))
    }
    waitFirst = false

    // Inside the loop: the token can expire between one attempt and the next.
    const token = await getAccessToken({ credentials, attempts, retryBaseMs })
    let response: Response
    try {
      response = await fetch(url, {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      lastError = new GoogleNetworkError(error instanceof Error ? error.message : 'Could not reach Google')
      attempt++
      waitFirst = true
      continue
    }

    const json = await readJson(response)
    if (response.ok) return json as T

    const failure = new GoogleApiError(
      errorMessage(json as GoogleErrorBody | null, `Google refused that request (${response.status})`),
      response.status,
      errorReason(json as GoogleErrorBody | null),
      response.headers.get('retry-after'),
    )
    if (response.status === 401 && !refreshed) {
      refreshed = true
      clearGoogleTokenCache()
      lastError = failure
      continue
    }
    if (!failure.retryable) throw failure
    lastError = failure
    attempt++
    waitFirst = true
  }
  throw lastError
}

type ReportResponse<T> = { results?: T[]; nextPageToken?: string }

/** Every page of a Merchant API Reports query, gathered up.
 *
 *  Google caps a page at 1,000 rows whatever is asked for, and a catalogue of
 *  any size is several pages. The page token is opaque and must be sent back
 *  exactly as given. */
export async function searchReport<T>(
  merchantId: string,
  query: string,
  options: Omit<RequestOptions, 'body' | 'method'> & { pageSize?: number } = {},
): Promise<T[]> {
  const rows: T[] = []
  await searchReportPages<T>(merchantId, query, async (page) => {
    rows.push(...page)
  }, options)
  return rows
}

/** Every page of a Reports query, handed over one page at a time.
 *
 *  Same call as searchReport, without gathering the answer up first. A report
 *  that is one row per product per day per marketing method over a quarter is
 *  hundreds of thousands of rows, and an array of all of them is how a
 *  serverless function runs out of memory before it has written anything down.
 *
 *  `onPage` is awaited before the next page is asked for, so a caller that
 *  writes each page to the database cannot get ahead of itself.
 *
 *  Stop early by returning `'stop'` - for a caller working to a time budget. */
export async function searchReportPages<T>(
  merchantId: string,
  query: string,
  onPage: (rows: T[]) => Promise<void | 'stop'>,
  options: Omit<RequestOptions, 'body' | 'method'> & { pageSize?: number } = {},
): Promise<void> {
  let pageToken: string | undefined
  do {
    const page = await merchantRequest<ReportResponse<T>>(`reports/v1/accounts/${merchantId}/reports:search`, {
      ...options,
      method: 'POST',
      body: { query, pageSize: options.pageSize ?? 1000, pageToken },
    })
    if (await onPage(page.results ?? []) === 'stop') return
    pageToken = page.nextPageToken
  } while (pageToken)
}
