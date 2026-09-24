import { generateKeyPairSync } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkGoogleAccess, type AccessProbeId, type AccessReport } from '@/modules/google-shopping-for-shop/lib/google/access-check'
import { clearGoogleTokenCache } from '@/modules/google-shopping-for-shop/lib/google/client'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const KEY_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'cactus@example.iam.gserviceaccount.com',
  private_key: PEM,
  token_uri: 'https://oauth2.example/token',
})

type Reply = { status?: number; body?: unknown }

function reply({ status = 200, body = {} }: Reply): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** Answers the token endpoint, then whatever each probe's URL is routed to.
 *  Routing by URL rather than by call order, so a reordered probe does not
 *  quietly start reading another probe's answer. */
function stubGoogle(routes: Array<[RegExp, Reply]>) {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    if (url.includes('oauth2')) return reply({ body: { access_token: 'tok', expires_in: 3600 } })
    for (const [pattern, answer] of routes) if (pattern.test(url)) return reply(answer)
    return reply({ status: 404, body: { error: { message: 'not stubbed' } } })
  }))
  return urls
}

function probe(report: AccessReport, id: AccessProbeId) {
  const found = report.probes.find((p) => p.id === id)
  if (!found) throw new Error(`no ${id} probe`)
  return found
}

const FAST = { retryBaseMs: 0 }

beforeEach(() => {
  clearGoogleTokenCache()
  vi.stubEnv('GOOGLE_SHOPPING_SERVICE_ACCOUNT_JSON', KEY_JSON)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  clearGoogleTokenCache()
})

describe('access check', () => {
  it('says yes to everything an ADMIN key can do when Google plays along', async () => {
    stubGoogle([
      [/reports:search/, { body: { results: [] } }],
      [/shippingSettings/, { body: { name: 'accounts/7/shippingSettings', services: [] } }],
      [/\/users\//, { body: { accessRights: ['ADMIN'] } }],
    ])
    const report = await checkGoogleAccess('7', FAST)
    expect(report.credentials).toBe('set')
    expect(report.serviceAccountEmail).toBe('cactus@example.iam.gserviceaccount.com')
    expect(report.probes.map((p) => p.status)).toEqual(['ok', 'ok', 'ok', 'ok'])
  })

  // The distinction that matters, and the one this got wrong at first. Google's
  // own discovery document says of shippingSettings.insert: "Executing this
  // method requires admin access." A Standard key may send product changes and
  // may NOT replace the delivery settings, and telling an owner otherwise sends
  // them off to press a button that 403s.
  it('says a Standard key may send product changes but NOT the delivery settings', async () => {
    stubGoogle([
      [/reports:search/, { body: { results: [] } }],
      [/shippingSettings/, { body: { services: [] } }],
      [/\/users\//, { body: { accessRights: ['STANDARD'] } }],
    ])
    const report = await checkGoogleAccess('7', FAST)
    expect(probe(report, 'write').status).toBe('ok')
    expect(probe(report, 'delivery-push').status).toBe('denied')
    expect(probe(report, 'delivery-push').detail).toContain('Admin')
    expect(probe(report, 'delivery-push').detail).toContain('"Standard" is not enough')
  })

  it('asks Google about the access rights ONCE for both of those answers', async () => {
    const urls = stubGoogle([
      [/reports:search/, { body: { results: [] } }],
      [/shippingSettings/, { body: {} }],
      [/\/users\//, { body: { accessRights: ['ADMIN'] } }],
    ])
    await checkGoogleAccess('7', FAST)
    expect(urls.filter((url) => url.includes('/users/'))).toHaveLength(1)
  })

  it('reads the write answer off the access rights, without writing anything', async () => {
    const urls = stubGoogle([
      [/reports:search/, { body: { results: [] } }],
      [/shippingSettings/, { body: {} }],
      [/\/users\//, { body: { accessRights: ['READ_ONLY'] } }],
    ])
    const report = await checkGoogleAccess('7', FAST)
    expect(probe(report, 'write').status).toBe('denied')
    expect(probe(report, 'write').detail).toContain('Standard')
    expect(probe(report, 'delivery-push').status).toBe('denied')
    // Every call out is a read: the only POST is the reports query, which is a
    // search, and the token mint. Three calls for four answers, because the two
    // access-level questions share one lookup.
    expect(urls.filter((url) => url.includes('merchantapi'))).toHaveLength(3)
  })

  it('accepts admin as well as standard for product changes', async () => {
    stubGoogle([
      [/reports:search/, { body: { results: [] } }],
      [/shippingSettings/, { body: {} }],
      [/\/users\//, { body: { accessRights: ['ADMIN', 'PERFORMANCE_REPORTING'] } }],
    ])
    expect(probe(await checkGoogleAccess('7', FAST), 'write').status).toBe('ok')
  })

  it('turns a refusal into a no, with Google\'s reason and what to do about it', async () => {
    stubGoogle([
      [/reports:search/, { status: 403, body: { error: { message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } } }],
      [/shippingSettings/, { status: 403, body: { error: { message: 'The caller does not have permission' } } }],
      [/\/users\//, { status: 403, body: { error: { message: 'The caller does not have permission' } } }],
    ])
    const report = await checkGoogleAccess('7', FAST)
    expect(probe(report, 'reports').status).toBe('denied')
    expect(probe(report, 'reports').detail).toContain('The caller does not have permission')
    expect(probe(report, 'reports').detail).toContain('People and access')
  })

  it('says "not known" rather than "no" when Google simply breaks', async () => {
    stubGoogle([
      [/reports:search/, { status: 500, body: { error: { message: 'Internal error' } } }],
      [/shippingSettings/, { status: 500, body: { error: { message: 'Internal error' } } }],
      [/\/users\//, { status: 500, body: { error: { message: 'Internal error' } } }],
    ])
    const report = await checkGoogleAccess('7', { retryBaseMs: 0, attempts: 1 })
    expect(report.probes.map((p) => p.status)).toEqual(['unknown', 'unknown', 'unknown', 'unknown'])
  })

  it('reads a missing delivery settings answer as not known, not a refusal', async () => {
    stubGoogle([
      [/reports:search/, { body: { results: [] } }],
      [/shippingSettings/, { status: 404, body: { error: { message: 'Not found' } } }],
      [/\/users\//, { body: { accessRights: ['ADMIN'] } }],
    ])
    const report = await checkGoogleAccess('7', FAST)
    expect(probe(report, 'shipping').status).toBe('unknown')
    expect(probe(report, 'shipping').detail).toContain('did not return any delivery settings')
  })

  it('tells the owner to add the service account when Merchant Center has never heard of it', async () => {
    stubGoogle([
      [/reports:search/, { body: { results: [] } }],
      [/shippingSettings/, { body: {} }],
      [/\/users\//, { status: 404, body: { error: { message: 'Not found' } } }],
    ])
    const report = await checkGoogleAccess('7', FAST)
    expect(probe(report, 'write').status).toBe('denied')
    expect(probe(report, 'write').detail).toContain('no user with that address')
  })

  it('asks nothing of Google when there is no key, and says which is missing', async () => {
    vi.stubEnv('GOOGLE_SHOPPING_SERVICE_ACCOUNT_JSON', '')
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_JSON', '')
    vi.stubEnv('GOOGLE_SHOPPING_SERVICE_ACCOUNT_FILE', '')
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '')
    const called = stubGoogle([])
    const report = await checkGoogleAccess('7', FAST)
    expect(report.credentials).toBe('missing')
    expect(report.serviceAccountEmail).toBeNull()
    expect(report.probes).toHaveLength(4)
    expect(called).toHaveLength(0)
  })

  it('separates a key that is the wrong file from no key at all', async () => {
    vi.stubEnv('GOOGLE_SHOPPING_SERVICE_ACCOUNT_JSON', '{"installed":{"client_id":"x"}}')
    const called = stubGoogle([])
    const report = await checkGoogleAccess('7', FAST)
    expect(report.credentials).toBe('malformed')
    expect(report.probes[0]!.detail).toContain('not a Google service-account key')
    expect(called).toHaveLength(0)
  })

  it('stops short when the account number has not been filled in', async () => {
    const called = stubGoogle([])
    const report = await checkGoogleAccess(null, FAST)
    expect(report.merchantId).toBeNull()
    expect(report.probes.every((p) => p.status === 'unknown')).toBe(true)
    expect(report.probes[0]!.detail).toContain('account number')
    expect(called).toHaveLength(0)
  })

  it('never puts the private key anywhere in its answer', async () => {
    stubGoogle([
      [/reports:search/, { status: 403, body: { error: { message: 'no' } } }],
      [/shippingSettings/, { status: 403, body: { error: { message: 'no' } } }],
      [/\/users\//, { status: 403, body: { error: { message: 'no' } } }],
    ])
    const report = await checkGoogleAccess('7', FAST)
    const serialised = JSON.stringify(report)
    expect(serialised).not.toContain('BEGIN PRIVATE KEY')
    expect(serialised).not.toContain('tok')
  })
})
