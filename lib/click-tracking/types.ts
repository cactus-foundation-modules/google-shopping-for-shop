// Shared shapes and constants for live click tracking.
//
// Pure: no imports with a runtime of their own, so the feed, the beacon script,
// the public routes and the Reports tab all read the same strings without any
// of them dragging the others into a bundle it has no business being in.

/** The campaign tag this module adds to a feed link. Google's free listings
 *  carry no identifier of their own, so a tag we put there ourselves is the
 *  only way to tell a free Shopping click from any other visit. */
export const FREE_LISTING_TAG = {
  utm_source: 'google',
  utm_medium: 'free_listing',
  utm_campaign: 'shopping',
} as const

/** The same address for paid traffic. Google publishes `ads_redirect` beside
 *  `link` and sends ad clicks to it, so the only difference is the medium. */
export const ADS_MEDIUM = 'cpc'

/** Google's own click identifiers, in the order they are looked for.
 *
 *  gclid   the ordinary Google Ads click
 *  gbraid  an app or web-to-app journey, iOS privacy-safe
 *  wbraid  the web half of the same pair
 *  srsltid free Shopping surfaces, added by Google to OUR link
 *
 *  srsltid is last deliberately: Google appends it to free listing clicks as
 *  well as paid ones, so it is the weakest evidence of the four and must never
 *  outrank a gclid sitting beside it. */
export const CLICK_ID_PARAMS = ['gclid', 'gbraid', 'wbraid', 'srsltid'] as const
export type ClickIdKind = (typeof CLICK_ID_PARAMS)[number]

/** Where a landing came from, as this site counts it. */
export const CLICK_SOURCES = ['free', 'paid'] as const
export type ClickSource = (typeof CLICK_SOURCES)[number]

export function asClickSource(value: unknown): ClickSource {
  return CLICK_SOURCES.includes(value as ClickSource) ? (value as ClickSource) : 'free'
}

/** The longest click identifier this module will store. Google's are well
 *  inside this; the cap is there so a hand-crafted request cannot post a
 *  kilobyte into a TEXT column. */
export const CLICK_ID_MAX = 256

/** How long one landing suppresses another for the same visitor on the same
 *  product. A refresh, a back button and a second look from the same search
 *  are one visit, not three. */
export const DEDUPE_WINDOW_SECONDS = 1_800

/** The name of the first-party cookie that joins a landing to a sale. Set only
 *  for a visitor who has granted marketing consent.
 *
 *  Deliberately NOT declared as a cache-bypass cookie in the manifest: a page
 *  is exactly as shareable with it as without, and taking every visitor who
 *  ever clicked a Google listing out of the page cache for a month would be a
 *  measurable slowdown bought with nothing. */
export const ATTRIBUTION_COOKIE = 'cactus_gsf_attr'

/** How long that cookie lasts. Google's own free-listing reporting works to a
 *  comparable window, and a month is long enough for the furniture-sized
 *  decisions this was built for without becoming a standing record. */
export const ATTRIBUTION_COOKIE_DAYS = 30
