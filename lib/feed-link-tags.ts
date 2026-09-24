// The campaign tags on a feed item's link.
//
// Google's free Shopping listings arrive with nothing on the address to say
// where they came from. Ads arrive with a `gclid`, so they can always be told
// apart; a free click looks exactly like somebody typing the address in. So the
// feed tags its own links, and the tag is the only thing that makes a free
// Shopping click countable at all.
//
// Two addresses, because Google publishes two. `link` is where a free listing
// sends people; `ads_redirect`, when present, is where a PAID click goes
// instead. They differ in one parameter, so both are built here rather than in
// two places that could drift.
//
// Pure string work, on purpose, and the reason is narrower than it might read.
// It is about the ENCODING of the option parameters, not about the tag.
//
// Every variation link already carries a query string - the option parameters
// the canonical tag names - spelled by shop-variations with its own escaping.
// Parsing that into a URL object and writing it back out would re-encode it,
// and the OPTION part of the address would stop being character-for-character
// what the sitemap and the canonical tag say, which is the one thing a shopping
// feed must not do.
//
// The tag itself is a different matter and is expected to differ: adding
// utm parameters does not make the address a different page, the canonical tag
// on it still names the untagged address, and Google is being told about the
// tagged one deliberately.
import { ADS_MEDIUM, FREE_LISTING_TAG } from '@/modules/google-shopping-for-shop/lib/click-tracking/types'

/** The tag as a query fragment, with the medium left to the caller. */
function tagFor(medium: string): string {
  return `utm_source=${FREE_LISTING_TAG.utm_source}&utm_medium=${medium}&utm_campaign=${FREE_LISTING_TAG.utm_campaign}`
}

/** True when this address already carries our tag - a link built by an older
 *  version, or one an owner has typed in by hand. */
export function alreadyTagged(url: string): boolean {
  return /[?&]utm_source=google(&|$|#)/i.test(url) && /[?&]utm_campaign=shopping(&|$|#)/i.test(url)
}

/**
 * The address with our tag on it at the given medium.
 *
 * The medium is SET, never merely added, and that is the whole reason this is
 * one function rather than two. An address that already carries our tag - from
 * an older version of this module, or typed in by hand - would otherwise come
 * back from both callers unchanged, and `link` and `ads_redirect` would be
 * character-for-character identical. Every paid click on that item would then
 * arrive wearing whatever medium happened to be written there, and the whole
 * free-against-paid split would be wrong for exactly the products somebody had
 * taken the trouble to tag themselves.
 *
 * The hash is moved out of the way first: `/a-desk#spec?utm_source=...` is not a
 * query at all.
 */
function withTag(url: string, medium: string): string {
  const hashAt = url.indexOf('#')
  const hash = hashAt === -1 ? '' : url.slice(hashAt)
  const base = hashAt === -1 ? url : url.slice(0, hashAt)

  if (!alreadyTagged(base)) {
    const separator = base.includes('?') ? '&' : '?'
    return `${base}${separator}${tagFor(medium)}${hash}`
  }
  // Ours already. Rewrite the medium in place - keeping the rest of the address
  // exactly as it was, because it may be carrying an option query that the
  // canonical tag and the sitemap agree on.
  if (/[?&]utm_medium=/i.test(base)) {
    return `${base.replace(/([?&]utm_medium=)[^&]*/i, `$1${medium}`)}${hash}`
  }
  const separator = base.includes('?') ? '&' : '?'
  return `${base}${separator}utm_medium=${medium}${hash}`
}

/** The address a FREE listing sends a shopper to. */
export function taggedLink(url: string): string {
  return withTag(url, FREE_LISTING_TAG.utm_medium)
}

/** The address a PAID click sends a shopper to, for `ads_redirect`. The same
 *  page, differing only in the medium, so an ad and a free listing are told
 *  apart without either being sent somewhere else. */
export function adsRedirectLink(url: string): string {
  return withTag(url, ADS_MEDIUM)
}
