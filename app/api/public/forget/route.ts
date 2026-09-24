// POST /api/m/google-shopping-for-shop/public/forget
//
// Somebody has withdrawn their marketing consent. Erase what was only ever held
// because they gave it.
//
// Why this route exists rather than waiting for the next visit. Core deletes
// nothing of ours when a visitor changes their mind, and the two routes beside
// this one only ever hear from a browser that has just arrived from Google or
// just bought something. A visitor who withdraws and then simply leaves would
// otherwise keep a stored click identifier until the retention window ran out,
// which is not what withdrawing means. So the page tells us the moment it
// happens, on core's own `cactus:consent-change` event, whatever page they are
// on and whether or not they ever come back.
//
// It answers a withdrawal whatever the module's settings now say - see the note
// in the body. It erases only on a cookie that is PRESENT and says no. Consent still
// granted, or a banner nobody has answered, or no consent cookie at all: it
// does nothing. That makes the route idempotent and harmless on a duplicate
// event, and it closes the one way a leaked attribution id could do permanent
// damage - see withdrewMarketing in lib/click-tracking/consent.ts for why the
// absence of a cookie is treated as a forgery rather than as a refusal.
//
// Like the two routes beside it, every outcome is the same 204.
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { errorName } from '@/modules/google-shopping-for-shop/lib/click-tracking/beacon-guards'
import { beaconVerdict } from '@/modules/google-shopping-for-shop/lib/click-tracking/bots'
import { withdrewMarketing } from '@/modules/google-shopping-for-shop/lib/click-tracking/consent'
import { claimBeaconSlot, forgetAttribution } from '@/modules/google-shopping-for-shop/lib/click-tracking/store'
import { clearAttributionCookie, readAttributionId, visitorKeys } from '@/modules/google-shopping-for-shop/lib/click-tracking/visitor'

function done(): NextResponse {
  return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store, private' } })
}

export async function POST(request: NextRequest) {
  try {
    // The body is ignored entirely - there is nothing a caller could usefully
    // say here, and the only identifier involved is the httpOnly cookie on the
    // request itself. Nothing is read, so nothing needs capping.
    const verdict = beaconVerdict({
      userAgent: request.headers.get('user-agent'),
      purpose: request.headers.get('purpose'),
      secPurpose: request.headers.get('sec-purpose'),
      moz: request.headers.get('x-moz'),
      secFetchMode: request.headers.get('sec-fetch-mode'),
      secFetchDest: request.headers.get('sec-fetch-dest'),
    })
    if (verdict.ignore) return done()

    // NO SETTINGS CHECK AT ALL, and that is the point of this route rather than
    // an oversight in it.
    //
    // Neither switch is consulted - not "count visits from Google", and not the
    // module's own master switch either. An owner who has since turned either
    // of them off still HOLDS the rows that were written while they were on,
    // and a visitor withdrawing consent is entitled to have those erased
    // whatever the shop has since decided about its feed. Any gate here makes
    // "switch it off" a way to keep the identifiers and to ignore every
    // withdrawal in the meantime, which is the opposite of what a withdrawal
    // means. An earlier version had exactly that bug: the master switch was
    // checked one line above a comment explaining why it must not be.
    //
    // Nothing is lost by dropping the gate. The route still refuses a crawler,
    // still needs an attribution cookie, still needs the consent cookie to be
    // present and say no, and still claims a rate slot before it writes - so on
    // a site that has never used this feature there is nothing to find and
    // nothing to erase, and it costs one cookie read.
    const attributionId = readAttributionId(request)
    if (!attributionId) return done()

    // A WITHDRAWAL, not merely the absence of a yes. An attribution id arriving
    // with no consent cookie beside it is a replayed id rather than a browser -
    // see withdrewMarketing - and this route deletes for good.
    if (!withdrewMarketing(request)) return done()

    const keys = await visitorKeys(request)
    if (!keys) return done()
    if (!await claimBeaconSlot(keys.rateKey)) return done()

    await forgetAttribution(attributionId)

    const response = done()
    clearAttributionCookie(response)
    return response
  } catch (err) {
    // The error's NAME only - see lib/click-tracking/beacon-guards.ts.
    console.error('[google-shopping] consent withdrawal failed:', errorName(err))
    return done()
  }
}
