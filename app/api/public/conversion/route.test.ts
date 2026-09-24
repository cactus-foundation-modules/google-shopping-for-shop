import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { ATTRIBUTION_COOKIE } from '@/modules/google-shopping-for-shop/lib/click-tracking/types'

// The consent gate on the conversion route, tested through the route itself.
//
// It is here because the hole it closes was invisible from every other angle.
// The landing route checks consent, so the feature LOOKED consent-gated; but
// core deletes nothing of ours when somebody withdraws, and the landing route
// can only clear the cookie on a later tagged landing, which a withdrawing
// visitor usually never makes. So "agree, arrive from Google, withdraw, buy"
// still wrote the join - at exactly the moment the link between a person's
// browsing and their order is actually made, and off the back of the one
// identifier (the Google click id) that stage 7 would go on to upload.
//
// Everything below the consent test is mocked to SUCCEED, deliberately: if the
// gate is removed, these cases fail rather than passing for some other reason.

const getGsfSettingsCached = vi.hoisted(() => vi.fn())
const getOrderByNumber = vi.hoisted(() => vi.fn())
const mayOpenReceipt = vi.hoisted(() => vi.fn())
const claimBeaconSlot = vi.hoisted(() => vi.fn())
const lastClickFor = vi.hoisted(() => vi.fn())
const attributeOrder = vi.hoisted(() => vi.fn())
const forgetAttribution = vi.hoisted(() => vi.fn())
const visitorKeys = vi.hoisted(() => vi.fn())

vi.mock('@/modules/google-shopping-for-shop/lib/settings', () => ({ getGsfSettingsCached }))
vi.mock('@/modules/shop/lib/db/orders', () => ({ getOrderByNumber }))
vi.mock('@/modules/shop/lib/order-viewer', () => ({ mayOpenReceipt }))
vi.mock('@/modules/google-shopping-for-shop/lib/click-tracking/store', () => ({
  claimBeaconSlot, lastClickFor, attributeOrder, forgetAttribution,
}))
vi.mock('@/modules/google-shopping-for-shop/lib/click-tracking/visitor', async () => {
  const real = await vi.importActual<typeof import('@/modules/google-shopping-for-shop/lib/click-tracking/visitor')>(
    '@/modules/google-shopping-for-shop/lib/click-tracking/visitor',
  )
  // Only the key derivation is stubbed - reading and clearing the cookie is the
  // thing under test and stays real.
  return { ...real, visitorKeys }
})

const { POST } = await import('./route')

const ATTRIBUTION_ID = 'AAAAAAAAAAAAAAAAAAAAAA'

/** `decision` is what core's consent cookie holds. Undefined means the banner
 *  has never been answered, which denies exactly as a refusal does. */
function requestFor(options: { attribution?: string; marketing?: boolean } = {}): NextRequest {
  const cookies: string[] = []
  if (options.attribution !== undefined) cookies.push(`${ATTRIBUTION_COOKIE}=${options.attribution}`)
  if (options.marketing !== undefined) {
    const payload = encodeURIComponent(JSON.stringify({ decision: { marketing: options.marketing } }))
    cookies.push(`cactus-consent=${payload}`)
  }
  return new NextRequest('https://example.test/api/m/google-shopping-for-shop/public/conversion', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
      'sec-fetch-mode': 'same-origin',
      'sec-fetch-dest': 'empty',
      ...(cookies.length > 0 ? { cookie: cookies.join('; ') } : {}),
    },
    body: JSON.stringify({ orderNumber: 'DW000123' }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  getGsfSettingsCached.mockResolvedValue({ enabled: true, clickTrackingEnabled: true })
  visitorKeys.mockResolvedValue({ sessionKey: 'sess', rateKey: 'rate' })
  claimBeaconSlot.mockResolvedValue(true)
  getOrderByNumber.mockResolvedValue({
    id: 'o1', orderNumber: 'DW000123', total: '1080.00', currency: 'GBP', paymentStatus: 'PAID', memberId: null,
  })
  mayOpenReceipt.mockResolvedValue(true)
  lastClickFor.mockResolvedValue({ id: 'click-1', landedAt: new Date(), productId: 'p1', source: 'paid' })
  attributeOrder.mockResolvedValue(true)
  forgetAttribution.mockResolvedValue({ landings: 1, attributions: 0 })
})

describe('conversion route consent gate', () => {
  it('joins the sale for a visitor who still agrees', async () => {
    const response = await POST(requestFor({ attribution: ATTRIBUTION_ID, marketing: true }))
    expect(response.status).toBe(204)
    expect(attributeOrder).toHaveBeenCalledOnce()
    expect(forgetAttribution).not.toHaveBeenCalled()
  })

  it('refuses, erases and clears the cookie once consent is WITHDRAWN', async () => {
    const response = await POST(requestFor({ attribution: ATTRIBUTION_ID, marketing: false }))
    expect(response.status).toBe(204)
    // The join is the thing that must not happen.
    expect(attributeOrder).not.toHaveBeenCalled()
    // The stored click id goes with it - the owner's rule, not just a refusal.
    expect(forgetAttribution).toHaveBeenCalledWith(ATTRIBUTION_ID)
    // And the thread is cut here rather than left to expire.
    expect(response.cookies.get(ATTRIBUTION_COOKIE)?.value).toBe('')
    // It never reached the order at all.
    expect(getOrderByNumber).not.toHaveBeenCalled()
  })

  it('treats a banner nobody has answered as a refusal, but destroys nothing', async () => {
    // Two different questions. No join, because that needs an explicit yes; no
    // erasure, because that needs an explicit no. The cookie goes either way.
    const response = await POST(requestFor({ attribution: ATTRIBUTION_ID }))
    expect(response.status).toBe(204)
    expect(attributeOrder).not.toHaveBeenCalled()
    expect(forgetAttribution).not.toHaveBeenCalled()
    expect(response.cookies.get(ATTRIBUTION_COOKIE)?.value).toBe('')
  })

  it('will not erase on an attribution id with no consent cookie behind it', async () => {
    // The hardening: core writes the consent cookie before it announces a
    // change and it outlives the attribution cookie by a year, so this shape is
    // a replayed id rather than a browser - and erasure is permanent.
    const response = await POST(requestFor({ attribution: 'BBBBBBBBBBBBBBBBBBBBBB' }))
    expect(response.status).toBe(204)
    expect(forgetAttribution).not.toHaveBeenCalled()
  })

  it('does nothing at all without an attribution cookie, whatever the consent says', async () => {
    const response = await POST(requestFor({ marketing: true }))
    expect(response.status).toBe(204)
    expect(getOrderByNumber).not.toHaveBeenCalled()
    expect(attributeOrder).not.toHaveBeenCalled()
    expect(forgetAttribution).not.toHaveBeenCalled()
  })

  it('puts the brake on before it will erase anything', async () => {
    // Both branches below this point write, and an attribution id is 22
    // characters anybody can invent - so a throttled caller must not be able to
    // spend a pair of writes per request on a made-up one.
    claimBeaconSlot.mockResolvedValue(false)
    const response = await POST(requestFor({ attribution: ATTRIBUTION_ID, marketing: false }))
    expect(response.status).toBe(204)
    expect(forgetAttribution).not.toHaveBeenCalled()
    expect(attributeOrder).not.toHaveBeenCalled()
  })

  it('never joins a sale the browser cannot prove is its own', async () => {
    mayOpenReceipt.mockResolvedValue(false)
    const response = await POST(requestFor({ attribution: ATTRIBUTION_ID, marketing: true }))
    expect(response.status).toBe(204)
    expect(attributeOrder).not.toHaveBeenCalled()
  })
})
