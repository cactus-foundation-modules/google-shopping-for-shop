import { describe, it, expect } from 'vitest'
import { beaconVerdict, type BeaconRequestHeaders } from '@/modules/google-shopping-for-shop/lib/click-tracking/bots'

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

function headers(overrides: Partial<BeaconRequestHeaders> = {}): BeaconRequestHeaders {
  return { userAgent: CHROME, purpose: null, secPurpose: null, moz: null, secFetchMode: 'cors', secFetchDest: 'empty', ...overrides }
}

describe('beaconVerdict', () => {
  it('lets an ordinary browser through', () => {
    expect(beaconVerdict(headers())).toEqual({ ignore: false })
  })

  it('refuses the Google crawlers that read the very pages the feed points at', () => {
    for (const agent of [
      'Mozilla/5.0 (compatible; Storebot-Google/1.0)',
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'AdsBot-Google (+http://www.google.com/adsbot.html)',
      'Mozilla/5.0 (compatible; Google-InspectionTool/1.0)',
    ]) {
      expect(beaconVerdict(headers({ userAgent: agent })), agent).toEqual({ ignore: true, reason: 'agent' })
    }
  })

  it('refuses scripts and empty agents', () => {
    for (const agent of ['', '   ', 'curl/8.4.0', 'python-requests/2.31.0', 'node-fetch/1.0', 'HeadlessChrome/120']) {
      expect(beaconVerdict(headers({ userAgent: agent })).ignore, agent).toBe(true)
    }
  })

  it('refuses a prefetch, however the browser spells it', () => {
    expect(beaconVerdict(headers({ purpose: 'prefetch' }))).toEqual({ ignore: true, reason: 'prefetch' })
    expect(beaconVerdict(headers({ secPurpose: 'prefetch;prerender' }))).toEqual({ ignore: true, reason: 'prefetch' })
    expect(beaconVerdict(headers({ moz: 'prefetch' }))).toEqual({ ignore: true, reason: 'prefetch' })
  })

  it('refuses anything that is not a fetch from a page', () => {
    expect(beaconVerdict(headers({ secFetchDest: 'document' }))).toEqual({ ignore: true, reason: 'not-a-page' })
    expect(beaconVerdict(headers({ secFetchDest: 'iframe' }))).toEqual({ ignore: true, reason: 'not-a-page' })
    expect(beaconVerdict(headers({ secFetchMode: 'navigate' }))).toEqual({ ignore: true, reason: 'not-a-page' })
  })

  it('passes a browser that sends no Sec-Fetch headers at all', () => {
    // Refusing on absence would quietly switch the feature off on older
    // browsers rather than filtering anything.
    expect(beaconVerdict(headers({ secFetchDest: null, secFetchMode: null }))).toEqual({ ignore: false })
  })
})
