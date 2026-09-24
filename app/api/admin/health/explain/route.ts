// POST /api/m/google-shopping-for-shop/admin/health/explain
// Google's own words about ONE item's problems, fetched when the owner asks.
//
// One Merchant API call per press, never in bulk, never on page load, never in
// the cron. The answer is cached onto the rows it explains, so a second press
// is free until the daily check sees the issue again.
//
// Read-only, and gated `shop.products` like the rest of Health: it fetches an
// explanation and writes nothing but that explanation onto rows Google already
// put there.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { explainItem } from '@/modules/google-shopping-for-shop/lib/health/explain'

const Body = z.object({
  // A feed item id - the variation's own product id, or a standalone
  // product's. Bounded because it is composed into a resource name.
  itemId: z.string().trim().min(1).max(200),
  // Skips the cache: what the "ask Google again" link sends.
  force: z.boolean().optional(),
})

export async function POST(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Which item?' }, { status: 400 })
  }

  try {
    const outcome = await explainItem(parsed.data.itemId, { force: parsed.data.force ?? false })
    // 200 for every outcome including "unavailable": "we could not find out"
    // and "Google had nothing to say" are answers the screen has words for,
    // and a 4xx would have the browser draw them as a failed request.
    return NextResponse.json(outcome, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    // Only something genuinely unexpected reaches here - explainItem turns
    // every Google refusal into an outcome. The message is deliberately ours:
    // an unplanned throw is the one thing that could carry something we have
    // not vetted.
    console.error('[google-shopping] explain failed:', error)
    return NextResponse.json({ error: 'Could not ask Google about that item. Try again in a moment.' }, { status: 500 })
  }
}
