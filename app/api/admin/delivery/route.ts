// GET /api/m/google-shopping-for-shop/admin/delivery
// What this site would send Merchant Center, and the last comparison it made.
//
// Reads our own tables and our own delivery module only. Asking Google what it
// holds is the Compare button next door, so opening the tab costs nothing of
// the account's Merchant API quota - the same rule the Health tab follows.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { getGsfSettings, updateGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { clearAlert } from '@/lib/notifications/alerts'
import { ALERT_KEYS } from '@/modules/google-shopping-for-shop/lib/health/alerts'
import { buildDeliveryPlan } from '@/modules/google-shopping-for-shop/lib/delivery/plan'
import { readDeliveryState } from '@/modules/google-shopping-for-shop/lib/delivery/state'
import type { DeliveryTabView } from '@/modules/google-shopping-for-shop/lib/delivery/view'
import { toTabView } from '@/modules/google-shopping-for-shop/lib/delivery/view'

export async function GET() {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error

  try {
    // withCoverage: the preview is the one place somebody decides whether to
    // send, so it is the one place worth a pass over the catalogue to say how
    // many products would end up with no delivery price at all.
    const [plan, state, settings] = await Promise.all([
      buildDeliveryPlan({ withCoverage: true }),
      readDeliveryState(),
      getGsfSettings(),
    ])
    const view: DeliveryTabView = toTabView(plan, state, settings)
    return NextResponse.json({ delivery: view }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[google-shopping] delivery view failed:', error)
    return NextResponse.json({ error: 'Could not work out your delivery settings. Try again in a moment.' }, { status: 500 })
  }
}

// PATCH: the daily check's own switch. shop.manage rather than shop.products,
// because it decides whether this site raises alerts about somebody's
// advertising account - and it sits on this tab rather than in settings so the
// owner can turn it on at the moment they first send anything, which is the
// only moment it starts to mean something.
const PatchBody = z.object({ syncEnabled: z.boolean() })

export async function PATCH(request: NextRequest) {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  const parsed = PatchBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Nothing to change.' }, { status: 400 })

  await updateGsfSettings({ deliverySyncEnabled: parsed.data.syncEnabled })
  // Switching it off takes down whatever notice is already showing, now rather
  // than never: nothing else clears this alert once the check has stopped
  // running, so without this an owner could silence the check and go on
  // looking at its last complaint for ever.
  if (!parsed.data.syncEnabled) await clearAlert(ALERT_KEYS.deliverySync)

  const [plan, state, settings] = await Promise.all([
    buildDeliveryPlan({ withCoverage: true }),
    readDeliveryState(),
    getGsfSettings(),
  ])
  return NextResponse.json({ delivery: toTabView(plan, state, settings) })
}
