// Where the review feed's reviews come from: whichever module publishes the
// shop's published reviews - Reviews for Shop today, anything else tomorrow.
//
// An OPTIONAL companion, not a dependency, and looked up exactly the way
// delivery timing is (see lib/delivery-timing.ts): through core's generated
// extension-point registry, which is built from the manifests of the modules
// actually installed. Importing '@/modules/reviews-for-shop/...' directly would
// break the build on every install that has not got it.
//
// The provider's answer is checked rather than trusted. It crosses a registry
// seam with no shared types, so a row whose shape has drifted costs the feed
// that one review, not the whole run.
import { modulePublicExtensionPointComponents as moduleExtensionPointComponents } from '@/lib/modules/extension-points.public'

const POINT = 'shop.product-reviews'

/** One published review, as the feed needs it. */
export type SourceReview = {
  id: string
  productId: string
  productName: string
  productSlug: string
  rating: number
  ratingMax: number
  title: string | null
  body: string
  /** Empty means the reviewer left no name, which the feed renders as
   *  anonymous rather than inventing one. */
  authorName: string
  publishedAt: string
  verifiedPurchase: boolean
  /** Written in answer to an invitation sent after the order was fulfilled.
   *  Google asks which of the two a review is, and guessing is worse than
   *  saying nothing. */
  invited: boolean
  orderNumber: string | null
}

type ReviewsProvider = (opts: { limit: number; offset: number }) => Promise<unknown>

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

// One row off the provider, checked field by field. Everything Google insists on
// - an id, a product, a rating, wording and a date - has to be there and be the
// right sort of thing, or the row is dropped: a review missing any of them is a
// feed item Merchant Center rejects, and one rejected item can take the feed's
// standing with it.
function readReview(value: unknown): SourceReview | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  const id = str(row.id)
  const productId = str(row.productId)
  const productName = str(row.productName)
  const productSlug = str(row.productSlug)
  const body = str(row.body)
  const publishedAt = str(row.publishedAt)
  if (!id || !productId || !productName || !productSlug || !body || !publishedAt) return null
  // A date Google can read. An unparseable one is not worth guessing at: the
  // review timestamp is what orders the whole feed at their end.
  if (Number.isNaN(Date.parse(publishedAt))) return null
  const rating = typeof row.rating === 'number' ? row.rating : Number.NaN
  const ratingMax = typeof row.ratingMax === 'number' ? row.ratingMax : Number.NaN
  if (!Number.isFinite(rating) || !Number.isFinite(ratingMax)) return null
  // A scale that does not contain its own score describes nothing.
  if (ratingMax <= 1 || rating < 1 || rating > ratingMax) return null
  return {
    id,
    productId,
    productName,
    productSlug,
    rating,
    ratingMax,
    title: str(row.title),
    body,
    authorName: str(row.authorName) ?? '',
    publishedAt,
    verifiedPurchase: row.verifiedPurchase === true,
    invited: row.invited === true,
    orderNumber: str(row.orderNumber),
  }
}

/** The registered provider, or null where no module publishes reviews. */
function reviewsProvider(): ReviewsProvider | null {
  const registered: Record<string, unknown> = moduleExtensionPointComponents[POINT] ?? {}
  return Object.values(registered).find((entry): entry is ReviewsProvider => typeof entry === 'function') ?? null
}

/** Whether any installed module publishes reviews at all. The settings tab asks
 *  so it can say plainly that the review feed would be an empty document. */
export function hasReviewsProvider(): boolean {
  return reviewsProvider() !== null
}

/** One page of published reviews, alongside how many rows the provider actually
 *  handed back. The two differ when a row was malformed, and the paging above
 *  needs the second figure: a page that came back full is a page to follow,
 *  however many of its rows survived checking. */
export async function getPublishedReviewsPage(opts: {
  limit: number
  offset: number
}): Promise<{ reviews: SourceReview[]; received: number }> {
  const provider = reviewsProvider()
  if (!provider) return { reviews: [], received: 0 }
  const answered = await provider({ limit: opts.limit, offset: opts.offset })
  if (!Array.isArray(answered)) return { reviews: [], received: 0 }
  const reviews: SourceReview[] = []
  for (const entry of answered) {
    const review = readReview(entry)
    if (review) reviews.push(review)
  }
  return { reviews, received: answered.length }
}

/** Every published review, read a page at a time.
 *
 *  Capped, because this is a document served in one response to a fetcher on
 *  the other side of the world, and an unbounded read is a shop that grows its
 *  way into a timeout without ever being told. Google reads the newest reviews
 *  first either way - the provider hands them back in that order. */
export async function getAllPublishedReviews(opts: { pageSize: number; max: number }): Promise<SourceReview[]> {
  if (!reviewsProvider()) return []
  const all: SourceReview[] = []
  for (let offset = 0; offset < opts.max; offset += opts.pageSize) {
    const limit = Math.min(opts.pageSize, opts.max - offset)
    const page = await getPublishedReviewsPage({ limit, offset })
    all.push(...page.reviews)
    // A short page is the end of the list - measured on what the provider
    // RETURNED, not on what survived checking. Reading the filtered length here
    // would stop the run at the first malformed review and quietly publish a
    // fraction of the shop's reviews.
    if (page.received < limit) break
  }
  return all
}
