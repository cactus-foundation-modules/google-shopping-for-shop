import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { mayAttribute, readConsentDecision, withdrewMarketing } from '@/modules/google-shopping-for-shop/lib/click-tracking/consent'

/** Core's cookie, as it actually writes it: URL-encoded JSON with a `decision`
 *  map inside. `raw` is for the shapes a browser would never send. */
function requestWith(decision?: Record<string, boolean>, raw?: string): NextRequest {
  const value = raw ?? (decision === undefined ? undefined : encodeURIComponent(JSON.stringify({ decision })))
  return new NextRequest('https://example.test/', {
    headers: value === undefined ? {} : { cookie: `cactus-consent=${value}` },
  })
}

describe('mayAttribute', () => {
  it('needs an explicit yes', () => {
    expect(mayAttribute(requestWith({ marketing: true }))).toBe(true)
    expect(mayAttribute(requestWith({ marketing: false }))).toBe(false)
    // Never answered the banner. Denies, exactly as a refusal does.
    expect(mayAttribute(requestWith({ analytics: true }))).toBe(false)
    expect(mayAttribute(requestWith())).toBe(false)
  })

  it('denies anything it cannot read rather than guessing', () => {
    expect(mayAttribute(requestWith(undefined, 'not-json'))).toBe(false)
    expect(mayAttribute(requestWith(undefined, encodeURIComponent('{"decision":"yes"}')))).toBe(false)
    expect(mayAttribute(requestWith(undefined, encodeURIComponent('[]')))).toBe(false)
  })
})

describe('withdrewMarketing', () => {
  it('is true only for a cookie that is present and says no', () => {
    expect(withdrewMarketing(requestWith({ marketing: false }))).toBe(true)
  })

  it('is false for a yes, and for a banner nobody has answered', () => {
    expect(withdrewMarketing(requestWith({ marketing: true }))).toBe(false)
    expect(withdrewMarketing(requestWith({ analytics: true }))).toBe(false)
  })

  it('is false when there is NO consent cookie at all', () => {
    // The hardening. Core writes its consent cookie before it announces the
    // change, and that cookie outlives the attribution one by a year - so an
    // attribution id arriving with no consent cookie beside it is a replayed
    // id, not a browser, and erasing on it would delete a stranger's data for
    // good.
    expect(withdrewMarketing(requestWith())).toBe(false)
    expect(withdrewMarketing(requestWith(undefined, 'not-json'))).toBe(false)
  })

  it('is not the inverse of mayAttribute, and must not be written as one', () => {
    const unanswered = requestWith({ analytics: true })
    expect(mayAttribute(unanswered)).toBe(false)
    expect(withdrewMarketing(unanswered)).toBe(false)
  })
})

describe('readConsentDecision', () => {
  it('hands back the map, or null when there is nothing readable', () => {
    expect(readConsentDecision(requestWith({ marketing: true, analytics: false }))).toEqual({ marketing: true, analytics: false })
    expect(readConsentDecision(requestWith())).toBeNull()
    expect(readConsentDecision(requestWith(undefined, '%%%'))).toBeNull()
  })
})
