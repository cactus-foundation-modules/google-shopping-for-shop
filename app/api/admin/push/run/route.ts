// POST /api/m/google-shopping-for-shop/admin/push/run  { confirm: true }
// Sends whatever is waiting, now.
//
// The "do not wait for the timer" button. It passes a minimum gap of zero, so
// it is not held off by the debounce - but it still has to WIN the claim, which
// means two owners pressing it at the same moment produce one send between
// them, not two.
//
// `shop.manage`: it writes to an advertising account.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { loadChangeLogHandlers } from '@/modules/google-shopping-for-shop/lib/change-log-handlers'
import { changedBy } from '@/modules/google-shopping-for-shop/lib/workbench-actor'
import { runPricePush } from '@/modules/google-shopping-for-shop/lib/push/run'
import { readLiveUpdatesView } from '@/modules/google-shopping-for-shop/lib/push/view'

loadChangeLogHandlers()

const Body = z.object({
  confirm: z.literal(true),
  /** Also take out anything Merchant Center is holding that the feed no longer
   *  carries. What the hourly run does; offered here so an owner who has just
   *  changed a feed rule does not have to wait for it. */
  sweep: z.boolean().optional(),
})

export async function POST(request: NextRequest) {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Nothing was sent: this needs to be confirmed first.' }, { status: 400 })

  try {
    const outcome = await runPricePush({
      minGapSeconds: 0,
      actor: changedBy(gate.user),
      ...(parsed.data.sweep ? { sweep: true } : {}),
    })
    const liveUpdates = await readLiveUpdatesView()
    return NextResponse.json({ outcome, liveUpdates })
  } catch (error) {
    console.error('[google-shopping] live updates run failed:', error)
    return NextResponse.json(
      { error: 'Could not send your latest prices to Google. The Health panel shows what happened.' },
      { status: 500 },
    )
  }
}
