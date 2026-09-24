// GET    /api/m/google-shopping-for-shop/admin/push/setup   what would happen
// POST   /api/m/google-shopping-for-shop/admin/push/setup   { confirm: true }
// DELETE /api/m/google-shopping-for-shop/admin/push/setup   { confirm: true }
//
// Creating the small extra feed at Merchant Center, and pointing the main feed
// at it. The second of the two places in this module that writes to somebody's
// advertising account, so it is guarded the same way the delivery push is:
//
//   - the GET is a preview and only ever reads;
//   - the POST needs `confirm: true` in the body, so nothing can happen by the
//     route merely being called;
//   - both writes need `shop.manage`, not `shop.products`.
//
// There is deliberately no "delete the feed" here. The DELETE takes the LINK
// out and leaves the feed itself where it is: unlinking is reversible with one
// press, and deleting would throw away whatever Merchant Center still holds
// from it in a step nothing can undo.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { loadChangeLogHandlers } from '@/modules/google-shopping-for-shop/lib/change-log-handlers'
import { changedBy } from '@/modules/google-shopping-for-shop/lib/workbench-actor'
import { planSetup, runSetup, unlinkSetup } from '@/modules/google-shopping-for-shop/lib/push/setup'
import { readLiveUpdatesView } from '@/modules/google-shopping-for-shop/lib/push/view'

// So the link's own undo handler is registered before anything can be undone.
loadChangeLogHandlers()

const Body = z.object({ confirm: z.literal(true) })

export async function GET() {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error

  try {
    const plan = await planSetup()
    return NextResponse.json({ plan }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[google-shopping] live updates setup preview failed:', error)
    return NextResponse.json({ error: 'Could not ask Merchant Center what it holds. Try again in a moment.' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Nothing was done: this needs to be confirmed first.' }, { status: 400 })

  try {
    const outcome = await runSetup(changedBy(gate.user))
    // Every refusal is a 200 with its own status and its own sentence: they are
    // answers, not errors, and the panel says something different about each.
    const liveUpdates = await readLiveUpdatesView()
    return NextResponse.json({ outcome, liveUpdates })
  } catch (error) {
    console.error('[google-shopping] live updates setup failed:', error)
    return NextResponse.json(
      { error: 'Could not set the live updates up at Merchant Center. Press Check again to see what is there now.' },
      { status: 500 },
    )
  }
}

export async function DELETE(request: NextRequest) {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Nothing was done: this needs to be confirmed first.' }, { status: 400 })

  try {
    const outcome = await unlinkSetup(changedBy(gate.user))
    const liveUpdates = await readLiveUpdatesView()
    return NextResponse.json({ outcome, liveUpdates })
  } catch (error) {
    console.error('[google-shopping] live updates unlink failed:', error)
    return NextResponse.json(
      { error: 'Could not unlink the live updates at Merchant Center. Press Check again to see what is there now.' },
      { status: 500 },
    )
  }
}
