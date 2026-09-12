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

/** The codes a row carries in the shop's own columns. Separate from the typed-in
 *  Google fields because these are the shop's, kept for its own reasons, and
 *  only borrowed here. */
export type RowCodes = {
  /** shp_products.barcode - the GTIN, where the shop holds one. */
  barcode: string | null
  /** shp_products.sku - the code this row is ordered by. Published as the MPN
   *  only when the owner has said it is the maker's code and not their own. */
  sku: string | null
}

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
 * variation may not claim its parent's GTIN or typed-in MPN - a code identifies
 * one particular part, and handing the same one to forty colourways would claim
 * they are all the same part.
 *
 * What a variation MAY claim is its own. `mpnFromSku` publishes the code on the
 * row itself: the child's for a variation, the product's for a listing with no
 * variations. That is the point of the setting - on a catalogue bought in, the
 * product code IS the manufacturer's part number, it is what every other
 * retailer publishes, and it is the only thing Google can match a barcodeless
 * offer against. It stays off by default because on a shop that numbers its own
 * stock the same column is a private buying reference, and only the owner knows
 * which of the two they have. A typed-in MPN still outranks it, on the listings
 * entitled to one.
 */
export function identifiersOf(
  data: Pick<GsfProductData, 'brand' | 'gtin' | 'mpn'>,
  brandFallbacks: { supplier: string | null; defaultBrand: string | null; useSupplier: boolean },
  codes: RowCodes,
  opts: { standalone: boolean; mpnFromSku: boolean },
): { brand?: string; gtin?: string; mpn?: string; identifierExists: boolean } {
  const supplier = brandFallbacks.useSupplier ? brandFallbacks.supplier : null
  const brand = data.brand ?? supplier ?? brandFallbacks.defaultBrand ?? undefined
  const gtin = normaliseGtin(codes.barcode) ?? (opts.standalone ? normaliseGtin(data.gtin) : null) ?? undefined
  const typedMpn = opts.standalone ? data.mpn?.trim() || null : null
  const ownCode = opts.mpnFromSku ? codes.sku?.trim() || null : null
  const mpn = typedMpn ?? ownCode ?? undefined
  return { brand, gtin, mpn, identifierExists: Boolean(gtin || (brand && mpn)) }
}
