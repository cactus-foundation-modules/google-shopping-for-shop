// GET /api/m/google-shopping-for-shop/cron/match-status
// Daily Merchant Center match refresh, so match history dates a change to the
// day it happened rather than to whenever someone last pressed Refresh.
import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { canRefreshMerchantMatchStatus, refreshMerchantMatchStatus } from '@/modules/google-shopping-for-shop/lib/merchant-reports'
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'

// Vercel appends `Authorization: Bearer $CRON_SECRET` to its own cron requests.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse('CRON_SECRET is not configured', 503)
  if (request.headers.get('authorization') !== `Bearer ${secret}`) return errorResponse('Unauthorized', 401)

  // Caught and reported: an uncaught throw reaches the cron log as a bare "HTTP 500".
  try {
    // A shop that has not linked Merchant Center has nothing to check - not a failure.
    const settings = await getGsfSettings()
    if (!settings.merchantId || !canRefreshMerchantMatchStatus()) {
      return NextResponse.json({ ok: true, skipped: 'Merchant Center is not linked' })
    }
    const result = await refreshMerchantMatchStatus()
    return NextResponse.json({ ok: true, checkedAt: result.checkedAt.toISOString(), products: result.products, matched: result.matched })
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'the match refresh failed', 500)
  }
}
