// Whether this request is a person arriving, or a machine having a look.
//
// Pure, and deliberately conservative in one direction only: it is far better
// to drop a real landing than to count a crawler as a shopper. A missed landing
// makes the figures a little low, which the screen already warns they will be;
// a counted crawler makes them wrong in a way nobody can see.
//
// Google's own crawlers are the ones that matter here, because this whole
// feature exists downstream of a feed Google fetches: Storebot-Google reads the
// product pages the feed points at, AdsBot checks landing pages for ads, and
// Googlebot indexes. All three arrive at exactly the addresses a shopper
// arrives at, tags and all, which is precisely why they must be named.

/** A user agent belonging to something that is not a person. The list is not
 *  exhaustive and is not trying to be - the generic markers at the end catch
 *  the great majority of the rest. */
const BOT_AGENT = /(storebot-google|googlebot|adsbot|google-inspectiontool|mediapartners-google|apis-google|feedfetcher|bingbot|adidxbot|duckduckbot|baiduspider|yandex(?:bot|images)|slurp|applebot|petalbot|ahrefsbot|semrushbot|mj12bot|dotbot|screaming frog|gptbot|claudebot|ccbot|perplexitybot|bytespider|amazonbot|headlesschrome|phantomjs|puppeteer|playwright|python-requests|curl\/|wget\/|libwww-perl|okhttp|go-http-client|java\/|axios\/|node-fetch|bot\b|crawler|spider)/i

/** Headers a browser sends when it is fetching a page it has NOT been asked to
 *  show - a link the browser guessed at, or one a search results page told it
 *  to warm up. Counting those as arrivals would inflate every figure here by
 *  however much prefetching the visitor's browser felt like doing. */
export type BeaconRequestHeaders = {
  userAgent: string | null
  purpose: string | null
  secPurpose: string | null
  moz: string | null
  secFetchMode: string | null
  secFetchDest: string | null
}

export type BotVerdict = { ignore: true; reason: 'agent' | 'prefetch' | 'not-a-page' } | { ignore: false }

/**
 * Whether to throw this request away without recording anything.
 *
 * `not-a-page` catches a beacon posted from something that is not a document
 * being looked at - an embed, a worker, a fetch from a script somewhere else.
 * The beacon only ever fires from a top-level page, so anything else reaching
 * here was not sent by the beacon.
 */
export function beaconVerdict(headers: BeaconRequestHeaders): BotVerdict {
  const agent = headers.userAgent ?? ''
  // No user agent at all is not a browser. Every real one sends it, and a
  // request without it is either a script or something stripping headers.
  if (agent.trim() === '') return { ignore: true, reason: 'agent' }
  if (BOT_AGENT.test(agent)) return { ignore: true, reason: 'agent' }

  const prefetch = `${headers.purpose ?? ''} ${headers.secPurpose ?? ''} ${headers.moz ?? ''}`.toLowerCase()
  if (prefetch.includes('prefetch') || prefetch.includes('prerender') || prefetch.includes('preload')) {
    return { ignore: true, reason: 'prefetch' }
  }

  // A fetch() from a page reports mode 'cors' or 'same-origin' and dest
  // 'empty'. Anything claiming to be a document, an iframe or an image is not
  // the beacon. Absent headers pass: not every browser sends them, and
  // refusing on absence would quietly switch the feature off on those.
  const dest = headers.secFetchDest?.trim().toLowerCase()
  if (dest !== undefined && dest !== '' && dest !== 'empty') return { ignore: true, reason: 'not-a-page' }
  const mode = headers.secFetchMode?.trim().toLowerCase()
  if (mode !== undefined && mode !== '' && mode !== 'cors' && mode !== 'same-origin' && mode !== 'no-cors') {
    return { ignore: true, reason: 'not-a-page' }
  }

  return { ignore: false }
}
