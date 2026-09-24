// POST /api/m/google-shopping-for-shop/admin/feed-rules/reorder  { ids }
// Puts the rules in the order given. The list must name every rule once; an
// order from a page that has gone stale is refused rather than guessed at.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { reorderFeedRules } from '@/modules/google-shopping-for-shop/lib/feed-rules/store'
import { changedBy } from '@/modules/google-shopping-for-shop/lib/workbench-actor'

const Body = z.object({ ids: z.array(z.string().min(1).max(100)).max(1000) })

export async function POST(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Missing rule order' }, { status: 400 })
  try {
    const outcome = await reorderFeedRules(parsed.data.ids, changedBy(gate.user))
    if (outcome.status === 'stale') return NextResponse.json({ error: 'The rules have changed since this page loaded. Reload and try again.' }, { status: 409 })
    return NextResponse.json({ rules: outcome.rules, changeId: outcome.changeId })
  } catch (error) {
    console.error('[google-shopping] rule reorder failed:', error)
    return NextResponse.json({ error: 'Could not reorder the rules. Nothing was changed.' }, { status: 500 })
  }
}
