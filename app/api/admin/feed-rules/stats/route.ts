// GET /api/m/google-shopping-for-shop/admin/feed-rules/stats
// The catalogue-side half of the Feed Rules tab: how many items each rule
// matches today, the option names a rule can ask about, and the suppliers and
// brands already in use, for the value boxes to suggest. Read from the
// workbench's held catalogue, so slow only the first time.
import { NextResponse } from 'next/server'
import { getSiteUrlOrNull } from '@/lib/config/env'
import { requireShopUser } from '@/modules/shop/lib/access'
import { loadWorkbench } from '@/modules/google-shopping-for-shop/lib/workbench-data'
import { ensureAttributeFacts } from '@/modules/google-shopping-for-shop/lib/feed-rules/facts'
import { countRuleMatches } from '@/modules/google-shopping-for-shop/lib/feed-rules/preview'
import { distinctTextFacts } from '@/modules/google-shopping-for-shop/lib/feed-rules/suggestions'

export async function GET() {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const siteUrl = getSiteUrlOrNull()
  if (!siteUrl) return NextResponse.json({ error: 'Site URL is not configured' }, { status: 500 })
  try {
    const state = await loadWorkbench(siteUrl)
    const run = state.rules
    // Switched-off rules are counted too, so the screen can say what switching
    // one on would do before it is switched on - which means reading the
    // attributes only they name.
    await ensureAttributeFacts(run, run.rules)
    const counts = countRuleMatches(run.rules, run.subjects, run.outcomes)
    return NextResponse.json({
      counts: Object.fromEntries([...counts].map(([id, count]) => [id, count.matched])),
      wouldExclude: Object.fromEntries([...counts].map(([id, count]) => [id, count.wouldExclude])),
      outOfFeed: state.summary.outOfFeed,
      inFeed: state.summary.total,
      catalogue: run.subjects.length,
      optionNames: run.optionNames,
      suggestions: {
        supplier: distinctTextFacts(run.subjects, 'supplier'),
        brand: distinctTextFacts(run.subjects, 'brand'),
      },
      readAt: state.catalogueReadAt.toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[google-shopping] rule stats failed:', error)
    return NextResponse.json({ error: 'Could not read the catalogue. Try again in a moment.' }, { status: 500 })
  }
}
