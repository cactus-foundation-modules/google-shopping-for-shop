// One way in to the Google Ads API for the whole module.
//
// Built to the same shape as lib/google/client.ts - token cache, one request
// function, retry on 429 and 5xx, a typed error a site owner can read - and
// deliberately NOT bolted onto it, because almost nothing underneath is shared:
//
//   sign-in    an OAuth refresh token swapped for an access token, not a JWT
//              assertion signed with a service-account key.
//   scope      .../auth/adwords, not .../auth/content.
//   host       googleads.googleapis.com, with the API VERSION IN THE PATH.
//   headers    login-customer-id when the account sits under a manager, and
//              the old developer-token when the install still carries one.
//   errors     a second envelope; see errors.ts.
//
// Checked against Google's own published reference for v25 on 2026-09-23:
//   POST /v25/customers/{customerId}/googleAds:search        body {query, pageToken}
//   POST /v25/customers/{customerId}/conversionActions:mutate
//   POST /v25/customers/{customerId}:uploadClickConversions
// The three paths come from the v25 .proto definitions' own google.api.http
// annotations rather than from memory.
//
// No token, secret or header is ever logged or put into an error message.
import { createHash } from 'crypto'
import {
  googleAdsCredentialsFromEnv,
  type GoogleAdsCredentials,
} from '@/modules/google-shopping-for-shop/lib/google-ads/credentials'
import {
  GoogleAdsApiError,
  GoogleAuthError,
  GoogleCredentialsError,
  GoogleNetworkError,
  parseAdsFailure,
  parseAdsRequestId,
} from '@/modules/google-shopping-for-shop/lib/google-ads/errors'
import {
  ADS_API_BASE,
  ADS_API_VERSION,
  OAUTH_TOKEN_URI,
} from '@/modules/google-shopping-for-shop/lib/google-ads/types'

/** How long before a token's stated expiry we stop using it. A request that
 *  leaves here with seconds left on the clock arrives at Google expired. */
const TOKEN_SKEW_MS = 60_000

/** Attempts in total, first try included. */
const DEFAULT_ATTEMPTS = 4

/** First backoff, doubled each time with a little jitter. */
const DEFAULT_RETRY_BASE_MS = 500

/** The most we will wait because Google asked us to. A module route has sixty
 *  seconds in total, so anything long is a failure rather than a wait. */
const MAX_RETRY_AFTER_MS = 10_000

/**
 * The most pages one query may walk before it gives up.
 *
 * A brake on a loop nothing else brakes. Google's pages are a fixed ten
 * thousand rows, so five hundred of them is five million rows - far more than
 * any shop's window of daily figures, and reached only by a `nextPageToken`
 * that never stops coming back. The callers' own wall-clock budgets are checked
 * BETWEEN windows, not between pages, so without this a token that pointed at
 * itself would spin until the route was killed with nothing written and nothing
 * said about why.
 */
const MAX_PAGES = 500

export type AdsRequestOptions = {
  /** Sent as JSON. Every Google Ads call this module makes is a POST. */
  body: unknown
  /** Total attempts including the first. 1 turns retrying off. */
  attempts?: number
  /** First backoff in milliseconds; doubles per attempt. 0 in tests. */
  retryBaseMs?: number
  /** Credentials to use. Defaults to whatever the environment holds. */
  credentials?: GoogleAdsCredentials
  signal?: AbortSignal
}

type TokenCacheEntry = { token: string; expiresAt: number }

// Keyed by a hash of the client and the refresh token.
//
// Not because the Health tab can swap them under a running process - it
// cannot: saving there writes the hosting project's environment and redeploys,
// so a new value arrives with a new build and an empty cache. The key matters
// because one process can legitimately hold more than one set at a time (a test
// passing credentials explicitly beside the environment's own), and a token
// minted for one must never be handed to the other.
//
// A hash rather than the values themselves: a Map key is not a secret store,
// and this one is never printed, but the habit is cheap.
const tokenCache = new Map<string, TokenCacheEntry>()

// Mints in flight, by the same key. Two jobs starting together on a cold cache
// would otherwise each swap the refresh token for an access token, one of which
// is thrown away immediately.
const pendingTokens = new Map<string, Promise<string>>()

/** Test seam, and what to call after the sign-in details are replaced. */
export function clearGoogleAdsTokenCache(): void {
  tokenCache.clear()
  pendingTokens.clear()
}

/** The credentials, or a typed refusal - never a null for the caller to forget. */
export function requireGoogleAdsCredentials(explicit?: GoogleAdsCredentials): GoogleAdsCredentials {
  const credentials = explicit ?? googleAdsCredentialsFromEnv()
  if (!credentials) throw new GoogleCredentialsError('Google Ads is not connected yet')
  return credentials
}

function cacheKey(credentials: GoogleAdsCredentials): string {
  return createHash('sha256')
    .update(`${credentials.clientId}\u0000${credentials.refreshToken}`)
    .digest('hex')
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
  return base * 2 ** (attempt - 2) + Math.random() * base
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

type TokenReply = {
  access_token?: unknown
  expires_in?: unknown
  error?: unknown
  error_description?: unknown
}

function tokenErrorMessage(body: TokenReply | null): string {
  const description = typeof body?.error_description === 'string' ? body.error_description.trim() : ''
  if (description !== '') return description
  const code = typeof body?.error === 'string' ? body.error.trim() : ''
  // Google's own words for the two an owner can actually do something about.
  if (code === 'invalid_grant') {
    return 'Google would not accept the permission token. It has most likely been revoked, or the Google account that granted it '
      + 'has had its password changed. Grant access again and save the new token.'
  }
  if (code === 'invalid_client') {
    return 'Google did not recognise the sign-in ID and secret. Check them against the OAuth client in your Google Cloud console.'
  }
  return code !== '' ? `Google refused the sign-in: ${code}` : 'Google would not sign this site in to Google Ads'
}

/**
 * An access token for the Google Ads account, swapped for the refresh token and
 * kept until it is nearly expired.
 *
 * Google's access tokens last an hour. Swapping one per call would cost a round
 * trip every time, and a catalogue-sized spend import is dozens of calls.
 */
export async function getAdsAccessToken(options: {
  credentials?: GoogleAdsCredentials
  attempts?: number
  retryBaseMs?: number
} = {}): Promise<string> {
  const credentials = requireGoogleAdsCredentials(options.credentials)
  const key = cacheKey(credentials)

  const cached = tokenCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.token

  const inFlight = pendingTokens.get(key)
  if (inFlight) return inFlight

  const mint = mintAdsAccessToken(key, credentials, options)
  pendingTokens.set(key, mint)
  try {
    return await mint
  } finally {
    pendingTokens.delete(key)
  }
}

async function mintAdsAccessToken(
  key: string,
  credentials: GoogleAdsCredentials,
  options: { attempts?: number; retryBaseMs?: number },
): Promise<string> {
  // Google's own reference for refreshing an access token: client_id,
  // client_secret, grant_type=refresh_token, refresh_token, form-encoded.
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
    grant_type: 'refresh_token',
  })

  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS)
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS
  let lastError: Error = new GoogleAuthError()

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleep(backoffMs(attempt, retryBaseMs, null))
    let response: Response
    try {
      response = await fetch(OAUTH_TOKEN_URI, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
    } catch (error) {
      lastError = new GoogleNetworkError(error instanceof Error ? error.message : 'Could not reach Google to sign in')
      continue
    }
    const json = await readJson(response) as TokenReply | null
    if (response.ok && typeof json?.access_token === 'string' && json.access_token !== '') {
      const seconds = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 3600
      tokenCache.set(key, {
        token: json.access_token,
        expiresAt: Date.now() + Math.max(0, seconds * 1000 - TOKEN_SKEW_MS),
      })
      return json.access_token
    }
    const message = tokenErrorMessage(json)
    // A revoked token is revoked however many times it is offered; only Google
    // being busy is worth another go.
    if (response.status !== 429 && response.status < 500) throw new GoogleAuthError(message)
    lastError = new GoogleAuthError(message)
  }
  throw lastError
}

function headersFor(credentials: GoogleAdsCredentials, token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    // Sent when the install still carries one. Google sunset developer tokens
    // on 9 September 2026 and now ignores the header, but an install that
    // predates that keeps working and one that never had one is not held back.
    ...(credentials.developerToken ? { 'developer-token': credentials.developerToken } : {}),
    // Only when the account sits under a manager. Google's own guidance is to
    // omit it, rather than repeat the account number, when it does not.
    ...(credentials.loginCustomerId ? { 'login-customer-id': credentials.loginCustomerId } : {}),
  }
}

/**
 * One Google Ads API call.
 *
 * `path` is everything after the version, e.g. `customers/123/googleAds:search`
 * or `customers/123:uploadClickConversions`. The version is added here so no
 * caller has to remember it and one constant moves the lot.
 *
 * Retries a rate limit or a wobble at Google's end; never retries a refusal.
 * A 401 empties the token cache and goes round once on a fresh token without
 * using up an attempt - and once only, because a revoked grant answers 401 for
 * ever and this must not become a loop.
 */
export async function adsRequest<T>(path: string, options: AdsRequestOptions): Promise<T> {
  const credentials = requireGoogleAdsCredentials(options.credentials)
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS)
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS
  const url = `${ADS_API_BASE}/${ADS_API_VERSION}/${path.replace(/^\//, '')}`
  const payload = JSON.stringify(options.body)

  let lastError: Error = new GoogleNetworkError()
  let attempt = 1
  let waitFirst = false
  let refreshed = false

  while (attempt <= attempts) {
    if (waitFirst) {
      const retryAfter = lastError instanceof GoogleAdsApiError ? lastError.retryAfter : null
      await sleep(backoffMs(attempt, retryBaseMs, retryAfter))
    }
    waitFirst = false

    // Inside the loop: a token can expire between one attempt and the next.
    const token = await getAdsAccessToken({ credentials, attempts, retryBaseMs })
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: headersFor(credentials, token),
        body: payload,
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      lastError = new GoogleNetworkError(error instanceof Error ? error.message : 'Could not reach Google Ads')
      attempt++
      waitFirst = true
      continue
    }

    const json = await readJson(response)
    if (response.ok) return json as T

    const failures = parseAdsFailure(json)
    const outer = (json as { error?: { message?: unknown } } | null)?.error?.message
    const failure = new GoogleAdsApiError({
      status: response.status,
      fallbackMessage: typeof outer === 'string' && outer.trim() !== ''
        ? outer.trim()
        : `Google Ads refused that request (${response.status})`,
      failures,
      requestId: parseAdsRequestId(json),
      retryAfter: response.headers.get('retry-after'),
    })

    if (response.status === 401 && !refreshed) {
      refreshed = true
      clearGoogleAdsTokenCache()
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

/** One row of a `googleAds:search` answer. Google returns a JSON object per
 *  row, with the selected fields nested under their resource - so a query
 *  selecting `segments.date` comes back as `{ segments: { date: '...' } }`. */
export type AdsRow = Record<string, unknown>

type SearchResponse = { results?: AdsRow[]; nextPageToken?: string }

/**
 * Every page of a GAQL query, handed over one page at a time.
 *
 * `pageSize` is NOT sent, and that is not an omission. Google's own v25 proto
 * marks `SearchGoogleAdsRequest.page_size` deprecated and says the API "returns
 * a PAGE_SIZE_NOT_SUPPORTED error if this field is set in the request body".
 * Pages are a fixed ten thousand rows. Sending the field would fail every
 * query, and it is exactly the field the Merchant API wants - which is why this
 * note is here rather than in a commit message.
 *
 * `onPage` is awaited before the next page is asked for, so a caller writing
 * each page to the database cannot get ahead of itself. Returning 'stop' ends
 * the walk, for a caller working to a time budget.
 */
export async function searchAdsPages(
  customerId: string,
  query: string,
  onPage: (rows: AdsRow[]) => Promise<void | 'stop'>,
  options: Omit<AdsRequestOptions, 'body'> = {},
): Promise<void> {
  let pageToken: string | undefined
  let pages = 0
  do {
    const page = await adsRequest<SearchResponse>(`customers/${customerId}/googleAds:search`, {
      ...options,
      body: { query, ...(pageToken === undefined ? {} : { pageToken }) },
    })
    if (await onPage(page.results ?? []) === 'stop') return
    pageToken = page.nextPageToken
    pages++
    if (pages >= MAX_PAGES && pageToken) {
      // Loudly, not silently. Everything read so far has already been handed to
      // onPage and is kept; what is thrown away is the belief that the answer
      // was complete, which is the thing a caller must not be allowed to assume.
      throw new Error(
        `Google Ads kept offering more pages after ${MAX_PAGES} of them, which is more than any account has. The read was stopped.`,
      )
    }
  } while (pageToken)
}

/** Every row of a GAQL query, gathered up. For the small ones - the account's
 *  own details, the list of conversion actions - where holding the answer in
 *  memory is obviously safe. */
export async function searchAds(
  customerId: string,
  query: string,
  options: Omit<AdsRequestOptions, 'body'> = {},
): Promise<AdsRow[]> {
  const rows: AdsRow[] = []
  await searchAdsPages(customerId, query, async (page) => {
    rows.push(...page)
  }, options)
  return rows
}
