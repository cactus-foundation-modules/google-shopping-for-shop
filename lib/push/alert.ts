// One answer to "are the live updates in trouble?", so the worker and the
// hourly comparison cannot disagree with each other.
//
// Both of them finish by calling this, and it reads the state table rather than
// taking either one's word for it. That matters because they raise and clear
// the SAME notification: a worker that sent everything cleanly would otherwise
// take down the notice the comparison had just raised about twelve items Google
// is holding the wrong price for.
import { ALERT_KEYS, isAlertUp, setPricePushAlert } from '@/modules/google-shopping-for-shop/lib/health/alerts'
import { readPushTotals } from '@/modules/google-shopping-for-shop/lib/push/store'

/**
 * Raises or clears the live-updates notice from what the table now says.
 *
 * Two things count as trouble, and they are different kinds of it:
 *   - items Google refused, which means this site is trying and failing;
 *   - items Google is holding something different for, which means this site
 *     thinks it has succeeded and has not.
 *
 * `message` is whatever sentence the caller has, usually Google's own.
 */
export async function syncPushAlert(message?: string): Promise<boolean> {
  const totals = await readPushTotals()
  const items = totals.failed + totals.differs
  if (items === 0) return setPricePushAlert({ failed: false })

  const alreadyUp = await isAlertUp(ALERT_KEYS.pricePush)
  const detail = message?.trim()
    || (totals.failed > 0
      ? 'Google would not take the latest prices for some of your products.'
      : 'Google is showing a different price or stock level from the one this site sent.')
  return setPricePushAlert({ failed: true, items, message: detail, alreadyUp })
}
