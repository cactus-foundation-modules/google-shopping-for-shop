import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  adsRequest,
  clearGoogleAdsTokenCache,
  getAdsAccessToken,
  requireGoogleAdsCredentials,
  searchAds,
} from '@/modules/google-shopping-for-shop/lib/google-ads/client'
import {
  adsEnvPresence,
  googleAdsCredentialsFromEnv,
  hasGoogleAdsCredentials,
  missingAdsEnvVars,
  type GoogleAdsCredentials,
} from '@/modules/google-shopping-for-shop/lib/google-ads/credentials'
import { GoogleAdsApiError, GoogleAuthError, GoogleCredentialsError } from '@/modules/google-shopping-for-shop/lib/google-ads/errors'

const CREDENTIALS: GoogleAdsCredentials = {
  clientId: 'client-1.apps.googleusercontent.com',
  clientSecret: 'secret-1',
  refreshToken: 'refresh-1',
  customerId: '1234567890',
  loginCustomerId: null,
  developerToken: null,
}

// Every call in these tests turns retries round instantly; the backoff itself is
// checked by counting attempts rather than by waiting for them.
const FAST = { credentials: CREDENTIALS, retryBaseMs: 0 } as const

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> }

function reply({ status = 200, body = {}, headers = {} }: Reply): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

const TOKEN_OK: Reply = { status: 200, body: { access_token: 'tok-1', expires_in: 3600 } }

function stubFetch(replies: Reply[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  let at = 0
  const impl = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    const next = replies[Math.min(at, replies.length - 1)]
    at++
    if (!next) throw new Error('no reply configured')
    return reply(next)
  })
  vi.stubGlobal('fetch', impl)
  return { calls, impl }
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined
  return headers?.[name]
}

beforeEach(() => {
  clearGoogleAdsTokenCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  clearGoogleAdsTokenCache()
})

describe('credentials', () => {
  function setAll() {
    vi.stubEnv('GOOGLE_ADS_CLIENT_ID', 'client-1')
    vi.stubEnv('GOOGLE_ADS_CLIENT_SECRET', 'secret-1')
    vi.stubEnv('GOOGLE_ADS_REFRESH_TOKEN', 'refresh-1')
    vi.stubEnv('GOOGLE_ADS_CUSTOMER_ID', '123-456-7890')
  }

  it('reads the four that matter, and strips the dashes off the account number', () => {
    setAll()
    expect(googleAdsCredentialsFromEnv()).toEqual({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      refreshToken: 'refresh-1',
      customerId: '1234567890',
      loginCustomerId: null,
      developerToken: null,
    })
    expect(hasGoogleAdsCredentials()).toBe(true)
    expect(missingAdsEnvVars()).toEqual([])
  })

  it('names exactly what is missing rather than failing silently', () => {
    vi.stubEnv('GOOGLE_ADS_CLIENT_ID', 'client-1')
    vi.stubEnv('GOOGLE_ADS_CLIENT_SECRET', '')
    vi.stubEnv('GOOGLE_ADS_REFRESH_TOKEN', '')
    vi.stubEnv('GOOGLE_ADS_CUSTOMER_ID', '')
    expect(googleAdsCredentialsFromEnv()).toBeNull()
    expect(missingAdsEnvVars()).toEqual(['GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID'])
  })

  it('does NOT need a developer token, which Google retired in September 2026', () => {
    setAll()
    expect(missingAdsEnvVars()).toEqual([])
    expect(googleAdsCredentialsFromEnv()?.developerToken).toBeNull()
    // ...and still carries one along when an install has one.
    vi.stubEnv('GOOGLE_ADS_DEVELOPER_TOKEN', 'dev-1')
    expect(googleAdsCredentialsFromEnv()?.developerToken).toBe('dev-1')
  })

  it('reports presence and nothing else', () => {
    setAll()
    const presence = adsEnvPresence()
    expect(presence.GOOGLE_ADS_CLIENT_SECRET).toBe(true)
    expect(presence.GOOGLE_ADS_LOGIN_CUSTOMER_ID).toBe(false)
    // Values, lengths and masked values all stay out of it.
    expect(Object.values(presence).every((value) => typeof value === 'boolean')).toBe(true)
  })

  it('refuses with a typed error rather than a null the caller can forget', () => {
    expect(() => requireGoogleAdsCredentials()).toThrow(GoogleCredentialsError)
  })
})

describe('signing in', () => {
  it('swaps the refresh token for an access token, the documented way', async () => {
    const { calls } = stubFetch([TOKEN_OK])
    expect(await getAdsAccessToken(FAST)).toBe('tok-1')
    expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/token')
    const body = String(calls[0]?.init?.body)
    expect(body).toContain('grant_type=refresh_token')
    expect(body).toContain('refresh_token=refresh-1')
    expect(body).toContain('client_id=client-1')
    expect(body).toContain('client_secret=secret-1')
  })

  it('keeps the token rather than swapping one per call', async () => {
    const { impl } = stubFetch([TOKEN_OK])
    await getAdsAccessToken(FAST)
    await getAdsAccessToken(FAST)
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('does not hand out a token that is about to expire', async () => {
    stubFetch([{ status: 200, body: { access_token: 'tok-short', expires_in: 30 } }])
    await getAdsAccessToken(FAST)
    const { impl } = stubFetch([TOKEN_OK])
    await getAdsAccessToken(FAST)
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('explains a revoked grant in words an owner can act on', async () => {
    stubFetch([{ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }])
    await expect(getAdsAccessToken(FAST)).rejects.toThrow(GoogleAuthError)
  })

  it('does not keep offering a bad sign-in', async () => {
    const { impl } = stubFetch([{ status: 401, body: { error: 'invalid_client' } }])
    await expect(getAdsAccessToken(FAST)).rejects.toThrow(GoogleAuthError)
    expect(impl).toHaveBeenCalledTimes(1)
  })
})

describe('adsRequest', () => {
  it('puts the version in the path and signs the call', async () => {
    const { calls } = stubFetch([TOKEN_OK, { status: 200, body: { results: [] } }])
    await adsRequest('customers/1234567890/googleAds:search', { ...FAST, body: { query: 'SELECT customer.id FROM customer' } })
    expect(calls[1]?.url).toBe('https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search')
    expect(headerOf(calls[1]?.init, 'Authorization')).toBe('Bearer tok-1')
    expect(headerOf(calls[1]?.init, 'Content-Type')).toBe('application/json')
  })

  it('leaves out the headers this connection has nothing for', async () => {
    const { calls } = stubFetch([TOKEN_OK, { status: 200, body: {} }])
    await adsRequest('customers/1/googleAds:search', { ...FAST, body: {} })
    // Google's own guidance is to omit login-customer-id when the account is
    // stood alone rather than to repeat the account number into it.
    expect(headerOf(calls[1]?.init, 'login-customer-id')).toBeUndefined()
    expect(headerOf(calls[1]?.init, 'developer-token')).toBeUndefined()
  })

  it('sends the two headers when the connection has them', async () => {
    const { calls } = stubFetch([TOKEN_OK, { status: 200, body: {} }])
    await adsRequest('customers/1/googleAds:search', {
      credentials: { ...CREDENTIALS, loginCustomerId: '9999999999', developerToken: 'dev-1' },
      retryBaseMs: 0,
      body: {},
    })
    expect(headerOf(calls[1]?.init, 'login-customer-id')).toBe('9999999999')
    expect(headerOf(calls[1]?.init, 'developer-token')).toBe('dev-1')
  })

  it('digs the real complaint out of a refusal', async () => {
    stubFetch([TOKEN_OK, {
      status: 403,
      body: {
        error: {
          code: 403,
          message: 'The caller does not have permission',
          details: [{
            errors: [{
              errorCode: { authorizationError: 'CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE' },
              message: 'The customer is not allowlisted for this feature.',
            }],
            requestId: 'req-1',
          }],
        },
      },
    }])
    await expect(adsRequest('customers/1/googleAds:search', { ...FAST, body: {} }))
      .rejects.toMatchObject({ code: 'CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE', status: 403 })
  })

  it('never retries a refusal, and does retry a rate limit', async () => {
    const refusal = stubFetch([TOKEN_OK, { status: 400, body: { error: { message: 'bad' } } }])
    await expect(adsRequest('customers/1/googleAds:search', { ...FAST, body: {} })).rejects.toThrow(GoogleAdsApiError)
    expect(refusal.impl).toHaveBeenCalledTimes(2)

    clearGoogleAdsTokenCache()
    const limited = stubFetch([TOKEN_OK, { status: 429, body: { error: { message: 'slow down' } } }])
    await expect(adsRequest('customers/1/googleAds:search', { ...FAST, body: {}, attempts: 3 })).rejects.toThrow(GoogleAdsApiError)
    // One token, three tries.
    expect(limited.impl).toHaveBeenCalledTimes(4)
  })

  it('refreshes a stale token once, and only once', async () => {
    let at = 0
    const impl = vi.fn(async (input: unknown) => {
      at++
      if (String(input).includes('oauth2')) return reply(TOKEN_OK)
      return reply({ status: 401, body: { error: { message: 'expired' } } })
    })
    vi.stubGlobal('fetch', impl)
    await expect(adsRequest('customers/1/googleAds:search', { ...FAST, body: {}, attempts: 1 })).rejects.toThrow(GoogleAdsApiError)
    // token, 401, token again, 401 again - and then it stops rather than
    // looping for ever against a revoked grant.
    expect(at).toBe(4)
  })
})

describe('searchAds', () => {
  it('never sends pageSize, which Google now refuses outright', async () => {
    const { calls } = stubFetch([TOKEN_OK, { status: 200, body: { results: [{ customer: { id: '1' } }] } }])
    await searchAds('1234567890', 'SELECT customer.id FROM customer', FAST)
    const body = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>
    // v25's own proto marks page_size deprecated: "Google Ads API returns a
    // PAGE_SIZE_NOT_SUPPORTED error if this field is set in the request body."
    expect(body).toEqual({ query: 'SELECT customer.id FROM customer' })
    expect('pageSize' in body).toBe(false)
  })

  it('stops rather than following a page token that never ends', async () => {
    // The callers check their wall clock BETWEEN windows, not between pages, so
    // without a cap here a token that pointed at itself would spin until the
    // route was killed - nothing written, and nothing said about why.
    let pages = 0
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      if (String(input).includes('oauth2')) return reply(TOKEN_OK)
      pages++
      return reply({ body: { results: [{ customer: { id: '1' } }], nextPageToken: 'for-ever' } })
    }))
    await expect(searchAds('1234567890', 'SELECT customer.id FROM customer', FAST))
      .rejects.toThrow(/kept offering more pages/)
    // Loudly, and bounded. Everything already read was handed to the caller;
    // what is refused is the belief that the answer was complete.
    expect(pages).toBe(500)
  })

  it('follows the page token through to the end', async () => {
    let at = 0
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).includes('oauth2')) return reply(TOKEN_OK)
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      at++
      return at === 1
        ? reply({ body: { results: [{ customer: { id: '1' } }], nextPageToken: 'page-2' } })
        : reply({ body: { results: [{ customer: { id: '2' } }] } })
    }))
    const rows = await searchAds('1234567890', 'SELECT customer.id FROM customer', FAST)
    expect(rows).toHaveLength(2)
    expect(bodies[0]?.pageToken).toBeUndefined()
    expect(bodies[1]?.pageToken).toBe('page-2')
  })
})
