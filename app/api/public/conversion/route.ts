// POST /api/m/google-shopping-for-shop/public/conversion
//
// The shop has just told the page that a sale happened. If this browser is
// carrying an attribution cookie, join the order to the landing that led to it.
//
// The security shape, which is the whole of this file:
//
//   * The ONLY thing taken from the body is an order number, and an order
//     number proves nothing - they are a prefix and a sequence, so guessing
//     the next one is arithmetic. It is used to look the order up and for
//     nothing else.
//   * The browser is then made to prove the order is its own, through the
//     shop's own rule (`mayOpenReceipt`): it either holds the receipt grant
//     written at the till, or it is signed in as the member who placed it, or
//     it has already answered the delivery postcode challenge. Nothing else
//     gets in.
//   * The attribution id is read from this request's own httpOnly cookie and is
//     NEVER accepted from the body. There is no way to ask this route about
//     somebody else's attribution, and no answer it gives reveals one.
//   * Consent is checked HERE as well as on the landing, and that is not
//     belt-and-braces - it is the only check that matters at the moment the
//     link is actually made. Core deletes nothing of ours when somebody
//     withdraws, and the landing route can only clear the cookie on a LATER
//     tagged landing, which a withdrawing visitor usually never makes. Without
//     this test the sequence "agree, arrive from Google, withdraw, buy" would
//     still write the join, off the back of a cookie the visitor has since
//     said no to.
//   * The money is read from the shop's own order row. Nothing the browser
//     posts contributes a figure.
//   * Like the landing beacon beside it, every outcome is the same 204.
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { errorName, tooLarge } from '@/modules/google-shopping-for-shop/lib/click-tracking/beacon-guards'
import { getOrderByNumber } from '@/modules/shop/lib/db/orders'
import { mayOpenReceipt } from '@/modules/shop/lib/order-viewer'
import { getGsfSettingsCached } from '@/modules/google-shopping-for-shop/lib/settings'
import { beaconVerdict } from '@/modules/google-shopping-for-shop/lib/click-tracking/bots'
import { attributeOrder, claimBeaconSlot, forgetAttribution, lastClickFor } from '@/modules/google-shopping-for-shop/lib/click-tracking/store'
import { mayAttribute, withdrewMarketing } from '@/modules/google-shopping-for-shop/lib/click-tracking/consent'
import { clearAttributionCookie, readAttributionId, visitorKeys } from '@/modules/google-shopping-for-shop/lib/click-tracking/visitor'

const BODY_MAX = 1_024

const Body = z.object({
  orderNumber: z.string().trim().min(1).max(64),
})

function done(): NextResponse {
  return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store, private' } })
}

export async function POST(request: NextRequest) {
  try {
    // Headers first, for the same reason as the landing route beside this one.
    const verdict = beaconVerdict({
      userAgent: request.headers.get('user-agent'),
      purpose: request.headers.get('purpose'),
      secPurpose: request.headers.get('sec-purpose'),
      moz: request.headers.get('x-moz'),
      secFetchMode: request.headers.get('sec-fetch-mode'),
      secFetchDest: request.headers.get('sec-fetch-dest'),
    })
    if (verdict.ignore) return done()

    // The CACHED reader - see the landing route.
    const settings = await getGsfSettingsCached()
    if (!settings.enabled || !settings.clickTrackingEnabled) return done()

    // Nothing to join to. Checked before the order is looked up, so a browser
    // with no cookie cannot use this route to ask questions about orders at
    // all - it never reaches the lookup.
    const attributionId = readAttributionId(request)
    if (!attributionId) return done()

    // The brake goes on HERE, before either branch below, and not further down.
    // Both of them write: one joins a sale, the other erases. An attribution id
    // is 22 characters of our own alphabet and nothing stops a caller inventing
    // one, so leaving the erase outside the brake would be an unmetered pair of
    // writes per request for anybody who could be bothered to send them.
    const keys = await visitorKeys(request)
    if (!keys) return done()
    if (!await claimBeaconSlot(keys.rateKey)) return done()

    // Still a yes? The cookie says what they agreed to when they arrived; this
    // says what they agree to now, and now is when the join would be written.
    // A withdrawal cuts the thread on the FIRST request after it, rather than
    // waiting for a tagged landing that may never come.
    if (!mayAttribute(request)) {
      // Two different questions, deliberately answered with two different
      // tests. NOT joining the sale is decided by mayAttribute, which denies on
      // anything short of an explicit yes - that is the consent gate and it
      // stays as strict as it is. ERASING is decided by withdrewMarketing,
      // which needs the consent cookie to be there and to say no: erasure
      // deletes a revenue line for good, and a request carrying an attribution
      // id with no consent cookie at all is a replayed id rather than a
      // browser. The cookie is cleared either way, so an unanswered banner
      // still cuts the thread; it simply does not destroy anything.
      if (withdrewMarketing(request)) await forgetAttribution(attributionId)
      const refused = done()
      clearAttributionCookie(refused)
      return refused
    }

    // Declared length first, then what actually arrived - see the note on the
    // landing route beside this one.
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

    const order = await getOrderByNumber(body.data.orderNumber)
    if (!order) return done()
    // The shop's own rule, not a copy of it. Whatever opens the receipt opens
    // this; anything else is somebody holding an order number.
    if (!await mayOpenReceipt(request, order)) return done()

    const click = await lastClickFor(attributionId)
    if (!click) return done()

    // Confirmed here only where the shop itself already says the money is in.
    // `shop.order-paid` fires exactly once per order and is what confirms the
    // rest - a bank transfer cleared days later, say. Either may be first, so
    // neither assumes it was.
    const confirmed = order.paymentStatus === 'PAID'
      ? { at: new Date(), value: order.total, currency: order.currency }
      : null

    await attributeOrder({
      orderId: order.id,
      orderNumber: order.orderNumber,
      clickEventId: click.id,
      landedAt: click.landedAt,
      confirmed,
    })
    return done()
  } catch (err) {
    // The error's NAME only. A failing raw query can echo its parameters, and
    // one of them is this visitor's attribution id.
    console.error('[google-shopping] conversion beacon failed:', errorName(err))
    return done()
  }
}
