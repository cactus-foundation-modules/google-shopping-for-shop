// Was this a Google landing, and was it paid for?
//
// Pure string work over the query the browser reported. Shared by the beacon
// script (which uses it to decide whether to say anything at all) and by the
// public route (which never trusts the beacon's answer and works it out again).
import { CLICK_ID_MAX, CLICK_ID_PARAMS, FREE_LISTING_TAG, type ClickIdKind, type ClickSource } from '@/modules/google-shopping-for-shop/lib/click-tracking/types'

export type LandingClassification = {
  source: ClickSource
  /** Google's identifier for the click, where the address carried one. Kept
   *  out of the database entirely unless the visitor has granted marketing
   *  consent - that decision belongs to the route, not here. */
  clickId: string | null
  clickIdKind: ClickIdKind | null
}

/**
 * What this address says about where the visitor came from, or null when it
 * says nothing and there is no landing to record.
 *
 * The rule, in one sentence: any Google click identifier means paid, our own
 * feed tag on its own means free, and anything else is not ours to count.
 *
 * `srsltid` is the exception worth reading twice, and it is a DELIBERATE
 * departure from the written plan rather than something that slipped through.
 * The plan said any Google click identifier means paid. Google appends
 * `srsltid` to free Shopping clicks and to ordinary search results as well as
 * to ads, so following that letter would have moved a large share of free
 * traffic into the paid column and left an owner reading an ad spend they never
 * made. A genuinely paid click always carries `gclid`, `gbraid` or `wbraid`,
 * and those three are classified paid here whatever else is on the address. So
 * `srsltid` on its own is treated as free. Put to the owner and signed off on
 * 2026-09-23; the plan file has been amended to match.
 */
export function classifyLanding(search: string): LandingClassification | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)

  let clickId: string | null = null
  let clickIdKind: ClickIdKind | null = null
  for (const name of CLICK_ID_PARAMS) {
    const raw = params.get(name)?.trim()
    if (!raw) continue
    clickId = raw.slice(0, CLICK_ID_MAX)
    clickIdKind = name
    break
  }

  const tagged = params.get('utm_source')?.trim().toLowerCase() === FREE_LISTING_TAG.utm_source
    && params.get('utm_campaign')?.trim().toLowerCase() === FREE_LISTING_TAG.utm_campaign

  const medium = params.get('utm_medium')?.trim().toLowerCase() ?? ''

  // An ad identifier is the strongest signal there is, and Google adds it to
  // the address our own feed tagged - so it is checked before the tag, not
  // after.
  const paidClickId = clickIdKind !== null && clickIdKind !== 'srsltid'
  if (paidClickId) return { source: 'paid', clickId, clickIdKind }

  if (!tagged && clickIdKind === null) return null

  // Tagged by us. The medium says which of the two addresses Google used; a tag
  // that has been edited, truncated or re-written by something in between falls
  // back to free, which is the answer that cannot over-claim an ad spend.
  if (tagged) return { source: medium === 'cpc' ? 'paid' : 'free', clickId, clickIdKind }

  // srsltid with nothing else: a Google Shopping click, and nothing says it was
  // paid for.
  return { source: 'free', clickId, clickIdKind }
}
