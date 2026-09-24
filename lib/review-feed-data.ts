// Assembles the product review feed: the shop's published reviews, plus the
// product identifiers Google matches them to a listing by.
//
// Same division of labour as lib/feed-data.ts - every judgement call lives
// here, and lib/review-feed-xml.ts only renders what this hands it. The reviews
// themselves come across the optional provider seam (lib/reviews-source.ts), so
// a shop with no reviews module installed serves a valid, empty document rather
// than a 500.
//
// It builds the PRODUCT feed to do its job, which is the expensive-looking part
// and the load-bearing one. Merchant Center does not match a review to a
// product; it matches it to an offer, by GTIN or brand+MPN, against the very
// rows the product feed published. So the only safe source for the identifiers
// in this document is that document - see lib/review-listing-ids.ts for the
// three ways working them out separately got them wrong.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { resolveBranding } from '@/lib/config/branding'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { productUrl } from '@/modules/shop/lib/product-url'
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { getProductDataForProducts } from '@/modules/google-shopping-for-shop/lib/product-data'
import { getAllPublishedReviews } from '@/modules/google-shopping-for-shop/lib/reviews-source'
import { collectFeedItems } from '@/modules/google-shopping-for-shop/lib/feed-data'
import { identifiersOf } from '@/modules/google-shopping-for-shop/lib/identifiers'
import { listingIdentifiers, pruneIdentifiers } from '@/modules/google-shopping-for-shop/lib/review-listing-ids'
import type { ReviewFeedItem, ReviewFeedPublisher } from '@/modules/google-shopping-for-shop/lib/review-feed-xml'

// How much of a shop's review history one document carries. Google reads the
// newest first (the provider answers in that order), and a feed is fetched
// whole, in one response, by a machine on the other side of the world - so this
// is the line between a big feed and a request that never finishes.
const PAGE_SIZE = 500
const MAX_REVIEWS = 5000

// The product columns the review feed needs for a listing the product feed did
// not publish, read raw for the same reason lib/feed-data.ts does: no bulk read
// in shop selects by an id list.
type ProductRow = {
  id: string
  barcode: string | null
  supplier: string | null
  /** The code the listing is ordered by, published as its part number only
   *  where the owner has said the code is the maker's. */
  sku: string | null
}

async function getProductRows(productIds: string[]): Promise<Map<string, ProductRow>> {
  const map = new Map<string, ProductRow>()
  const unique = [...new Set(productIds)].filter(Boolean)
  if (unique.length === 0) return map
  const rows = await prisma.$queryRaw<ProductRow[]>`
    SELECT "id", "barcode", "supplier", "sku" FROM "shp_products" WHERE "id" IN (${Prisma.join(unique)})
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
 *   - reviews of a product the owner has kept OUT of the product feed, by their
 *     own choice or by a feed rule. A shop that will not advertise a product on
 *     Google has not asked Google to publish opinions of it either.
 *   - the shop's buying codes as codes. Where the owner has said their product
 *     codes are the MAKER's part numbers, the code travels as the part number
 *     it is and nothing else changes - and `skus` carries the feed's own opaque
 *     offer ids, never the supplier code.
 */
export async function collectReviewFeedItems(siteUrl: string): Promise<ReviewFeedItem[]> {
  const reviews = await getAllPublishedReviews({ pageSize: PAGE_SIZE, max: MAX_REVIEWS })
  if (reviews.length === 0) return []

  // The product feed, built the same way the product document builds it: rules
  // run, exclusions applied, imageless rows already withheld. `items` is
  // exactly what Merchant Center holds, which is exactly what a review has to
  // be matched against.
  const [config, settings, feed] = await Promise.all([
    getShopConfigCached(),
    getGsfSettings(),
    collectFeedItems(siteUrl),
  ])
  const listings = listingIdentifiers(feed.items)
  // Listings that WERE built and then kept out - by the owner's hand or by a
  // rule. Separate from "not in the feed" because the two mean different
  // things: this one is a decision, and a review of a product the shop has
  // decided not to advertise is not published either. Something merely absent
  // (sold out, hidden, no photograph) is not a decision about its reviews.
  const keptOut = new Set<string>()
  for (const { item } of feed.excluded) keptOut.add(item.itemGroupId ?? item.id)

  const productIds = reviews.map((review) => review.productId)
  const [productData, productRows] = await Promise.all([
    getProductDataForProducts(productIds),
    getProductRows(productIds),
  ])

  const items: ReviewFeedItem[] = []
  for (const review of reviews) {
    const data = productData.get(review.productId)
    const live = listings.get(review.productId)
    // The owner's own "never send", and now a rule's too. A product with no
    // offer left in the feed AND an offer that was deliberately kept out is a
    // listing the shop has taken off Google; its reviews go with it.
    if (data?.feedChoice === 'exclude') continue
    if (!live && keptOut.has(review.productId)) continue

    const row = productRows.get(review.productId)
    // Where the product feed has no row for this listing at all - sold out on a
    // shop that hides sold-out stock, hidden, awaiting a photograph - there are
    // no offer identifiers to copy, so the listing's own are resolved here
    // through the same function the product feed uses. A review still worth
    // sending: Google matches a valid GTIN against its own catalogue whether or
    // not this shop is advertising the product this week.
    const fallback = live ? undefined : identifiersOf(
      { brand: data?.brand ?? null, gtin: data?.gtin ?? null, mpn: data?.mpn ?? null },
      {
        supplier: row?.supplier ?? null,
        defaultBrand: settings.defaultBrand,
        useSupplier: settings.brandFromSupplier,
      },
      { barcode: row?.barcode ?? null, sku: row?.sku ?? null },
      // A listing with no variations in the feed is the standalone case, which
      // is the only one entitled to the typed-in GTIN and MPN.
      { standalone: true, mpnFromSku: settings.mpnFromSku },
    )
    // The product's own id as the sku: on a standalone listing that IS the id
    // the feed publishes it under, so it still matches the offer Google held
    // before the product went out of stock. On a variant listing it matches
    // nothing, which costs nothing - an unmatched secondary id is not an error.
    const ids = pruneIdentifiers(live ?? {
      gtins: fallback?.gtin ? [fallback.gtin] : [],
      mpns: fallback?.mpn ? [fallback.mpn] : [],
      skus: [review.productId],
      brands: fallback?.brand ? [fallback.brand] : [],
    })
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
      products: [{ url, name: review.productName, ...ids }],
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
