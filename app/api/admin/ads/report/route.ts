// GET /api/m/google-shopping-for-shop/admin/ads/report?range=30
//
// What the ads cost over a range, and what that came to per sale this site can
// point at. Reads our own tables only - fetching from Google is the button on
// the Health tab, so opening Reports costs no quota.
//
// `shop.products`, like the rest of the Reports tab: this is a figure to look
// at, not a switch to throw.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { readAdsReport } from '@/modules/google-shopping-for-shop/lib/google-ads/report'
import { REPORT_RANGES } from '@/modules/google-shopping-for-shop/lib/performance/types'

// Every field falls back rather than failing: a hand-edited or stale link
// should open the tab, not an error page.
const Query = z.object({
  range: z.enum(REPORT_RANGES).catch('30'),
  // Checked properly by resolveRange, which refuses anything that is not a real
  // calendar day. The cap here only stops a paste of half a page.
  from: z.string().trim().max(10).catch(''),
  to: z.string().trim().max(10).catch(''),
})

export async function GET(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error

  const params = new URL(request.url).searchParams
  const query = Query.parse({
    range: params.get('range') ?? '30',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
  })

  try {
    const report = await readAdsReport({
      range: query.range,
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
    })
    return NextResponse.json({ report }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[google-shopping] Google Ads report read failed:', error)
    return NextResponse.json({ error: 'Could not read what your ads cost. Try again in a moment.' }, { status: 500 })
  }
}
