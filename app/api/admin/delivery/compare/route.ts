// POST /api/m/google-shopping-for-shop/admin/delivery/compare
// Asks Merchant Center what delivery settings it holds and lines them up
// against this site's. One read, no writes, nothing sent.
//
// A POST rather than a GET because it picks up the telephone to Google and
// leaves the answer behind in our own row - neither of which is something a
// link preview or a browser refresh should set off.
import { NextResponse } from 'next/server'
import { requireShopUser } from '@/modules/shop/lib/access'
import { compareDeliverySettings } from '@/modules/google-shopping-for-shop/lib/delivery/compare'

export async function POST() {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error

  try {
    // 'unavailable' comes back as a 200 on purpose: "we could not find out, and
    // here is why" is an answer, not a failure, and the tab draws it very
    // differently from a red box.
    return NextResponse.json(await compareDeliverySettings())
  } catch (error) {
    console.error('[google-shopping] delivery comparison failed:', error)
    return NextResponse.json({ error: 'Could not compare your delivery settings with Google. Try again in a moment.' }, { status: 500 })
  }
}
