// Plain module, no 'use client', and it has to stay that way. The server block
// (CustomerReviewsBlock.rsc.tsx) and the browser opt-in (CustomerReviewsOptIn.tsx)
// both need this constant, and a value imported from a 'use client' file into a
// server component is a proxy, not the string: comparing against it is always
// false, which made the survey ask without waiting for the visitor's consent.

/** The cookie category the Customer Reviews survey waits for, where the site's banner carries one. */
export const MARKETING_CATEGORY = 'marketing'

/** The part of the stored cookie banner this module reads. */
export type StoredBanner = { enabled?: boolean; categories?: Array<{ key?: string }> } | null

/**
 * Whether there is a Marketing switch for the visitor to grant.
 *
 * You can only wait for a switch that exists. A banner that is switched off, or
 * one carrying no marketing category, leaves the shopper nothing to grant - so
 * waiting would mean waiting for ever, and the survey would never be offered
 * while appearing to be switched on. Same rule, and the same reasoning, as the
 * Google Tag module's own consent gate.
 */
export function bannerHasMarketingCategory(banner: StoredBanner | undefined): boolean {
  if (banner?.enabled !== true) return false
  return (banner.categories ?? []).some((category) => category?.key === MARKETING_CATEGORY)
}
