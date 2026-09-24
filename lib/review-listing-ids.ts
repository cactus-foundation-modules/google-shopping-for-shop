// The identifiers a review travels with, gathered from the product feed's own
// finished items. Pure: feed items in, identifier lists out, no database and no
// config - so the rule below is testable with fixtures.
//
// Why it reads the product feed rather than the product tables, which is the
// whole point of this file: Merchant Center does not match a review to a
// product, it matches it to an OFFER, by GTIN or brand+MPN, against the rows
// the product feed published. Working the identifiers out separately here got a
// different answer from the product feed in three ways, and all three came back
// as Google's "Missing or invalid product_id" on the review -
//
//   - a listing sold in variations publishes one offer per child row, each
//     carrying the CHILD's barcode and code. Reading the PARENT row, which on a
//     variant listing normally has neither, sent the review out with no GTIN
//     and no MPN at all. On a catalogue where most listings have options, that
//     is most of the reviews.
//   - where the parent row did have a code and `mpnFromSku` was on, the review
//     claimed an MPN that appeared on no offer in the feed. An identifier
//     Google cannot match is the same complaint as a missing one.
//   - feed rules can repair a brand, a GTIN or an MPN, or switch `mpnFromSku`
//     on for part of the catalogue. Those ran for the product feed and not for
//     the review feed, so a shop that had already fixed its identifiers still
//     had unapproved reviews.
import type { FeedItem } from '@/modules/google-shopping-for-shop/lib/feed-xml'
import type { ReviewFeedProduct } from '@/modules/google-shopping-for-shop/lib/review-feed-xml'

/** The identifying attributes of one LISTING. Lists, because a review is
 *  written about the listing and a listing sold in variations is many offers;
 *  Google matches the review against any one of them. */
export type ListingIdentifiers = { gtins: string[]; mpns: string[]; skus: string[]; brands: string[] }

export function addIdentifier(into: string[], value: string | null | undefined): void {
  const trimmed = value?.trim()
  if (trimmed && !into.includes(trimmed)) into.push(trimmed)
}

/**
 * What Google holds for each listing, keyed by the product a review is written
 * against.
 *
 * Keyed by `itemGroupId ?? id`: the parent listing for a variation, the product
 * itself for a standalone one - which is the id a review carries either way.
 */
export function listingIdentifiers(items: readonly FeedItem[]): Map<string, ListingIdentifiers> {
  const map = new Map<string, ListingIdentifiers>()
  for (const item of items) {
    const listingId = item.itemGroupId ?? item.id
    let entry = map.get(listingId)
    if (!entry) {
      entry = { gtins: [], mpns: [], skus: [], brands: [] }
      map.set(listingId, entry)
    }
    addIdentifier(entry.gtins, item.gtin)
    addIdentifier(entry.mpns, item.mpn)
    // The offer id, which is what Google's `sku` means here: the value in the
    // product feed's own `g:id`, an opaque product row id and not a supplier
    // code, so nothing the shop keeps to itself travels with it. Only a
    // SECONDARY match in Google's book - it will not clear the warning on its
    // own, a GTIN or a brand+MPN pair does that - but it costs nothing and it
    // is the one value guaranteed to agree with the product feed.
    addIdentifier(entry.skus, item.id)
    addIdentifier(entry.brands, item.brand)
  }
  return map
}

/** As the renderer wants them: a list that came back empty is left off
 *  entirely, because an empty container satisfies no part of the schema and
 *  tells Google only that something went missing. */
export function pruneIdentifiers(
  ids: ListingIdentifiers,
): Pick<ReviewFeedProduct, 'gtins' | 'mpns' | 'skus' | 'brands'> {
  return {
    ...(ids.gtins.length ? { gtins: ids.gtins } : {}),
    ...(ids.mpns.length ? { mpns: ids.mpns } : {}),
    ...(ids.skus.length ? { skus: ids.skus } : {}),
    ...(ids.brands.length ? { brands: ids.brands } : {}),
  }
}
