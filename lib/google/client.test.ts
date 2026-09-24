import { createSign, generateKeyPairSync } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearGoogleTokenCache,
  getAccessToken,
  merchantRequest,
  requireGoogleCredentials,
  searchReport,
} from '@/modules/google-shopping-for-shop/lib/google/client'
import { parseGoogleCredentials, googleCredentialsFromEnv, hasGoogleCredentials } from '@/modules/google-shopping-for-shop/lib/google/credentials'
import {
  GoogleApiError,
  GoogleAuthError,
  GoogleCredentialsError,
  GoogleNetworkError,
} from '@/modules/google-shopping-for-shop/lib/google/errors'

// A real RSA key, because the client really signs with it: a stubbed signer
// would prove nothing about whether the assertion we build can be signed at all.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const CREDENTIALS = {
  clientEmail: 'cactus@example.iam.gserviceaccount.com',
  privateKey: PEM,
  tokenUri: 'https://oauth2.example/token',
}

// Every call in these tests turns retries round instantly; the backoff itself
// is checked by counting attempts, not by waiting for them.
const FAST = { credentials: CREDENTIALS, retryBaseMs: 0 } as const

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> }

function reply({ status = 200, body = {}, headers = {} }: Reply): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

const TOKEN_OK = { status: 200, body: { access_token: 'tok-1', expires_in: 3600 } }

/** A fetch stub that answers with the given replies in order, and records what
 *  it was asked for. */
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

beforeEach(() => {
  clearGoogleTokenCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  clearGoogleTokenCache()
})

describe('credentials', () => {
  it('reads a service-account key out of the environment', () => {
    vi.stubEnv('GOOGLE_SHOPPING_SERVICE_ACCOUNT_JSON', JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: 'k' }))
    const found = googleCredentialsFromEnv()
    expect(found?.clientEmail).toBe('a@b.iam.gserviceaccount.com')
    // The default endpoint, since the file did not name one.
    expect(found?.tokenUri).toBe('https://oauth2.googleapis.com/token')
    expect(hasGoogleCredentials()).toBe(true)
  })

  it('treats anything that is not a service-account key as no key at all', () => {
    expect(parseGoogleCredentials('not json')).toBeNull()
    expect(parseGoogleCredentials(JSON.stringify({ client_email: 'a@b' }))).toBeNull()
    expect(parseGoogleCredentials(JSON.stringify({ private_key: 'k' }))).toBeNull()
  })

  it('refuses with a typed error rather than a null when nothing is configured', () => {
    vi.stubEnv('GOOGLE_SHOPPING_SERVICE_ACCOUNT_JSON', '')
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_JSON', '')
    vi.stubEnv('GOOGLE_SHOPPING_SERVICE_ACCOUNT_FILE', '')
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '')
    expect(() => requireGoogleCredentials()).toThrow(GoogleCredentialsError)
  })
})

describe('access token', () => {
  it('signs an assertion the key can verify, and swaps it for a token', async () => {
    const { calls } = stubFetch([TOKEN_OK])
    const token = await getAccessToken(FAST)
    expect(token).toBe('tok-1')

    const body = calls[0]!.init!.body as URLSearchParams
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    const assertion = body.get('assertion')!
    const [header, payload, signature] = assertion.split('.')
    expect(signature).toBeTruthy()
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as { iss: string; scope: string; aud: string; exp: number }
    expect(claims.iss).toBe(CREDENTIALS.clientEmail)
    expect(claims.scope).toBe('https://www.googleapis.com/auth/content')
    expect(claims.aud).toBe(CREDENTIALS.tokenUri)
    // The signature has to be over exactly header.payload, url-safe base64, or
    // Google rejects the assertion without ever saying why.
    const expected = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey)
      .toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
    expect(signature).toBe(expected)
  })

  it('reuses a cached token rather than minting one per call', async () => {
    const { impl } = stubFetch([TOKEN_OK])
    await getAccessToken(FAST)
    await getAccessToken(FAST)
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('mints once when two calls ask at the same moment', async () => {
    const { impl } = stubFetch([TOKEN_OK])
    const [a, b] = await Promise.all([getAccessToken(FAST), getAccessToken(FAST)])
    expect(a).toBe('tok-1')
    expect(b).toBe('tok-1')
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('does not reuse a token that is about to expire', async () => {
    // Under the one-minute skew, so it is treated as spent the moment it lands.
    const { impl } = stubFetch([{ status: 200, body: { access_token: 'tok-short', expires_in: 30 } }])
    await getAccessToken(FAST)
    await getAccessToken(FAST)
    expect(impl).toHaveBeenCalledTimes(2)
  })

  it('gives up immediately on a rejected key, and says what Google said', async () => {
    const { impl } = stubFetch([{ status: 400, body: { error_description: 'Invalid JWT Signature.' } }])
    await expect(getAccessToken(FAST)).rejects.toThrow(GoogleAuthError)
    await expect(getAccessToken(FAST)).rejects.toThrow('Invalid JWT Signature.')
    // Twice because the test called it twice - never a retry of its own.
    expect(impl).toHaveBeenCalledTimes(2)
  })

  it('retries when Google is merely busy', async () => {
    const { impl } = stubFetch([{ status: 503, body: { error: { message: 'backend error' } } }, TOKEN_OK])
    expect(await getAccessToken({ ...FAST, attempts: 2 })).toBe('tok-1')
    expect(impl).toHaveBeenCalledTimes(2)
  })

  it('does not put the private key into an error when the key cannot sign', async () => {
    stubFetch([TOKEN_OK])
    const broken = { ...CREDENTIALS, privateKey: '-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n' }
    const error = await getAccessToken({ credentials: broken, retryBaseMs: 0 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GoogleCredentialsError)
    expect((error as Error).message).not.toContain('BEGIN PRIVATE KEY')
  })
})

describe('merchant requests', () => {
  it('sends the token as a bearer and posts JSON', async () => {
    const { calls } = stubFetch([TOKEN_OK, { status: 200, body: { ok: true } }])
    const out = await merchantRequest<{ ok: boolean }>('reports/v1/accounts/7/reports:search', { ...FAST, body: { query: 'x' } })
    expect(out.ok).toBe(true)
    const call = calls[1]!
    expect(call.url).toBe('https://merchantapi.googleapis.com/reports/v1/accounts/7/reports:search')
    expect(call.init!.method).toBe('POST')
    expect((call.init!.headers as Record<string, string>).Authorization).toBe('Bearer tok-1')
    expect(call.init!.body).toBe(JSON.stringify({ query: 'x' }))
  })

  it('defaults to GET with no body', async () => {
    const { calls } = stubFetch([TOKEN_OK, { status: 200, body: {} }])
    await merchantRequest('accounts/v1/accounts/7/shippingSettings', FAST)
    expect(calls[1]!.init!.method).toBe('GET')
    expect(calls[1]!.init!.body).toBeUndefined()
  })

  it('retries a rate limit and then succeeds', async () => {
    const { impl } = stubFetch([
      TOKEN_OK,
      { status: 429, body: { error: { message: 'Quota exceeded' } }, headers: { 'retry-after': '0' } },
      { status: 200, body: { done: true } },
    ])
    expect(await merchantRequest<{ done: boolean }>('reports/v1/accounts/7/x', FAST)).toEqual({ done: true })
    // token, 429, retry.
    expect(impl).toHaveBeenCalledTimes(3)
  })

  it('retries a 5xx up to the attempt limit and then gives Google\'s own message', async () => {
    stubFetch([TOKEN_OK, { status: 500, body: { error: { message: 'Internal error' } } }])
    const error = await merchantRequest('reports/v1/accounts/7/x', { ...FAST, attempts: 3 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GoogleApiError)
    expect((error as GoogleApiError).status).toBe(500)
    expect((error as Error).message).toBe('Internal error')
  })

  it('never retries a refusal', async () => {
    const { impl } = stubFetch([
      TOKEN_OK,
      { status: 403, body: { error: { message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } } },
    ])
    const error = await merchantRequest('reports/v1/accounts/7/x', FAST).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GoogleApiError)
    expect((error as GoogleApiError).forbidden).toBe(true)
    expect((error as GoogleApiError).reason).toBe('PERMISSION_DENIED')
    expect(impl).toHaveBeenCalledTimes(2)
  })

  it('turns an unreachable Google into a typed network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      if (String(input) === CREDENTIALS.tokenUri) return reply(TOKEN_OK)
      throw new TypeError('fetch failed')
    }))
    const error = await merchantRequest('reports/v1/accounts/7/x', { ...FAST, attempts: 2 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GoogleNetworkError)
  })

  it('mints a fresh token and goes round again once when a token is spent', async () => {
    const { calls } = stubFetch([
      { status: 200, body: { access_token: 'stale', expires_in: 3600 } },
      { status: 401, body: { error: { message: 'Invalid Credentials' } } },
      { status: 200, body: { access_token: 'fresh', expires_in: 3600 } },
      { status: 200, body: { done: true } },
    ])
    expect(await merchantRequest<{ done: boolean }>('reports/v1/accounts/7/x', FAST)).toEqual({ done: true })
    expect((calls[1]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer stale')
    expect((calls[3]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer fresh')
  })

  it('gives up on a 401 that keeps coming, rather than refreshing for ever', async () => {
    const { impl } = stubFetch([
      { status: 200, body: { access_token: 'tok', expires_in: 3600 } },
      { status: 401, body: { error: { message: 'Invalid Credentials' } } },
      { status: 200, body: { access_token: 'tok', expires_in: 3600 } },
      { status: 401, body: { error: { message: 'Invalid Credentials' } } },
    ])
    const error = await merchantRequest('reports/v1/accounts/7/x', FAST).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GoogleApiError)
    expect((error as GoogleApiError).status).toBe(401)
    // token, 401, token, 401 - and then it stops.
    expect(impl).toHaveBeenCalledTimes(4)
  })
})

describe('report paging', () => {
  it('follows every page and returns the rows together', async () => {
    const { calls } = stubFetch([
      TOKEN_OK,
      { status: 200, body: { results: [{ n: 1 }, { n: 2 }], nextPageToken: 'p2' } },
      { status: 200, body: { results: [{ n: 3 }] } },
    ])
    const rows = await searchReport<{ n: number }>('7', 'SELECT product_view.offer_id FROM product_view', FAST)
    expect(rows.map((row) => row.n)).toEqual([1, 2, 3])
    // The page token goes back exactly as it came, on the second request only.
    expect(JSON.parse(String(calls[1]!.init!.body)).pageToken).toBeUndefined()
    expect(JSON.parse(String(calls[2]!.init!.body)).pageToken).toBe('p2')
  })

  it('returns nothing rather than throwing when a report is empty', async () => {
    stubFetch([TOKEN_OK, { status: 200, body: {} }])
    expect(await searchReport('7', 'SELECT product_view.offer_id FROM product_view', FAST)).toEqual([])
  })
})
