import { generateKeyPairSync } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearGoogleTokenCache } from '@/modules/google-shopping-for-shop/lib/google/client'
import { GoogleApiError } from '@/modules/google-shopping-for-shop/lib/google/errors'
import {
  isEtagConflict,
  readShippingSettings,
  writeShippingSettings,
} from '@/modules/google-shopping-for-shop/lib/delivery/merchant'

// Same harness as lib/google/access-check.test.ts: a real key, real signing,
// stubbed fetch. Nothing here reaches Google.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const KEY_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'cactus@example.iam.gserviceaccount.com',
  private_key: PEM,
  token_uri: 'https://oauth2.example/token',
})

type Reply = { status?: number; body?: unknown }

function stubGoogle(routes: Array<[RegExp, Reply]>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('oauth2')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
    }
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    })
    for (const [pattern, answer] of routes) {
      if (pattern.test(url)) {
        return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 })
      }
    }
    return new Response(JSON.stringify({ error: { message: 'not stubbed' } }), { status: 404 })
  }))
  return calls
}

const FAST = { retryBaseMs: 0, attempts: 1 }

beforeEach(() => {
  clearGoogleTokenCache()
  vi.stubEnv('GOOGLE_SHOPPING_SERVICE_ACCOUNT_JSON', KEY_JSON)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  clearGoogleTokenCache()
})

describe('readShippingSettings', () => {
  it('reads the settings and the etag off the resource', async () => {
    stubGoogle([[/shippingSettings$/, { body: { name: 'accounts/7/shippingSettings', etag: 'abc', services: [] } }]])
    const read = await readShippingSettings('7', FAST)
    expect(read.etag).toBe('abc')
    expect(read.exists).toBe(true)
  })

  // An account with nothing set up is a normal state, and it is what a first
  // push starts from - an empty etag is exactly what Google asks for there.
  it('treats a 404 as an account with nothing set up yet', async () => {
    stubGoogle([[/shippingSettings$/, { status: 404, body: { error: { message: 'Not found' } } }]])
    const read = await readShippingSettings('7', FAST)
    expect(read).toEqual({ settings: { services: [] }, etag: '', exists: false })
  })

  // Everything Google holds that this module does not model has to survive the
  // round trip, because the write sends back what the read returned. A schema
  // that stripped unknown keys would silently delete a hand-made setting.
  it('carries fields it does not model straight through', async () => {
    stubGoogle([[/shippingSettings$/, {
      body: {
        etag: 'abc',
        services: [{
          serviceName: 'Pallet',
          minimumOrderValue: { amountMicros: '50000000', currencyCode: 'GBP' },
          somethingGoogleAddedLastTuesday: { nested: true },
        }],
        warehouses: [{ name: 'Main' }],
      },
    }]])
    const { settings } = await readShippingSettings('7', FAST)
    expect(settings.services?.[0]?.minimumOrderValue).toEqual({ amountMicros: '50000000', currencyCode: 'GBP' })
    expect(settings.services?.[0]?.somethingGoogleAddedLastTuesday).toEqual({ nested: true })
    expect(settings.warehouses).toEqual([{ name: 'Main' }])
  })
})

describe('writeShippingSettings', () => {
  it('posts to the insert endpoint with the etag in the body', async () => {
    const calls = stubGoogle([[/shippingSettings:insert/, { body: { etag: 'def', services: [] } }]])
    await writeShippingSettings('7', { etag: 'abc', services: [] }, FAST)
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toContain('accounts/v1/accounts/7/shippingSettings:insert')
    expect((calls[0]?.body as { etag?: string })?.etag).toBe('abc')
  })

  it('gives back what Google now holds, not what was sent', async () => {
    stubGoogle([[/shippingSettings:insert/, {
      body: { etag: 'def', services: [{ serviceName: 'Standard', shipmentType: 'DELIVERY' }] },
    }]])
    const confirmed = await writeShippingSettings('7', { etag: 'abc', services: [{ serviceName: 'Standard' }] }, FAST)
    // Google's own words, normalisation included - which is the whole point:
    // Undo compares the live settings against this.
    expect(confirmed?.services?.[0]?.shipmentType).toBe('DELIVERY')
    expect(confirmed?.etag).toBe('def')
  })

  // It used to substitute the payload we SENT, which made the caller's "could
  // not read the reply" branch unreachable and quietly recorded our own guess
  // as the snapshot Undo compares against.
  it('answers null when the reply cannot be read, never our own payload', async () => {
    stubGoogle([[/shippingSettings:insert/, { body: { services: 'not a list at all' } }]])
    const sent = { etag: 'abc', services: [{ serviceName: 'Standard' }] }
    expect(await writeShippingSettings('7', sent, FAST)).toBeNull()
  })

  it('still throws when Google refuses the write', async () => {
    stubGoogle([[/shippingSettings:insert/, { status: 403, body: { error: { message: 'The caller does not have permission' } } }]])
    await expect(writeShippingSettings('7', { etag: 'abc' }, FAST)).rejects.toBeInstanceOf(GoogleApiError)
  })
})

describe('isEtagConflict', () => {
  it('recognises Google saying the settings moved under us', () => {
    expect(isEtagConflict(new GoogleApiError('The etag does not match', 400))).toBe(true)
    expect(isEtagConflict(new GoogleApiError('Operation was aborted', 409))).toBe(true)
    expect(isEtagConflict(new GoogleApiError('conflict', 412))).toBe(true)
  })

  it('does not mistake an ordinary refusal for one', () => {
    expect(isEtagConflict(new GoogleApiError('The caller does not have permission', 403))).toBe(false)
    expect(isEtagConflict(new GoogleApiError('Something broke', 500))).toBe(false)
    expect(isEtagConflict(new Error('not a Google error'))).toBe(false)
  })
})
