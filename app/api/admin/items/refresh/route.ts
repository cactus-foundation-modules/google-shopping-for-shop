// POST /api/m/google-shopping-for-shop/admin/items/refresh
// Pulls a fresh Google Merchant snapshot when Merchant API credentials are
// configured: match state, benchmark prices and the item issues Google is
// reporting, all off one report query.
import { NextResponse } from 'next/server'
import { requireShopUser } from '@/modules/shop/lib/access'
import { refreshMerchantMatchStatus } from '@/modules/google-shopping-for-shop/lib/merchant-reports'

export async function POST() {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error
  try {
    const result = await refreshMerchantMatchStatus()
    return NextResponse.json({
      checkedAt: result.checkedAt.toISOString(),
      products: result.products,
      matched: result.matched,
      issues: result.issues,
      disapprovedItems: result.disapprovedItems,
      // True when Google answered with no rows at all. The counts above are
      // null then, and the screen says Google had nothing to say rather than
      // claiming a clean bill of health.
      issuesSkipped: result.issuesSkipped,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not refresh Merchant Center match status' },
      { status: 400 },
    )
  }
}
