'use client'

// ---------------------------------------------------------------------------
// The browser half of Google Customer Reviews.
//
// Google's opt-in is a script of theirs plus a payload of ours, and the order
// of the two is load-bearing: their script takes `?onload=renderOptIn`, so the
// global function it names has to exist BEFORE the script is fetched, or the
// callback fires against nothing and the dialog never appears.
//
// The payload is not in the page. It carries the customer's email address, so
// it is fetched from this module's own endpoint using the order's signed
// receipt token - the same proof the confirmation page uses for the order
// itself. Somebody opening the confirmation URL without the token sees no
// dialog, which is the right answer: it is not their order.
//
// Nothing is drawn here. The dialog is Google's, rendered into their own
// element, and this component's whole job is to decide whether it may appear
// and to hand it what it needs.
// ---------------------------------------------------------------------------

import { useEffect } from 'react'
import { CONSENT_CHANGE_EVENT, hasConsent } from '@/lib/consent/gate'
import type { GsfOptInStyle } from '@/modules/google-shopping-for-shop/lib/types'

/** The cookie category this waits for, where the site's banner carries one. */
export const MARKETING_CATEGORY = 'marketing'

const SCRIPT_SRC = 'https://apis.google.com/js/platform.js?onload=renderOptIn'

export type OptInPayload = {
  merchantId: number
  orderId: string
  email: string
  deliveryCountry: string
  estimatedDeliveryDate: string
  optInStyle: GsfOptInStyle
  gtins: string[]
}

type SurveyOptIn = { render: (config: Record<string, unknown>) => void }
type Gapi = { load: (name: string, cb: () => void) => void; surveyoptin?: SurveyOptIn }

type OptInWindow = {
  gapi?: Gapi
  renderOptIn?: () => void
  /** Held by whichever copy of the block got there first. Two copies would ask
   *  Google to render two dialogs over one order. */
  __cactusGcrRendered?: boolean
}

function optInWindow(): OptInWindow {
  return window as unknown as OptInWindow
}

function renderDialog(payload: OptInPayload): void {
  const w = optInWindow()
  if (w.__cactusGcrRendered) return
  w.__cactusGcrRendered = true

  const config: Record<string, unknown> = {
    merchant_id: payload.merchantId,
    order_id: payload.orderId,
    email: payload.email,
    delivery_country: payload.deliveryCountry,
    estimated_delivery_date: payload.estimatedDeliveryDate,
    opt_in_style: payload.optInStyle,
  }
  // Optional, and only sent when the shop actually knows the barcodes: it is
  // what lets a survey answer become a review of the product rather than only a
  // rating of the shop.
  if (payload.gtins.length > 0) config.products = payload.gtins.map((gtin) => ({ gtin }))

  const start = () => w.gapi?.load('surveyoptin', () => w.gapi?.surveyoptin?.render(config))
  // The callback their script calls once it has loaded. Defined before the
  // script is appended, deliberately - see the note at the top.
  w.renderOptIn = start
  if (w.gapi) {
    // Already on the page (a soft navigation back onto a confirmation), so
    // their onload has been and gone and nothing will call us.
    start()
    return
  }
  const script = document.createElement('script')
  script.src = SCRIPT_SRC
  script.async = true
  script.defer = true
  document.body.appendChild(script)
}

/** Whether this visitor has said yes to what the dialog amounts to. A site with
 *  no marketing category in its banner has asked nobody, so there is no answer
 *  to wait for - see the same reasoning in the Google Tag module. */
function allowedNow(gated: boolean): boolean {
  return !gated || hasConsent(MARKETING_CATEGORY)
}

export function CustomerReviewsOptIn({ gated }: { gated: boolean }) {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const orderNumber = params.get('orderNumber')
    // No token, no opt-in. The older confirmation links carried the customer's
    // email in the URL instead, and this deliberately does not accept that:
    // sending an email address to Google because it was in a query string is
    // exactly the thing the signed token exists to stop.
    const token = params.get('t')
    if (!orderNumber || !token) return

    let cancelled = false
    let payload: OptInPayload | null = null

    const showIfAllowed = () => {
      if (cancelled || !payload) return false
      if (!allowedNow(gated)) return false
      renderDialog(payload)
      return true
    }

    // Listening from the start rather than after the fetch: a visitor who
    // accepts the banner while the request is in flight would otherwise never
    // be asked, and they have just said yes.
    const onConsent = () => { showIfAllowed() }
    window.addEventListener(CONSENT_CHANGE_EVENT, onConsent)

    void (async () => {
      try {
        const url = `/api/m/google-shopping-for-shop/public/customer-reviews?orderNumber=${encodeURIComponent(orderNumber)}&t=${encodeURIComponent(token)}`
        const res = await fetch(url)
        if (!res.ok) return
        const body = (await res.json()) as { optIn: OptInPayload | null }
        if (cancelled || !body.optIn) return
        payload = body.optIn
        showIfAllowed()
      } catch {
        // A survey invitation is the least important thing on this page. The
        // customer's receipt is what matters, and it is already drawn.
      }
    })()

    return () => {
      cancelled = true
      window.removeEventListener(CONSENT_CHANGE_EVENT, onConsent)
    }
  }, [gated])

  return null
}
