// The server's own reading of the shopper's consent.
//
// Copied in shape from modules/abandoned-carts-for-shop/lib/consent.ts, because
// core publishes no shared server-side helper for this and two modules reading
// the same cookie by hand is better than one of them reading a helper that does
// not exist. The cookie is READ, never written; only its `decision` map is
// looked at; anything unreadable denies.
//
// What turns on the answer here, and nothing else does:
//
//   granted  the click identifier is stored, and a first-party cookie joins
//            this landing to whatever the visitor buys in the next 30 days.
//   refused  the landing is still counted - which product, when, free or paid -
//            with no identifier of any kind attached to it.
//
// So a refusal costs the owner the sale attribution and costs them nothing
// else. That asymmetry is deliberate: it makes the honest answer the cheap one.
import type { NextRequest } from 'next/server'

const CONSENT_COOKIE = 'cactus-consent'

/** Core's own category key for advertising and measurement, the same string
 *  abandoned carts asks about. Declared in this module's manifest too, so the
 *  banner offers it whichever of the two is installed. */
export const MARKETING_CATEGORY = 'marketing'

type ConsentPayload = { decision?: Record<string, boolean> } | null

export function readConsentDecision(request: NextRequest): Record<string, boolean> | null {
  const raw = request.cookies.get(CONSENT_COOKIE)?.value
  if (!raw) return null
  try {
    const payload = JSON.parse(decodeURIComponent(raw)) as ConsentPayload
    if (!payload || typeof payload !== 'object' || !payload.decision) return null
    return payload.decision
  } catch {
    return null
  }
}

/**
 * Has this visitor actually WITHDRAWN, as against never having answered?
 *
 * The difference matters because withdrawal now erases: it deletes the stored
 * Google click identifier and, with it, the sale-to-click joins behind a line
 * of revenue. That is not recoverable, so the bar for triggering it is higher
 * than the bar for simply declining to write anything new.
 *
 * `mayAttribute` below treats "no answer" and "no" identically, which is the
 * right way round for deciding whether to RECORD. Here it is the wrong way
 * round. Core writes its consent cookie before it dispatches the change event,
 * and that cookie lives a year against the attribution cookie's thirty days -
 * so a request carrying an attribution id and NO consent cookie at all is not
 * a shape a real browser produces. It is what somebody replaying a leaked
 * attribution id looks like, and honouring it would let them delete a
 * stranger's attribution for good.
 *
 * So: the cookie has to be there, and it has to say no.
 *
 * Worth saying why this does NOT follow abandoned carts, whose own forget path
 * is deliberately undefended. That one is a person asking, once, to be
 * forgotten, and making them prove it would be the wrong instinct entirely.
 * Ours fires automatically off a browser event, against rows the shop is
 * counting on, so the reasoning does not carry across.
 */
export function withdrewMarketing(request: NextRequest): boolean {
  const decision = readConsentDecision(request)
  return decision !== null && decision[MARKETING_CATEGORY] === false
}

/**
 * May this visit be linked to a later sale?
 *
 * Only on an explicit yes. Somebody who has not answered the banner yet counts
 * as no, exactly as a refusal does - which is the same rule abandoned carts
 * follows, and the right way round for a cookie that lasts a month.
 */
export function mayAttribute(request: NextRequest): boolean {
  return readConsentDecision(request)?.[MARKETING_CATEGORY] === true
}
