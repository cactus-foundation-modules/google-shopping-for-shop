// The hourly "did it actually land?" check.
//
// Sending something and believing it arrived are two different claims, and this
// module is only entitled to the first one. `productInputs.insert` returning a
// 200 means Merchant Center took the input; it does not mean the processed
// product now carries it. Processing is asynchronous, a rule further up the
// priority order can win, and an input can be accepted and then dropped for a
// reason nothing tells us about.
//
// So a sample of what we believe we sent is read back from Google - the
// PROCESSED product, the one shoppers would see, not our own input - and
// compared. A sample rather than the catalogue because it is one API call per
// item; twenty an hour walks a shop of any size in a fortnight and costs
// nothing anybody will notice.
//
// Nothing here is a guess. An item Google answers with no price or no
// availability we recognise is recorded as unread, not as a disagreement: "we
// could not read the answer" and "the answer was wrong" are different things,
// and only one of them is worth waking somebody up for.
import { merchantRequest } from '@/modules/google-shopping-for-shop/lib/google/client'
import { hasGoogleCredentials } from '@/modules/google-shopping-for-shop/lib/google/credentials'
import { GoogleApiError } from '@/modules/google-shopping-for-shop/lib/google/errors'
import { productResourceSegment } from '@/modules/google-shopping-for-shop/lib/health/parse'
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { syncPushAlert } from '@/modules/google-shopping-for-shop/lib/push/alert'
import { googleShowsSameOffer, snapshotFromProduct, snapshotFromStored } from '@/modules/google-shopping-for-shop/lib/push/payload'
import {
  readDisagreements,
  recordReconcile,
  recordReconcileRun,
  sampleForReconcile,
  settleDisagreement,
} from '@/modules/google-shopping-for-shop/lib/push/store'
import type { PushSnapshot } from '@/modules/google-shopping-for-shop/lib/push/types'

/** Merchant Center processes an input asynchronously, so an item asked about
 *  straight after it was sent disagrees for an entirely innocent reason. Two
 *  hours is well past Google's own stated processing window and well inside the
 *  daily feed fetch, so a difference after it is a real one. */
const GRACE_MINUTES = 120

/** One retry per item and no more. This runs on a timer with a whole cron's
 *  worth of other jobs behind it. */
const ATTEMPTS = 2

/** How many stored disagreements are looked at again per run. The panel shows
 *  twenty; this is comfortably more, and it costs no calls to Google. */
const RESCORE_LIMIT = 100

export type ReconcileOutcome =
  | { status: 'ok'; checked: number; agrees: number; differs: number; unread: number; missing: number }
  | { status: 'skipped'; reason: 'off' | 'feed-off' | 'not-set-up' | 'no-credentials' | 'no-merchant-id' | 'no-feed-label' | 'nothing-to-check'; message: string }

const SKIP_COPY: Record<Exclude<ReconcileOutcome, { status: 'ok' }>['reason'], string> = {
  off: 'Live price and stock updates are switched off.',
  'feed-off': 'Your Google Shopping feed is switched off.',
  'not-set-up': 'Live updates have not been set up with Merchant Center yet.',
  'no-credentials': 'No Google service-account key has been saved.',
  'no-merchant-id': 'Your Merchant Center account number has not been filled in.',
  'no-feed-label': 'Your feed label has not been filled in.',
  'nothing-to-check': 'Nothing has been sent to Google yet, so there is nothing to check.',
}

function skip(reason: Exclude<ReconcileOutcome, { status: 'ok' }>['reason']): ReconcileOutcome {
  return { status: 'skipped', reason, message: SKIP_COPY[reason] }
}

/** The two sides of a disagreement, kept whole so the screen can show both
 *  rather than asserting which is right. */
type Difference = { sent: PushSnapshot; google: PushSnapshot; checkedAt: string }

/**
 * Looks again at the disagreements already on record, with the comparison as it
 * stands now, and clears any it no longer counts.
 *
 * The sample walks the whole catalogue before it comes back to an item, which
 * on a shop of any size is days. A disagreement recorded by an older, stricter
 * comparison would otherwise sit on the Health tab all that time, flagging
 * something this module has since decided is fine. Both sides of it are stored,
 * so no call to Google is needed to settle it. A Google side recorded as
 * missing is never settled here: there is nothing to compare.
 */
async function rescoreDisagreements(): Promise<void> {
  for (const row of await readDisagreements(RESCORE_LIMIT)) {
    const detail = row.reconcileDetail as { google?: unknown } | null
    const google = snapshotFromStored(detail?.google)
    if (google && googleShowsSameOffer(row.snapshot, google)) await settleDisagreement(row.itemId)
  }
}

/**
 * Compares a sample of what we sent against what Google holds.
 *
 * Never throws for a Google refusal - the cron has other jobs and must not lose
 * them to this one. A refusal on ONE item leaves that item's own stamp alone,
 * so it comes round again next hour rather than being recorded as agreeing.
 */
export async function runPushReconcile(): Promise<ReconcileOutcome> {
  const settings = await getGsfSettings()
  if (!settings.pricePushEnabled) return skip('off')
  // Same master switch the worker honours: a shop that has switched its feed
  // off has no listings for this to be checking.
  if (!settings.enabled) return skip('feed-off')
  if (!hasGoogleCredentials()) return skip('no-credentials')
  if (!settings.merchantId) return skip('no-merchant-id')
  if (!settings.feedLabel) return skip('no-feed-label')
  if (!settings.pushDataSourceId) return skip('not-set-up')

  await rescoreDisagreements()

  const sample = await sampleForReconcile(settings.pushReconcileSample, GRACE_MINUTES)
  if (sample.length === 0) return skip('nothing-to-check')

  let agrees = 0
  let differs = 0
  let unread = 0
  let missing = 0

  for (const row of sample) {
    const segment = productResourceSegment({
      contentLanguage: settings.contentLanguage,
      feedLabel: settings.feedLabel,
      offerId: row.itemId,
    })
    if (!segment) {
      unread++
      continue
    }

    let raw: unknown
    try {
      raw = await merchantRequest<unknown>(
        `products/v1/accounts/${settings.merchantId}/products/${segment}`,
        { method: 'GET', attempts: ATTEMPTS },
      )
    } catch (error) {
      // A 404 means Google is not holding this product at all - which, for an
      // item we believe we sent minutes-to-hours ago and that the feed still
      // carries, is a real disagreement and not a reading failure.
      if (error instanceof GoogleApiError && error.status === 404) {
        missing++
        await recordReconcile(row.itemId, 'differs', {
          sent: row.snapshot,
          google: null,
          missing: true,
          checkedAt: new Date().toISOString(),
        })
        continue
      }
      // Anything else and we simply did not find out. The stamp is left where
      // it was so this item is first in the queue next hour.
      unread++
      continue
    }

    const google = snapshotFromProduct(raw)
    if (!google) {
      unread++
      continue
    }

    if (googleShowsSameOffer(row.snapshot, google)) {
      agrees++
      await recordReconcile(row.itemId, 'agrees', null)
    } else {
      differs++
      const difference: Difference = { sent: row.snapshot, google, checkedAt: new Date().toISOString() }
      await recordReconcile(row.itemId, 'differs', difference)
    }
  }

  const checked = agrees + differs + missing
  await recordReconcileRun(checked, differs + missing)
  await syncPushAlert(
    differs + missing > 0
      ? 'Google is showing a different price or stock level from the one this site sent.'
      : undefined,
  )

  return { status: 'ok', checked, agrees, differs, unread, missing }
}
