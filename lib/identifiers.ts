// Who made the thing, and how anybody else would name it: brand, GTIN and MPN,
// resolved once for everything that publishes them.
//
// Kept in a file of its own, importing nothing but the two pure ones, because
// two things now need it and they cannot both reach feed-data.ts. The product
// feed builds its rows there; shop's product page asks through the
// `shop.product-merchant-facts` point, and feed-data.ts pulls in
// delivery-timing.ts, which reaches the generated extension-point registry - so
// a provider IN that registry importing feed-data.ts closes an import cycle that
// Turbopack can fail a production build on while every local check stays green
// (scripts/check-import-cycles.mjs, which is what caught this).
//
// One implementation and not two on purpose: Merchant Center reading the feed
// and a shopping assistant reading the page must never be told two different
// makers for the same product.
import { normaliseGtin } from '@/modules/google-shopping-for-shop/lib/feed-xml'
import type { GsfProductData } from '@/modules/google-shopping-for-shop/lib/types'

/**
 * The three identifying attributes, plus whether they add up to something a
 * shopping channel will accept as an identity at all.
 *
 * Brand runs per-product override, then the supplier the shop files the product
 * under (when the setting allows), then the shop-wide default. The supplier is
 * the nearest thing the shop already knows to a maker's name, so a catalogue
 * filed by supplier needs no per-product brand typed in at all. On a variation
 * it is the CHILD row's supplier first: an import fills the supplier in on the
 * rows it creates, which are the children, and a parent assembled by hand in the
 * admin often has the column left blank. The parent only stands in behind it.
 *
 * `standalone` is what separates a listing from one of its combinations. A
 * variation may not claim its parent's GTIN or MPN - a code identifies one
 * particular part, and handing the same one to forty colourways would claim they
 * are all the same part. SKUs are deliberately never used: the shop withholds
 * its buying codes from shoppers, so nothing that publishes may use them either.
 */
export function identifiersOf(
  data: Pick<GsfProductData, 'brand' | 'gtin' | 'mpn'>,
  brandFallbacks: { supplier: string | null; defaultBrand: string | null; useSupplier: boolean },
  barcode: string | null,
  opts: { standalone: boolean },
): { brand?: string; gtin?: string; mpn?: string; identifierExists: boolean } {
  const supplier = brandFallbacks.useSupplier ? brandFallbacks.supplier : null
  const brand = data.brand ?? supplier ?? brandFallbacks.defaultBrand ?? undefined
  const gtin = normaliseGtin(barcode) ?? (opts.standalone ? normaliseGtin(data.gtin) : null) ?? undefined
  const mpn = opts.standalone ? data.mpn ?? undefined : undefined
  return { brand, gtin, mpn, identifierExists: Boolean(gtin || (brand && mpn)) }
}
