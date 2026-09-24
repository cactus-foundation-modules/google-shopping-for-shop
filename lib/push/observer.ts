// The `shop.product-saved` listener: something about a product moved, and it
// might be something Google is advertising.
//
// This is the whole of the "instant" in instant price and stock updates, and it
// is deliberately almost nothing. It queues an id and kicks the worker. It does
// not decide what the new price is, whether the item is in the feed, or whether
// it has actually changed - all three are the worker's job, and all three are
// answered from the feed build rather than guessed at here.
//
// It runs inside shop's database layer, on every product write on the site,
// including a CSV import doing it a thousand times. So the first thing it does
// is a five-second-cached settings read, and on a shop with the feature off
// that is the entire cost of this module being installed.
//
// An observer in shop's sense: it never throws (shop swallows it anyway, but
// relying on that would be rude), and nothing waits on the send.
import { getGsfSettingsCached } from '@/modules/google-shopping-for-shop/lib/settings'
import { queueProducts } from '@/modules/google-shopping-for-shop/lib/push/store'

/**
 * The product fields that can change what this module sends Google.
 *
 * Everything else a save might carry - a description, a photo, a meta title -
 * changes the feed, and the feed is fetched on Google's own schedule. Only the
 * price and the availability are worth interrupting Google about, and only
 * these fields move them:
 *
 *   price, salePrice   the two figures sent
 *   taxClassId         the feed sends a gross price, so the tax class moves it
 *   stockCount, trackInventory, outOfStockBehaviour, isPreOrder
 *                      the four inputs to availability (lib/feed-data.ts)
 *   status, catalogueHidden, partsOnly
 *                      whether the item is in the feed at all
 */
const WATCHED = new Set([
  'price',
  'salePrice',
  'taxClassId',
  'stockCount',
  'trackInventory',
  'outOfStockBehaviour',
  'isPreOrder',
  'status',
  'catalogueHidden',
  'partsOnly',
])

export async function googleShoppingProductSaved(productId: string, changed: readonly string[]): Promise<void> {
  const watched = changed.filter((field) => WATCHED.has(field))
  if (watched.length === 0) return

  const settings = await getGsfSettingsCached()
  // Not set up is as good as switched off for this purpose: queueing against a
  // Merchant Center link that does not exist would fill a table nothing ever
  // drains.
  if (!settings.enabled || !settings.pricePushEnabled || !settings.pushDataSourceId) return

  await queueProducts([productId], watched.join(', '))

  // The kick.
  //
  // `after` runs it once the response has gone out, so a shopper's checkout or
  // an owner's save never waits on a round trip to Google. It is not available
  // outside a request - a command-line import, say - and that is fine: the ids
  // are in the queue, and the hourly run takes them. The hourly run also
  // re-sends anything still in the feed whose figures no longer match what we
  // sent, whether or not it was ever queued, which is what covers the changes
  // no signal here can see at all (see lib/push/run.ts, sweepTargets).
  //
  // The worker itself is imported here rather than at the top of the file
  // because it pulls in the whole feed build, and this file is reached from
  // shop's database layer on every product write on the site.
  //
  // `minGapSeconds` is what stops a bulk edit becoming one run per row: the
  // claim in the database refuses unless that long has passed since the last
  // run started. Nothing is lost by a refused kick - the ids are in the queue.
  try {
    const { after } = await import('next/server')
    after(async () => {
      try {
        const { runPricePush } = await import('@/modules/google-shopping-for-shop/lib/push/run')
        await runPricePush({ minGapSeconds: settings.pushDebounceSeconds })
      } catch (error) {
        console.error('[google-shopping] the live price update did not run:', error)
      }
    })
  } catch {
    // No request to hang the work off. The queue keeps it for the hourly run.
  }
}
