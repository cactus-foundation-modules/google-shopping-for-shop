// GET/PATCH /api/m/google-shopping-for-shop/admin/tracking
//
// The live half of the Reports tab: what this site counted for itself, as
// against what Google published. Reads our own tables only - there is nothing
// to ask Google about here - so the 20-second poll behind it costs a couple of
// indexed queries and none of the account's Merchant API quota.
//
// The PATCH is the three switches that belong to this screen: tag the feed's
// links, count the landings, and how long to keep them. Same pattern as the
// Reports settings next door - a setting lives where it is used.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { readLiveReport } from '@/modules/google-shopping-for-shop/lib/click-tracking/report'
import { REPORT_RANGES } from '@/modules/google-shopping-for-shop/lib/performance/types'
import { updateGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'

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
    const report = await readLiveReport({
      range: query.range,
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      // This admin request came through the same front door a shopper's does,
      // so the header being here is evidence the whole site is proxied. It is
      // the only cheap way to notice a misconfiguration that would otherwise
      // show up as nothing more than figures that look a bit low.
      viaCloudflare: request.headers.get('cf-connecting-ip') !== null,
    })
    return NextResponse.json({ report }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[google-shopping] live tracking read failed:', error)
    return NextResponse.json({ error: "Could not read this site's own figures. Try again in a moment." }, { status: 500 })
  }
}

const PatchBody = z.object({
  linkTaggingEnabled: z.boolean().optional(),
  trackingEnabled: z.boolean().optional(),
  // 0 is a real answer: keep everything. Clamped again server-side; the bounds
  // here only stop a nonsense paste reaching the column.
  retentionDays: z.number().int().min(0).max(3_650).optional(),
})

export async function PATCH(request: NextRequest) {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  const parsed = PatchBody.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid settings' }, { status: 400 })
  const body = parsed.data

  await updateGsfSettings({
    linkTaggingEnabled: body.linkTaggingEnabled,
    clickTrackingEnabled: body.trackingEnabled,
    clickRetentionDays: body.retentionDays,
  })

  const report = await readLiveReport({ range: '30' })
  return NextResponse.json({ report }, { headers: { 'Cache-Control': 'no-store' } })
}
