// Assembles the product review feed: the shop's published reviews, plus the
// handful of product facts Google matches them to a listing by.
//
// Same division of labour as lib/feed-data.ts - every judgement call lives
// here, and lib/review-feed-xml.ts only renders what this hands it. The reviews
// themselves come across the optional provider seam (lib/reviews-source.ts), so
// a shop with no reviews module installed serves a valid, empty document rather
// than a 500.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { resolveBranding } from '@/lib/config/branding'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { productUrl } from '@/modules/shop/lib/product-url'
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { getProductDataForProducts } from '@/modules/google-shopping-for-shop/lib/product-data'
import { getAllPublishedReviews } from '@/modules/google-shopping-for-shop/lib/reviews-source'
import { normaliseGtin } from '@/modules/google-shopping-for-shop/lib/feed-xml'
import type { ReviewFeedItem, ReviewFeedPublisher } from '@/modules/google-shopping-for-shop/lib/review-feed-xml'

// How much of a shop's review history one document carries. Google reads the
// newest first (the provider answers in that order), and a feed is fetched
// whole, in one response, by a machine on the other side of the world - so this
// is the line between a big feed and a request that never finishes.
const PAGE_SIZE = 500
const MAX_REVIEWS = 5000

// The product columns the review feed needs, read raw for the same reason
// lib/feed-data.ts does: no bulk read in shop selects by an id list.
type ProductRow = {
  id: string
  barcode: string | null
  supplier: string | null
}

async function getProductRows(productIds: string[]): Promise<Map<string, ProductRow>> {
  const map = new Map<string, ProductRow>()
  const unique = [...new Set(productIds)].filter(Boolean)
  if (unique.length === 0) return map
  const rows = await prisma.$queryRaw<ProductRow[]>`
    SELECT "id", "barcode", "supplier" FROM "shp_products" WHERE "id" IN (${Prisma.join(unique)})
  `
  for (const row of rows) map.set(row.id, row)
  return map
}

// Google wants a favicon it can actually draw, in GIF, JPG or PNG. The site's
// icon may perfectly well be an SVG, which they do not take - and an unusable
// favicon is a validation warning on every fetch for ever, so it is left off
// rather than sent hopefully.
function faviconFor(url: string | null, siteUrl: string): string | undefined {
  if (!url) return undefined
  const absolute = url.startsWith('http') ? url : `${siteUrl}${url.startsWith('/') ? '' : '/'}${url}`
  try {
    const path = new URL(absolute).pathname.toLowerCase()
    return /\.(png|jpe?g|gif)$/.test(path) ? absolute : undefined
  } catch {
    return undefined
  }
}

/** Who Google is told is publishing these reviews: the shop itself. */
export async function reviewFeedPublisher(siteUrl: string): Promise<ReviewFeedPublisher> {
  const branding = await resolveBranding()
  return {
    name: branding.name,
    faviconUrl: faviconFor(branding.icon32Url ?? branding.faviconUrl, siteUrl),
  }
}

/**
 * Every published review the shop is willing to send, as feed items.
 *
 * Two things are deliberately dropped on the way:
 *   - reviews of a product the owner has kept OUT of the product feed. A shop
 *     that will not advertise a product on Google has not asked Google to
 *     publish opinions of it either.
 *   - SKUs. The product feed withholds the shop's buying codes from shoppers
 *     (see identifiersOf in lib/feed-data.ts) and this feed holds the same line,
 *     even though Google would accept them.
 */
export async function collectReviewFeedItems(siteUrl: string): Promise<ReviewFeedItem[]> {
  const reviews = await getAllPublishedReviews({ pageSize: PAGE_SIZE, max: MAX_REVIEWS })
  if (reviews.length === 0) return []

  const [config, settings] = await Promise.all([getShopConfigCached(), getGsfSettings()])
  const productIds = reviews.map((review) => review.productId)
  const [productData, productRows] = await Promise.all([
    getProductDataForProducts(productIds),
    getProductRows(productIds),
  ])

  const items: ReviewFeedItem[] = []
  for (const review of reviews) {
    const data = productData.get(review.productId)
    if (data?.excluded) continue

    const row = productRows.get(review.productId)
    const supplier = settings.brandFromSupplier ? row?.supplier ?? null : null
    const brand = data?.brand ?? supplier ?? settings.defaultBrand ?? null
    // The parent's own barcode first, then whatever the owner typed on the
    // product's Google tab. A malformed one is dropped rather than sent: Google
    // rejects the review outright rather than ignoring the identifier.
    const gtin = normaliseGtin(row?.barcode) ?? normaliseGtin(data?.gtin ?? null)
    const url = productUrl(siteUrl, review.productSlug, config.productUrlStyle)

    items.push({
      id: review.id,
      authorName: review.authorName,
      timestamp: review.publishedAt,
      title: review.title ?? undefined,
      content: review.body,
      // The product page carries the whole set of reviews, this one among them,
      // which is exactly what Google means by "group". Calling it a singleton
      // would promise a page holding this review alone.
      url,
      urlType: 'group',
      rating: review.rating,
      // One is the worst score a shopper can leave here, not zero: the schema is
      // firm that min must be a real rating rather than "no rating given".
      ratingMin: 1,
      ratingMax: review.ratingMax,
      products: [{
        url,
        name: review.productName,
        gtins: gtin ? [gtin] : undefined,
        // MPN only where the owner typed one. Unlike the product feed there is
        // no variation to confuse it with here - a review is written about the
        // product as a whole.
        mpns: data?.mpn ? [data.mpn] : undefined,
        brands: brand ? [brand] : undefined,
      }],
      // "post_fulfillment" is a claim about how the review was collected, so it
      // is only made where the shop actually asked for it after the order. A
      // review that simply turned up is unsolicited, which is what Google calls
      // the ordinary case.
      collectionMethod: review.invited ? 'post_fulfillment' : 'unsolicited',
      transactionId: review.orderNumber ?? undefined,
    })
  }
  return items
}
