// Deep links from the product editor into Merchant Center's own item pages.
//
// Google publishes no URL contract for its console, only for the API, so the
// whole shape of the address lives in the one function below: when Merchant
// Center next reshuffles its query string, that is the only thing to change.
//
// The offer id is whatever the feed sent as <g:id>, which is the product id of
// the row the listing came from - the variation's hidden child product where a
// product has variations, the product itself where it does not. See feed-data.ts.
import { prisma } from '@/lib/db/prisma'
import { Prisma } from '@prisma/client'
import { getEditorPayload } from '@/modules/shop-variations/lib/variants-service'
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { getProductData } from '@/modules/google-shopping-for-shop/lib/product-data'

const MC_ITEM_URL = 'https://merchantcenter.google.com/mc/items/details'

// Every page of the platform renders in English (app/layout.tsx), so the feed
// only ever has one content language to declare.
const CONTENT_LANGUAGE = 'en'

export type GsfMerchantLink = {
  // The <g:id> the feed publishes for this listing.
  offerId: string
  // What the shopper picks on the storefront, e.g. "1600mm / Oak". Empty on a
  // product with no variations, where the product's own name is the whole story.
  label: string
  url: string
}

export type GsfMerchantLinksView = {
  // Null when no account number has been typed into the settings tab, which is
  // the only reason a link cannot be built.
  merchantId: string | null
  // The feed is switched off shop-wide, so Google is not being told about any of
  // this yet.
  feedOff: boolean
  // This product sits the feed out on purpose.
  excluded: boolean
  links: GsfMerchantLink[]
}

/** The address of one item inside Merchant Center. */
export function merchantCentreItemUrl(opts: { merchantId: string; offerId: string; feedLabel: string | null }): string {
  const params = new URLSearchParams({
    a: opts.merchantId,
    offerId: opts.offerId,
    channel: 'online',
    language: CONTENT_LANGUAGE,
  })
  // Left off when unknown: Merchant Center then asks which feed is meant, which
  // is a far better answer than pointing confidently at the wrong country.
  if (opts.feedLabel) params.set('feedLabel', opts.feedLabel)
  return `${MC_ITEM_URL}?${params.toString()}`
}

/** One link per listing this product puts in the feed: one per enabled variation,
 *  or a single link when the product has no variations. Mirrors the feed's own
 *  rules (feed-data.ts), so a variation the feed skips gets no link here either
 *  - a link to an item Google was never sent is just a dead end with a tick on it. */
export async function getMerchantCentreLinks(productId: string): Promise<GsfMerchantLinksView> {
  const [settings, data, payload] = await Promise.all([
    getGsfSettings(),
    getProductData(productId),
    getEditorPayload(productId),
  ])
  const base = { merchantId: settings.merchantId, feedOff: !settings.enabled, excluded: data.excluded }
  if (data.excluded) return { ...base, links: [] }

  const enabled = (payload?.variants ?? []).filter((v) => v.enabled)

  // The feed skips a variation whose hidden child product is not ACTIVE, so the
  // statuses decide the list rather than the enabled flag alone.
  let offers: Array<{ offerId: string; label: string }>
  if (enabled.length > 0) {
    const active = new Set<string>()
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "shp_products"
      WHERE "id" IN (${Prisma.join(enabled.map((v) => v.childProductId))}) AND "status" = 'ACTIVE'
    `
    for (const row of rows) active.add(row.id)
    offers = enabled
      .filter((v) => active.has(v.childProductId))
      .map((v) => ({ offerId: v.childProductId, label: v.label }))
  } else {
    offers = [{ offerId: productId, label: '' }]
  }

  const merchantId = settings.merchantId
  return {
    ...base,
    links: merchantId
      ? offers.map((offer) => ({ ...offer, url: merchantCentreItemUrl({ merchantId, offerId: offer.offerId, feedLabel: settings.feedLabel }) }))
      : offers.map((offer) => ({ ...offer, url: '' })),
  }
}
