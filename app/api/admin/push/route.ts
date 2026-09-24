// GET   /api/m/google-shopping-for-shop/admin/push
// PATCH /api/m/google-shopping-for-shop/admin/push
//
// The live price and stock updates panel: what it shows, and its own switches.
//
// The GET reads our own tables only, so opening the Health tab costs nothing of
// the account's Merchant API quota - the same rule the rest of that tab
// follows. Finding out what Merchant Center holds is the setup check next door.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { clearAlert } from '@/lib/notifications/alerts'
import { ALERT_KEYS } from '@/modules/google-shopping-for-shop/lib/health/alerts'
import { updateGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { readLiveUpdatesView } from '@/modules/google-shopping-for-shop/lib/push/view'

export async function GET() {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error

  try {
    const liveUpdates = await readLiveUpdatesView()
    return NextResponse.json({ liveUpdates }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[google-shopping] live updates view failed:', error)
    return NextResponse.json({ error: 'Could not read the live update figures. Try again in a moment.' }, { status: 500 })
  }
}

// shop.manage rather than shop.products: this decides whether the site writes
// to somebody's advertising account, which is not a product job.
const Body = z.object({
  enabled: z.boolean().optional(),
  /** Seconds. Coerced and clamped in settings.ts - a hand-typed 5 becomes 30
   *  rather than being refused, because a refusal here helps nobody. */
  debounceSeconds: z.number().int().min(0).max(100_000).optional(),
  /** Items per hourly check. 0 switches the check off. */
  reconcileSample: z.number().int().min(0).max(1000).optional(),
}).refine((body) => Object.values(body).some((value) => value !== undefined), { message: 'Nothing to change.' })

export async function PATCH(request: NextRequest) {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Nothing to change.' }, { status: 400 })

  await updateGsfSettings({
    ...(parsed.data.enabled === undefined ? {} : { pricePushEnabled: parsed.data.enabled }),
    ...(parsed.data.debounceSeconds === undefined ? {} : { pushDebounceSeconds: parsed.data.debounceSeconds }),
    ...(parsed.data.reconcileSample === undefined ? {} : { pushReconcileSample: parsed.data.reconcileSample }),
  })

  // Switching it off takes down whatever notice is already showing, now rather
  // than never. Nothing else clears this alert once the worker has stopped
  // running, so without this an owner could silence the sending and go on
  // looking at its last complaint for ever - the same hole the delivery sync
  // switch had to close.
  if (parsed.data.enabled === false) await clearAlert(ALERT_KEYS.pricePush)

  try {
    const liveUpdates = await readLiveUpdatesView()
    return NextResponse.json({ liveUpdates }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[google-shopping] live updates view failed after a change:', error)
    return NextResponse.json({ error: 'That was saved, but the panel could not be redrawn. Reload the tab.' }, { status: 500 })
  }
}
