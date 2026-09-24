// What this module needs on every public page.
//
// Scanned by scripts/generate-module-router.mjs and rendered by core's public
// layout (app/(public)/layout.tsx) - the same seam shop uses to put a shopper's
// VAT preference on the page before the first price is drawn.
//
// One thing: the landing beacon, and only where the owner has switched click
// tracking on. A site that has not gets an empty answer and not a single byte
// on any page.
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { getGsfSettingsCached } from '@/modules/google-shopping-for-shop/lib/settings'
import { BEACON_SCRIPT_ID, beaconScript } from '@/modules/google-shopping-for-shop/lib/click-tracking/beacon-script'

export type PublicHead = {
  jsonLd: object[]
  meta: Array<{ name?: string; property?: string; content: string }>
  links: Array<{ rel: string; href: string; type?: string; title?: string; hrefLang?: string }>
  /** Inline scripts run before the page paints, each with an id of its own. */
  scripts: Array<{ id: string; content: string }>
}

const EMPTY: PublicHead = { jsonLd: [], meta: [], links: [], scripts: [] }

export async function getPublicHead(siteUrl: string): Promise<PublicHead> {
  void siteUrl
  try {
    // The CACHED reader, always. This function runs on every public page
    // render, and the plain one is a raw query with no cache of its own - so
    // reading it here would cost every page view on every install carrying this
    // module an extra round trip to Postgres, whether tracking is on or off.
    // Shop's own head.ts reads getShopConfigCached for exactly this reason.
    const settings = await getGsfSettingsCached()
    // Both switches, because the beacon is part of the feature the tracking
    // switch names and nothing else here turns it on.
    if (!settings.enabled || !settings.clickTrackingEnabled) return EMPTY
    // The shop's own URL style, so the beacon only speaks up on an address that
    // could BE a product page. Cached read, and only reached on a site that has
    // switched tracking on.
    const shop = await getShopConfigCached()
    return {
      ...EMPTY,
      scripts: [{ id: BEACON_SCRIPT_ID, content: beaconScript(shop.productUrlStyle) }],
    }
  } catch (err) {
    // A settings row that cannot be read costs the site a figure, never a page.
    console.error('[google-shopping] public head failed:', err)
    return EMPTY
  }
}
