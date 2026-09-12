// Which built rows are fit to publish, and which are withheld.
//
// Pure and in a file of its own so it can be exercised without a database:
// collectFeedItems needs several thousand queries before it has anything to
// decide about, which is exactly the sort of thing that never gets a test.
import type { FeedItem } from '@/modules/google-shopping-for-shop/lib/feed-xml'
import type { FeedWithheldItem } from '@/modules/google-shopping-for-shop/lib/feed-data'

/**
 * Split the built rows into what goes to Google and what does not.
 *
 * One rule today: `image_link` is a required attribute, and an item without one
 * is rejected every time, on every destination, in every country. There is no
 * shop where publishing it achieves anything except a disapproval the owner then
 * has to interpret.
 *
 * Deliberately NOT a general-purpose validity check. Everything else Google can
 * refuse - a bad category, a price it dislikes, a landing page it cannot read -
 * is a judgement it makes and we would only be guessing at. This is the one
 * defect that is knowable here, certain, and cheap to spot.
 */
export function partitionPublishable(items: FeedItem[]): { publishable: FeedItem[]; withheld: FeedWithheldItem[] } {
  const publishable: FeedItem[] = []
  const withheld: FeedWithheldItem[] = []
  for (const item of items) {
    // An empty string is not a picture either. `imageLinks` is built from media
    // rows, and a row whose url never resolved arrives as ''.
    if (item.imageLinks.some((url) => url.trim().length > 0)) publishable.push(item)
    else withheld.push({ id: item.id, title: item.title, reason: 'no-image' })
  }
  return { publishable, withheld }
}
