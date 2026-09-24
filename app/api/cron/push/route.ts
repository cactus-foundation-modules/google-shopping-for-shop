// GET /api/m/google-shopping-for-shop/cron/push
// The hourly live-updates run.
//
// Two jobs, in this order and each in its own try:
//
//   1. Send whatever is queued, and SWEEP. The sweep is the honest part of the
//      whole feature, and it does TWO things, not one:
//        - it sends every item still in the feed whose price or availability is
//          no longer what we last sent, and every item never sent at all;
//        - it takes out of Merchant Center anything the feed no longer carries.
//      Both are needed because a product's figures can move without any product
//      ever being saved: the stock-import module writes counts in one bulk
//      statement and announces nothing, a feed rule can change what an item is
//      worth, a category can move, an image can be deleted. No signal from the
//      shop can see any of those. Whatever the signals miss, this finds within
//      the hour - and it is also what walks the catalogue the first time an
//      owner switches the feature on.
//
//   2. Compare a sample of what we believe we sent against what Google
//      actually holds, because a 200 from an insert means Merchant Center took
//      the input and not that the shopper is being shown it.
//
// Separate from the daily 05:30 cron on purpose. That one is about reports and
// can afford to be a day behind; this one is the difference between advertising
// last week's price and this week's.
import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { runPricePush } from '@/modules/google-shopping-for-shop/lib/push/run'
import { runPushReconcile } from '@/modules/google-shopping-for-shop/lib/push/reconcile'

// Vercel appends `Authorization: Bearer $CRON_SECRET` to its own cron requests.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse('CRON_SECRET is not configured', 503)
  if (request.headers.get('authorization') !== `Bearer ${secret}`) return errorResponse('Unauthorized', 401)

  // Caught and reported: an uncaught throw reaches the cron log as a bare "HTTP 500".
  try {
    // minGapSeconds 0: being on an hourly timer is its own debounce, and a run
    // held off here would leave a queue sitting until the next hour.
    let push: unknown = { status: 'not-run' }
    try {
      push = await runPricePush({ minGapSeconds: 0, sweep: true })
    } catch (err) {
      console.error('[google-shopping] hourly live update run failed:', err)
      push = { status: 'error' }
    }

    // Its own try. The send has already happened by the time this runs, and a
    // comparison Google will not answer must never throw that away.
    let reconcile: unknown = { status: 'not-run' }
    try {
      reconcile = await runPushReconcile()
    } catch (err) {
      console.error('[google-shopping] hourly live update check failed:', err)
      reconcile = { status: 'error' }
    }

    return NextResponse.json({ ok: true, push, reconcile })
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'the live update run failed', 500)
  }
}
