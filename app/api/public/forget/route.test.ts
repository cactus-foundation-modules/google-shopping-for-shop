import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { ATTRIBUTION_COOKIE } from '@/modules/google-shopping-for-shop/lib/click-tracking/types'

// The withdrawal route, tested through the route itself.
//
// The case that matters most is the one the final review found: this must erase
// EVEN WHEN THE MODULE IS SWITCHED OFF. An owner who turns the feed off still
// holds the rows written while it was on, and gating the erase on any setting
// would turn "switch it off" into a way to keep the stored Google click ids and
// ignore every withdrawal until the retention window happened to expire.
//
// The collaborators are mocked to SUCCEED, so a gate creeping back in fails
// these cases rather than passing for some other reason.

const claimBeaconSlot = vi.hoisted(() => vi.fn())
const forgetAttribution = vi.hoisted(() => vi.fn())
const visitorKeys = vi.hoisted(() => vi.fn())
const getGsfSettingsCached = vi.hoisted(() => vi.fn())

vi.mock('@/modules/google-shopping-for-shop/lib/click-tracking/store', () => ({ claimBeaconSlot, forgetAttribution }))
vi.mock('@/modules/google-shopping-for-shop/lib/settings', () => ({ getGsfSettingsCached }))
vi.mock('@/modules/google-shopping-for-shop/lib/click-tracking/visitor', async () => {
  const real = await vi.importActual<typeof import('@/modules/google-shopping-for-shop/lib/click-tracking/visitor')>(
    '@/modules/google-shopping-for-shop/lib/click-tracking/visitor',
  )
  // Only the key derivation is stubbed; reading and clearing the cookie is the
  // thing under test and stays real.
  return { ...real, visitorKeys }
})

const { POST } = await import('./route')

const ATTRIBUTION_ID = 'AAAAAAAAAAAAAAAAAAAAAA'

function requestFor(options: { attribution?: string; marketing?: boolean; agent?: string } = {}): NextRequest {
  const cookies: string[] = []
  if (options.attribution !== undefined) cookies.push(`${ATTRIBUTION_COOKIE}=${options.attribution}`)
  if (options.marketing !== undefined) {
    cookies.push(`cactus-consent=${encodeURIComponent(JSON.stringify({ decision: { marketing: options.marketing } }))}`)
  }
  return new NextRequest('https://example.test/api/m/google-shopping-for-shop/public/forget', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': options.agent
        ?? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
      'sec-fetch-mode': 'same-origin',
      'sec-fetch-dest': 'empty',
      ...(cookies.length > 0 ? { cookie: cookies.join('; ') } : {}),
    },
    body: '{}',
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  visitorKeys.mockResolvedValue({ sessionKey: 'sess', rateKey: 'rate' })
  claimBeaconSlot.mockResolvedValue(true)
  forgetAttribution.mockResolvedValue({ landings: 2, attributions: 1 })
  // Everything off, deliberately - see below.
  getGsfSettingsCached.mockResolvedValue({ enabled: false, clickTrackingEnabled: false })
})

describe('withdrawal route', () => {
  it('erases even when the whole module is switched off', async () => {
    // The finding: an `enabled` guard here meant switching the feed off kept
    // the stored click ids and ignored every withdrawal until retention expired.
    const response = await POST(requestFor({ attribution: ATTRIBUTION_ID, marketing: false }))
    expect(response.status).toBe(204)
    expect(forgetAttribution).toHaveBeenCalledWith(ATTRIBUTION_ID)
    expect(response.cookies.get(ATTRIBUTION_COOKIE)?.value).toBe('')
  })

  it('does not read the settings at all', async () => {
    await POST(requestFor({ attribution: ATTRIBUTION_ID, marketing: false }))
    // Stronger than checking the outcome: a future gate on ANY setting - the
    // master switch, the tracking switch, one nobody has invented yet - fails
    // here rather than shipping as a quiet refusal.
    expect(getGsfSettingsCached).not.toHaveBeenCalled()
  })

  it('does nothing while consent is still granted', async () => {
    const response = await POST(requestFor({ attribution: ATTRIBUTION_ID, marketing: true }))
    expect(response.status).toBe(204)
    expect(forgetAttribution).not.toHaveBeenCalled()
    expect(response.cookies.get(ATTRIBUTION_COOKIE)).toBeUndefined()
  })

  it('will not erase on an attribution id with no consent cookie behind it', async () => {
    const response = await POST(requestFor({ attribution: ATTRIBUTION_ID }))
    expect(response.status).toBe(204)
    expect(forgetAttribution).not.toHaveBeenCalled()
  })

  it('does nothing without an attribution cookie', async () => {
    const response = await POST(requestFor({ marketing: false }))
    expect(response.status).toBe(204)
    expect(forgetAttribution).not.toHaveBeenCalled()
  })

  it('puts the brake on before it writes', async () => {
    claimBeaconSlot.mockResolvedValue(false)
    const response = await POST(requestFor({ attribution: ATTRIBUTION_ID, marketing: false }))
    expect(response.status).toBe(204)
    expect(forgetAttribution).not.toHaveBeenCalled()
  })

  it('ignores a crawler', async () => {
    const response = await POST(requestFor({
      attribution: ATTRIBUTION_ID, marketing: false, agent: 'Mozilla/5.0 (compatible; Googlebot/2.1)',
    }))
    expect(response.status).toBe(204)
    expect(forgetAttribution).not.toHaveBeenCalled()
  })
})
