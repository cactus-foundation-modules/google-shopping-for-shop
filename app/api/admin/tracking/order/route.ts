// GET /api/m/google-shopping-for-shop/admin/tracking/order?orderId=
//
// One attributed sale, opened from the live feed: which listing the shopper
// landed on, how long they took to buy, and what they actually bought.
//
// Behind the shop's own products permission, like every other route in this
// module. An order id that was never attributed answers 404 rather than an
// empty shape - there is a difference between "this sale did not come from
// Google" and "this sale came from Google and led to nothing", and a screen
// that drew them the same would be lying about one of them.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { readAttributedOrder } from '@/modules/google-shopping-for-shop/lib/click-tracking/report'

const Query = z.object({ orderId: z.string().trim().min(1).max(64) })

export async function GET(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error

  const parsed = Query.safeParse({ orderId: new URL(request.url).searchParams.get('orderId') ?? '' })
  if (!parsed.success) return NextResponse.json({ error: 'No order was named' }, { status: 400 })

  try {
    const order = await readAttributedOrder(parsed.data.orderId)
    if (!order) return NextResponse.json({ error: 'Nothing here links that order to a Google click.' }, { status: 404 })
    return NextResponse.json({ order }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[google-shopping] attributed order read failed:', error)
    return NextResponse.json({ error: 'Could not read that sale. Try again in a moment.' }, { status: 500 })
  }
}
