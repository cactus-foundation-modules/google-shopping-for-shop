// Which pictures one variation's feed item carries.
//
// A variation's own photographs always lead: they are the thing being priced,
// and Google reads the first one as the item's `image_link`. Behind them, when
// the owner has switched it on, comes what is left of the listing's own gallery
// - the room shot, the detail of the mechanism, the dimensions drawing - which
// belongs to every variation equally and is usually the richer set.
//
// What must NOT come through is another variation's photograph. Plenty of
// listings are photographed variation by variation and then have those same
// pictures set as the listing's own, so pouring the parent gallery into a black
// desk's item would show Google an oak one under a black one's price. Any
// listing picture that is also a variation's is dropped for that reason - unless
// it is THIS variation's, which is the ordinary case of a listing leading with
// the picture of its most popular finish.
//
// Comparison ignores a query string or fragment, so the same file reached with
// a cache-busting `?v=` on one row and not the other is still recognised as the
// same picture.

/** The part of a media URL that identifies the file, for comparing two rows
 *  that may carry different cache-busting parameters for the same image. */
function imageKey(url: string): string {
  return url.split('#')[0]?.split('?')[0] ?? url
}

export function variationImageLinks(args: {
  /** The variation's own pictures, primary first. */
  ownImages: readonly string[]
  /** The listing's own pictures, primary first. */
  parentImages: readonly string[]
  /** Every picture belonging to any variation of this listing, this one's
   *  included - the caller builds it once per listing rather than per item. */
  allVariantImages: ReadonlySet<string>
  /** Off leaves the old behaviour exactly as it was: the variation's own
   *  pictures, or the listing's where it has none. */
  includeParentImages: boolean
}): string[] {
  const { ownImages, parentImages, allVariantImages, includeParentImages } = args
  if (!includeParentImages) return ownImages.length > 0 ? [...ownImages] : [...parentImages]

  const ownKeys = new Set(ownImages.map(imageKey))
  // A picture this variation also owns is not "another variation's", however
  // many siblings share it.
  const claimedByOthers = (url: string) => {
    const key = imageKey(url)
    return !ownKeys.has(key) && allVariantImages.has(key)
  }

  const seen = new Set<string>()
  const out: string[] = []
  const push = (url: string) => {
    const key = imageKey(url)
    if (seen.has(key)) return
    seen.add(key)
    out.push(url)
  }
  for (const url of ownImages) push(url)
  for (const url of parentImages) if (!claimedByOthers(url)) push(url)

  // Every one of the listing's pictures turned out to be a sibling's and this
  // variation brought none of its own, which would leave the item with no
  // picture at all - and an item with no `image_link` is one Google refuses.
  // The listing's gallery unfiltered is the same answer the feed gave before
  // this setting existed, so fall back to it rather than drop the item.
  if (out.length === 0) return [...parentImages]
  return out
}

/** Every picture belonging to any variation of one listing, keyed the way
 *  `variationImageLinks` compares them. Built once per listing. */
export function variantImageKeySet(variants: ReadonlyArray<{ imageUrls: readonly string[] }>): Set<string> {
  const keys = new Set<string>()
  for (const variant of variants) for (const url of variant.imageUrls) keys.add(imageKey(url))
  return keys
}
