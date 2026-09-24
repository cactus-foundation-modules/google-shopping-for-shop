// GET /api/m/google-shopping-for-shop/cron/match-status
// Daily Merchant Center check, so match history dates a change to the day it
// happened rather than to whenever someone last pressed Refresh.
//
// Six questions, one run: what Google makes of each item (match, benchmark
// price, and its issues), whether Google managed to read the feed at all,
// whether the delivery charges at Merchant Center still match this site's, how
// each item actually performed yesterday, what is selling in the same
// categories, and what the Google Ads side of it all cost. Most of them are
// things nobody would think to check by hand, which is exactly why they are on
// a timer.
//
// Each job after the first runs in its own try. The match refresh has already
// been written by the time any of them runs, and a report Google will not
// answer must never throw that away.
import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { canRefreshMerchantMatchStatus, refreshMerchantMatchStatus } from '@/modules/google-shopping-for-shop/lib/merchant-reports'
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { ALERT_KEYS, isAlertUp, syncFeedFetchAlert } from '@/modules/google-shopping-for-shop/lib/health/alerts'
import { refreshFeedFetchStatus } from '@/modules/google-shopping-for-shop/lib/health/feed-fetch'
import { runDeliverySyncCheck } from '@/modules/google-shopping-for-shop/lib/delivery/sync-check'
import { importPerformance } from '@/modules/google-shopping-for-shop/lib/performance/import'
import { importBestSellers } from '@/modules/google-shopping-for-shop/lib/best-sellers/import'
import { pruneClickTracking } from '@/modules/google-shopping-for-shop/lib/click-tracking/store'
import { importAdsSpend } from '@/modules/google-shopping-for-shop/lib/google-ads/spend-import'

// Vercel appends `Authorization: Bearer $CRON_SECRET` to its own cron requests.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse('CRON_SECRET is not configured', 503)
  if (request.headers.get('authorization') !== `Bearer ${secret}`) return errorResponse('Unauthorized', 401)

  // Caught and reported: an uncaught throw reaches the cron log as a bare "HTTP 500".
  try {
    // A shop that has not linked Merchant Center has nothing to check - not a failure.
    const settings = await getGsfSettings()

    // BEFORE the Merchant Center check below, deliberately. Click tracking
    // works off the shop's own pages and a visitor's browser; it does not need
    // Merchant Center, and a site that has not linked one would otherwise keep
    // its landings for ever because the run gave up two lines earlier.
    //
    // Its own try, like every other job here: a sweep that cannot run must not
    // throw away the checks that follow it.
    let pruned: { landings: number; rateWindows: number } = { landings: 0, rateWindows: 0 }
    try {
      pruned = await pruneClickTracking(settings.clickRetentionDays)
    } catch (err) {
      console.error('[google-shopping] click tracking prune failed:', err)
    }

    // The Google Ads spend import, which is the one job here that has nothing
    // to do with Merchant Center: different account, different sign-in.
    //
    // Its own try, like every other job here, and deliberately run in ONE of
    // two places rather than one:
    //
    //   * on the early-return path below, where a shop with no Merchant Center
    //     key would otherwise never fetch its own ad spend at all, because the
    //     run gives up over a credential this job does not need;
    //   * otherwise LAST, after the four Merchant Center jobs.
    //
    // Both, and not just the first, because this run has sixty seconds and this
    // job will spend twenty of them. Ahead of everything else it would take
    // that budget off the feed check, the delivery check, the performance
    // import and the best sellers - four jobs that were here first and that a
    // shop is more likely to be relying on. Last, it takes whatever is left,
    // and a spend import that runs out of time simply carries on tomorrow from
    // its own cursor.
    let adsSpend: { status: string; rows: number | null; backfilling: boolean } = {
      status: 'not-checked', rows: null, backfilling: false,
    }
    const runAdsSpend = async () => {
      try {
        const outcome = await importAdsSpend()
        adsSpend = outcome.status === 'ok'
          ? { status: 'ok', rows: outcome.rows, backfilling: outcome.backfilling }
          : { status: outcome.reason, rows: null, backfilling: false }
      } catch (err) {
        console.error('[google-shopping] daily Google Ads spend import failed:', err)
        adsSpend = { status: 'error', rows: null, backfilling: false }
      }
    }

    if (!settings.merchantId || !canRefreshMerchantMatchStatus()) {
      await runAdsSpend()
      return NextResponse.json({ ok: true, skipped: 'Merchant Center is not linked', pruned, adsSpend })
    }
    const result = await refreshMerchantMatchStatus()

    // Its own try: a feed check that cannot reach Google must not throw away
    // the match refresh that has already been written.
    let feed: { state: string; alerted: boolean } = { state: 'not-checked', alerted: false }
    try {
      const outcome = await refreshFeedFetchStatus()
      const alreadyUp = await isAlertUp(ALERT_KEYS.feedFetch)
      const alerted = outcome.status === 'ok'
        ? await syncFeedFetchAlert({ status: 'ok', fetch: outcome.fetch, alreadyUp })
        : await syncFeedFetchAlert({ status: 'unavailable', reason: outcome.reason, alreadyUp })
      feed = { state: outcome.status === 'ok' ? outcome.fetch.state : outcome.reason, alerted }
    } catch (err) {
      console.error('[google-shopping] daily feed check failed:', err)
    }

    // Its own try, for the same reason the feed check has one: a delivery
    // comparison that cannot reach Google must not throw away the match
    // refresh that has already been written. Switched off by default, in
    // which case this costs one settings read and no API call at all.
    let delivery: { status: string; differences: number | null; alerted: boolean } = {
      status: 'not-checked', differences: null, alerted: false,
    }
    try {
      const outcome = await runDeliverySyncCheck()
      delivery = outcome.status === 'ok'
        ? { status: 'ok', differences: outcome.differences, alerted: outcome.alerted }
        : { status: outcome.reason, differences: null, alerted: false }
    } catch (err) {
      console.error('[google-shopping] daily delivery check failed:', err)
    }

    // Its own try, for the same reason the two above have one. Also the
    // longest job here by some way - it works to a wall-clock budget of its
    // own and leaves the rest of a backfill for tomorrow rather than running
    // the whole cron out of time.
    let performance: { status: string; rows: number | null; backfilling: boolean } = {
      status: 'not-checked', rows: null, backfilling: false,
    }
    try {
      const outcome = await importPerformance()
      performance = outcome.status === 'ok'
        ? { status: 'ok', rows: outcome.rows, backfilling: outcome.backfilling }
        : { status: outcome.reason, rows: null, backfilling: false }
    } catch (err) {
      console.error('[google-shopping] daily performance import failed:', err)
    }

    // Its own try again. Switched off by default, in which case this costs one
    // settings read and no API call at all.
    let bestSellers: { status: string; rows: number | null } = { status: 'not-checked', rows: null }
    try {
      const outcome = await importBestSellers()
      bestSellers = outcome.status === 'ok'
        ? { status: outcome.unavailable ? 'unavailable' : 'ok', rows: outcome.rows }
        : { status: outcome.reason, rows: null }
    } catch (err) {
      console.error('[google-shopping] daily best sellers import failed:', err)
    }

    // Last, and with whatever budget the four above left it. See the note above.
    await runAdsSpend()

    return NextResponse.json({
      ok: true,
      checkedAt: result.checkedAt.toISOString(),
      products: result.products,
      matched: result.matched,
      issues: result.issues,
      disapprovedItems: result.disapprovedItems,
      spikeAlerted: result.spikeAlerted,
      issuesSkipped: result.issuesSkipped,
      feed,
      delivery,
      performance,
      bestSellers,
      pruned,
      adsSpend,
    })
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'the match refresh failed', 500)
  }
}
