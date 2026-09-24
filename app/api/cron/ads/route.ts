// GET /api/m/google-shopping-for-shop/cron/ads
// The hourly Google Ads conversion upload.
//
// Separate from the daily 05:30 job and from the hourly price push, for two
// different reasons:
//
//   - It is not a daily thing. A sale confirmed at nine in the morning should
//     be at Google Ads by ten, not tomorrow: the account is bidding on these
//     figures, and a day's lag on a shop's best-selling week is a day of
//     bidding on last week.
//   - It talks to a DIFFERENT API with a different sign-in. Folding it into the
//     Merchant Center jobs would mean a shop with no Merchant Center key never
//     ran it, which is exactly the trap the daily job's early return sets.
//
// The spend fetch lives in the daily job instead: Google Ads publishes it about
// a day late and revises it afterwards, so asking hourly would spend
// twenty-four times the quota to learn the same thing.
import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { runConversionUpload } from '@/modules/google-shopping-for-shop/lib/google-ads/upload'

// Vercel appends `Authorization: Bearer $CRON_SECRET` to its own cron requests.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse('CRON_SECRET is not configured', 503)
  if (request.headers.get('authorization') !== `Bearer ${secret}`) return errorResponse('Unauthorized', 401)

  // Caught and reported: an uncaught throw reaches the cron log as a bare
  // "HTTP 500" with nothing in it.
  try {
    const upload = await runConversionUpload()
    return NextResponse.json({ ok: true, upload })
  } catch (err) {
    console.error('[google-shopping] hourly Google Ads upload failed:', err)
    return errorResponse(err instanceof Error ? err.message : 'the Google Ads upload failed', 500)
  }
}
