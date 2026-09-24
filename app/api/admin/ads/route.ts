// GET   /api/m/google-shopping-for-shop/admin/ads
// PATCH /api/m/google-shopping-for-shop/admin/ads
//
// The Google Ads panel: what it shows, and its own switches.
//
// The GET reads our own tables and the environment only, so opening the Health
// tab costs nothing of the account's Google Ads quota - the same rule the rest
// of that tab follows. Finding out what Google thinks is the check next door.
//
// It never returns a credential. `env` is a map of names to true or false and
// nothing else: not a value, not a masked value, not a length.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { clearAlert } from '@/lib/notifications/alerts'
import { ALERT_KEYS } from '@/modules/google-shopping-for-shop/lib/health/alerts'
import { updateGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { readAdsView } from '@/modules/google-shopping-for-shop/lib/google-ads/view'

export async function GET() {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error

  try {
    const ads = await readAdsView()
    return NextResponse.json({ ads }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[google-shopping] Google Ads view failed:', error)
    return NextResponse.json({ error: 'Could not read the Google Ads figures. Try again in a moment.' }, { status: 500 })
  }
}

// shop.manage rather than shop.products throughout: these decide whether the
// site reads and writes somebody's advertising account, which is not a product
// job.
const Body = z.object({
  enabled: z.boolean().optional(),
  spendImportEnabled: z.boolean().optional(),
  uploadEnabled: z.boolean().optional(),
  // Clamped server-side; the bounds here only stop a nonsense paste reaching
  // the column.
  backfillDays: z.number().int().min(1).max(730).optional(),
  // 0 is a real answer: keep everything.
  retentionDays: z.number().int().min(0).max(3_650).optional(),
}).refine((body) => Object.values(body).some((value) => value !== undefined), { message: 'Nothing to change.' })

export async function PATCH(request: NextRequest) {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Nothing to change.' }, { status: 400 })
  const body = parsed.data

  await updateGsfSettings({
    ...(body.enabled === undefined ? {} : { adsEnabled: body.enabled }),
    ...(body.spendImportEnabled === undefined ? {} : { adsSpendImportEnabled: body.spendImportEnabled }),
    ...(body.uploadEnabled === undefined ? {} : { adsConversionUploadEnabled: body.uploadEnabled }),
    ...(body.backfillDays === undefined ? {} : { adsSpendBackfillDays: body.backfillDays }),
    ...(body.retentionDays === undefined ? {} : { adsSpendRetentionDays: body.retentionDays }),
  })

  // Switching either switch off takes down whatever notice is already showing,
  // now rather than never. Nothing else clears this alert once the upload has
  // stopped running, so without it an owner could silence the sending and go on
  // looking at its last complaint for ever - the same hole the delivery sync
  // and the price push both had to close.
  if (body.enabled === false || body.uploadEnabled === false) await clearAlert(ALERT_KEYS.adsUpload)

  try {
    const ads = await readAdsView()
    return NextResponse.json({ ads }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[google-shopping] Google Ads view failed after a change:', error)
    return NextResponse.json({ error: 'That was saved, but the panel could not be redrawn. Reload the tab.' }, { status: 500 })
  }
}
