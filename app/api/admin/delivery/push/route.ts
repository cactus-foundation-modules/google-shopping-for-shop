// POST /api/m/google-shopping-for-shop/admin/delivery/push  { confirm: true }
// Sends this site's delivery charges to Merchant Center.
//
// The one route in this module that WRITES to Google. Three things guard it:
//
//   - `confirm` must be true in the body. A push cannot happen by a route
//     being called, only by somebody having said yes to the preview.
//   - `fingerprint` must be the one that preview handed out. Otherwise the
//     delivery charges could change between the looking and the pressing, and
//     the owner would confirm one payload and send another.
//   - the mapping must not be blocked. Anything this site cannot express
//     faithfully stops the send rather than being trimmed to fit.
//   - `shop.manage`, not `shop.products`. Reading the tab is a product job;
//     changing what an advertising account charges customers is not.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { loadChangeLogHandlers } from '@/modules/google-shopping-for-shop/lib/change-log-handlers'
import { pushDeliverySettings } from '@/modules/google-shopping-for-shop/lib/delivery/push'
import { changedBy } from '@/modules/google-shopping-for-shop/lib/workbench-actor'

// So the push's own undo handler is registered before anything can be undone.
loadChangeLogHandlers()

const Body = z.object({
  /** Literal true. An absent or false confirmation is a refusal, not a default. */
  confirm: z.literal(true),
  /** The preview's fingerprint of what would be sent, echoed back. */
  fingerprint: z.string().min(1).max(64),
})

export async function POST(request: NextRequest) {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Nothing was sent: this needs to be confirmed first.' }, { status: 400 })
  }

  try {
    const outcome = await pushDeliverySettings(changedBy(gate.user), parsed.data.fingerprint)
    // Every refusal is a 200 with its own status and its own sentence. They
    // are answers - "there is nothing to send", "Google moved under us", "this
    // has changed since you looked" - and the tab has something different to
    // say about each.
    return NextResponse.json(outcome)
  } catch (error) {
    console.error('[google-shopping] delivery push failed:', error)
    // Deliberately not "nothing was changed". The send and the record of it
    // are written together, and a failure here almost always means the send
    // itself was refused - but "almost always" is not something to promise an
    // owner about their own advertising account. Compare, and see.
    return NextResponse.json(
      { error: 'Could not send your delivery settings to Google. Compare them again to see what Merchant Center holds now.' },
      { status: 500 },
    )
  }
}
