// POST /api/m/google-shopping-for-shop/admin/ads/run  { job: 'spend' | 'upload' }
//
// The "do not wait for the timer" buttons.
//
//   spend   fetches what the ads cost, now. Read-only at Google's end.
//   upload  sends whatever sales are waiting, now. It still has to WIN the
//           claim, so two owners pressing it at the same moment produce one
//           send between them rather than two.
//
// `shop.manage`: one reads an advertising account and the other writes to it.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { isAdmin } from '@/lib/permissions/check'
import { changedBy } from '@/modules/google-shopping-for-shop/lib/workbench-actor'
import { importAdsSpend } from '@/modules/google-shopping-for-shop/lib/google-ads/spend-import'
import { runConversionUpload } from '@/modules/google-shopping-for-shop/lib/google-ads/upload'
import { readAdsView } from '@/modules/google-shopping-for-shop/lib/google-ads/view'

const Body = z.object({ job: z.enum(['spend', 'upload']) })

export async function POST(request: NextRequest) {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Nothing to run.' }, { status: 400 })

  try {
    if (parsed.data.job === 'spend') {
      const outcome = await importAdsSpend()
      const ads = await readAdsView({ isAdmin: isAdmin(gate.user) })
      return NextResponse.json({ outcome, ads }, { headers: { 'Cache-Control': 'no-store' } })
    }
    const outcome = await runConversionUpload({ actor: changedBy(gate.user) })
    const ads = await readAdsView({ isAdmin: isAdmin(gate.user) })
    return NextResponse.json({ outcome, ads }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[google-shopping] Google Ads run failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'That did not finish. The Health panel shows what happened.' },
      { status: 502 },
    )
  }
}
