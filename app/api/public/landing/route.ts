// POST /api/m/google-shopping-for-shop/public/landing
//
// A visitor arrived from Google. The beacon on the page says which address it
// is sitting on, and this works out the rest.
//
// A public write route, which is the most dangerous thing in this module, so
// the rules it follows are spelled out rather than implied:
//
//   1. It ALWAYS answers 204 and never says why. Not a 400 on a malformed body,
//      not a 429 when the brake catches somebody, not a 404 on an address that
//      is not a product. Every refusal looks identical from the outside, so no
//      answer this route gives distinguishes a real slug from an invented one,
//      a throttled caller from an accepted one, or a consenting visitor from
//      one who declined.
//
//      What that does NOT claim: the paths do different amounts of work, so a
//      caller measuring response times can tell a real product address from a
//      made-up one. That is a fact about the sitemap, which publishes every one
//      of them, so nothing is learned here that is not already published.
//   2. It believes NOTHING it is told beyond the address. The product is
//      resolved server-side against the shop's own lookups, the free-or-paid
//      decision is made here from the query string, the visitor's keys are
//      derived from the request, and the consent answer is read from the
//      cookie. There is no field in the body that decides what gets stored.
//   3. The body is refused on its declared length BEFORE it is read, so a large
//      payload is never pulled into memory at all, and capped again on what
//      actually arrived for a caller that declared nothing.
//   4. Nothing personal is logged. The only thing written down is a keyed hash
//      that rotates daily and cannot be turned back into an address.
//   5. The brake is a row in the database, not a counter in this process. Every
//      serverless invocation is its own process; an in-memory guard here would
//      release itself on the next cold start.
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { errorName, tooLarge } from '@/modules/google-shopping-for-shop/lib/click-tracking/beacon-guards'
import { getGsfSettingsCached } from '@/modules/google-shopping-for-shop/lib/settings'
import { beaconVerdict } from '@/modules/google-shopping-for-shop/lib/click-tracking/bots'
import { classifyLanding } from '@/modules/google-shopping-for-shop/lib/click-tracking/classify'
import { mayAttribute, withdrewMarketing } from '@/modules/google-shopping-for-shop/lib/click-tracking/consent'
import { resolveLandedProduct } from '@/modules/google-shopping-for-shop/lib/click-tracking/resolve'
import { claimBeaconSlot, forgetAttribution, recordLanding } from '@/modules/google-shopping-for-shop/lib/click-tracking/store'
import {
  clearAttributionCookie,
  mintAttributionId,
  readAttributionId,
  setAttributionCookie,
  visitorKeys,
} from '@/modules/google-shopping-for-shop/lib/click-tracking/visitor'

/** Everything the beacon sends fits in a few hundred bytes. Anything past this
 *  is not our script talking. */
const BODY_MAX = 4_096

const Body = z.object({
  path: z.string().max(512),
  search: z.string().max(1_000),
})

/** The one answer this route ever gives. Never cached, by anything: it is a
 *  write, and on a consenting visitor it carries a Set-Cookie. */
function done(): NextResponse {
  return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store, private' } })
}

export async function POST(request: NextRequest) {
  try {
    // Crawlers and prefetches FIRST, ahead of everything including the settings
    // read: they are decided on headers alone, they cost nothing, and they are
    // the most common thing to arrive at an address Google itself published.
    const verdict = beaconVerdict({
      userAgent: request.headers.get('user-agent'),
      purpose: request.headers.get('purpose'),
      secPurpose: request.headers.get('sec-purpose'),
      moz: request.headers.get('x-moz'),
      secFetchMode: request.headers.get('sec-fetch-mode'),
      secFetchDest: request.headers.get('sec-fetch-dest'),
    })
    if (verdict.ignore) return done()

    // The CACHED reader: this runs before the rate limiter can refuse anybody,
    // so a flood would otherwise buy itself one database round trip per request
    // whatever the brake then said.
    const settings = await getGsfSettingsCached()
    if (!settings.enabled || !settings.clickTrackingEnabled) return done()

    // Refused on the declared length first: awaiting the text and measuring it
    // afterwards means the allocation has already happened, which is the one
    // thing a size cap exists to prevent. Content-Length is absent on a chunked
    // request, so the check on what actually arrived stays as the backstop.
    if (tooLarge(request.headers.get('content-length'), BODY_MAX)) return done()
    const raw = await request.text()
    if (raw.length > BODY_MAX) return done()
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return done()
    }
    const body = Body.safeParse(parsed)
    if (!body.success) return done()

    const landing = classifyLanding(body.data.search)
    if (!landing) return done()

    const keys = await visitorKeys(request)
    // No ENCRYPTION_KEY means no honest way to tell two visitors apart, and a
    // constant standing in for one would put the whole site in a single dedupe
    // bucket. Recording nothing is the truthful answer.
    if (!keys) return done()
    if (!await claimBeaconSlot(keys.rateKey)) return done()

    const landed = await resolveLandedProduct(body.data.path, body.data.search)
    if (!landed) return done()

    // The one decision the visitor makes for themselves. Granted, this landing
    // can be joined to whatever they buy in the next thirty days; refused or
    // unanswered, it is counted with nothing attached to it at all.
    const consented = mayAttribute(request)
    const existing = readAttributionId(request)
    const attributionId = consented ? existing ?? mintAttributionId() : null

    await recordLanding({
      productId: landed.productId,
      variantId: landed.variantId,
      source: landing.source,
      // Never stored without consent - it is the one field that could be handed
      // back to Google to identify the person.
      clickId: consented ? landing.clickId : null,
      clickIdKind: consented ? landing.clickIdKind : null,
      sessionKey: keys.sessionKey,
      attributionId,
      consented,
    })

    const response = done()
    if (consented && attributionId) {
      // Re-set on every landing, deduped or not: the expiry rolls forward and
      // the newest landing is the one a later sale is credited to, which is
      // what "last click wins" means.
      setAttributionCookie(response, attributionId)
    } else if (existing) {
      // They had agreed and have since said no. The landing still counts; the
      // thread back to their next order is cut, and everything held about the
      // earlier ones only because they agreed is erased here and now.
      //
      // The page normally beats us to this - it posts to /forget the moment the
      // banner changes - but a visitor who withdrew in another tab, or whose
      // script never ran, reaches it here instead. Both paths do the same thing
      // and doing it twice costs one no-op.
      // Erased only on a real withdrawal - cookie present, saying no. See the
      // note in the conversion route: the cookie is cut either way, but nothing
      // is destroyed on the strength of an attribution id alone.
      if (withdrewMarketing(request)) await forgetAttribution(existing)
      clearAttributionCookie(response)
    }
    return response
  } catch (err) {
    // A landing is a figure on a report. Nothing here is worth a 500 reaching a
    // shopper's browser.
    //
    // The ERROR'S NAME ONLY, never the object. A failing raw query can echo the
    // parameters it was given back in its message, and the parameters here
    // include a click identifier and an attribution id - the two fields in this
    // whole feature that are only held with the visitor's permission. A server
    // log is not where they were given permission to go.
    console.error('[google-shopping] landing beacon failed:', errorName(err))
    return done()
  }
}
