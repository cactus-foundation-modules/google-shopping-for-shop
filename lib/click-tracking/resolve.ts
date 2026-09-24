// Which product the visitor actually landed on.
//
// The beacon reports the address it is sitting on and nothing else. It does not
// report a product id, and it is never asked to: a browser is not a source of
// truth about which row in the database it is looking at, and a route that
// took one would be a route anybody could post whatever they liked to.
//
// So the address is resolved here, against the shop's own lookups and
// shop-variations' own selection logic - the SAME derivation the product page
// runs to decide what it is showing. Anything that does not resolve to a live
// product page is not a landing and nothing is recorded.
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { getProductBySlug } from '@/modules/shop/lib/db/products'
import { getVariantSelectorPayload, resolveVariantDeepLink } from '@/modules/shop-variations/lib/variants-service'
import { selectionValueIdsFromParams } from '@/modules/shop-variations/lib/url-selection'
import { resolveVariant, valueToOptionMap, withAutoSelected, withStrandedFilled, type OptionSelection } from '@/modules/shop-variations/lib/selection-logic'

export type LandedProduct = {
  /** Always the parent listing, so a shop's figures are per listing however
   *  many combinations sit under it. */
  productId: string
  /** The one combination the address named, where it named one. */
  variantId: string | null
}

/**
 * The product slug in this path, or null when the path is not a product page
 * address at all.
 *
 * Pure, and exported for its own test: the two URL styles are the shop's own
 * setting, and getting this wrong would quietly record nothing on half the
 * installs there are.
 */
export function productSlugFromPath(path: string, style: 'ROOT' | 'SHOP'): string | null {
  // Query and fragment are the caller's business, not this function's.
  const clean = path.split('?')[0]?.split('#')[0] ?? ''
  const trimmed = clean.replace(/\/+$/, '')
  if (style === 'ROOT') {
    const match = /^\/([^/]+)$/.exec(trimmed)
    return match?.[1] ? decodeSlug(match[1]) : null
  }
  const match = /^\/shop\/products\/([^/]+)$/.exec(trimmed)
  return match?.[1] ? decodeSlug(match[1]) : null
}

/** Never throws on a half-escaped path - a malformed one is simply not a slug
 *  anything here has ever published. */
function decodeSlug(raw: string): string | null {
  try {
    const slug = decodeURIComponent(raw).trim()
    // Long enough to be a real slug and short enough that a pasted essay is
    // not sent to the database as a parameter.
    return slug.length > 0 && slug.length <= 200 ? slug : null
  } catch {
    return null
  }
}

/**
 * The listing and, where the address names one, the exact combination.
 *
 * Two shapes of address reach here, because the feed publishes both:
 *
 *   the parent's address with option parameters - what nearly every variation
 *   row links to, because that is the address the canonical tag and the sitemap
 *   agree on;
 *
 *   a variation child's own slug - the fallback the feed uses where a
 *   combination has no address of its own.
 *
 * Both resolve to the same pair. Anything else - an unknown slug, a draft, a
 * category, the home page - resolves to null and is not counted.
 */
export async function resolveLandedProduct(path: string, search: string): Promise<LandedProduct | null> {
  const config = await getShopConfigCached()
  const slug = productSlugFromPath(path, config.productUrlStyle)
  if (!slug) return null

  const product = await getProductBySlug(slug)
  if (!product) return null

  // A variation child's own address. Shop 404s these on their own account and
  // renders the parent configured to the combination instead, so the landing
  // belongs to the parent with the child named.
  if (product.catalogueHidden) {
    const deep = await resolveVariantDeepLink(product)
    return deep ? { productId: deep.parent.id, variantId: product.id } : null
  }

  if (product.status !== 'ACTIVE') return null

  const params = paramRecord(search)
  if (Object.keys(params).length === 0) return { productId: product.id, variantId: null }

  // Only asked when the address carries parameters at all, so a bare listing
  // costs one lookup rather than two.
  const payload = await getVariantSelectorPayload(product.id)
  if (!payload || payload.options.length === 0) return { productId: product.id, variantId: null }

  const valueIds = selectionValueIdsFromParams(payload, params)
  if (valueIds.length === 0) return { productId: product.id, variantId: null }

  const valueToOption = valueToOptionMap(payload)
  const raw: OptionSelection = {}
  for (const valueId of valueIds) {
    const optionId = valueToOption.get(valueId)
    if (optionId) raw[optionId] = valueId
  }
  if (Object.keys(raw).length === 0) return { productId: product.id, variantId: null }

  // The storefront's own derivation, not a stricter one of ours: name one
  // option and the page settles the rest, and the combination recorded here has
  // to be the combination the shopper is looking at.
  const variant = resolveVariant(payload, withAutoSelected(payload, withStrandedFilled(payload, raw)))
  return { productId: product.id, variantId: variant?.enabled ? variant.childProductId : null }
}

/** The query as the selection reader wants it. Repeated keys keep the first,
 *  which is the same thing a URL-shaped reader would do. */
function paramRecord(search: string): Record<string, string> {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const record: Record<string, string> = {}
  for (const [key, value] of params) {
    if (!(key in record)) record[key] = value
  }
  return record
}
