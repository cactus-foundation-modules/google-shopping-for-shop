// POST /api/m/google-shopping-for-shop/admin/feed-rules/preview  { draft, id? }
// What saving this rule would do, before it is saved: how many items it
// matches, which would change and how. Run over the catalogue the workbench
// already holds, so it answers in milliseconds once the list has been read.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSiteUrlOrNull } from '@/lib/config/env'
import { requireShopUser } from '@/modules/shop/lib/access'
import { loadWorkbench } from '@/modules/google-shopping-for-shop/lib/workbench-data'
import { checkDraft } from '@/modules/google-shopping-for-shop/lib/feed-rules/validate'
import { ensureAttributeFacts } from '@/modules/google-shopping-for-shop/lib/feed-rules/facts'
import { previewRule } from '@/modules/google-shopping-for-shop/lib/feed-rules/preview'

const Body = z.object({ id: z.string().min(1).max(100).nullable().optional(), draft: z.unknown() })

export async function POST(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const siteUrl = getSiteUrlOrNull()
  if (!siteUrl) return NextResponse.json({ error: 'Site URL is not configured' }, { status: 500 })
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Missing rule' }, { status: 400 })
  const check = await checkDraft(parsed.data.draft)
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 })

  try {
    const started = performance.now()
    const state = await loadWorkbench(siteUrl)
    const run = state.rules
    const editingId = parsed.data.id ?? null
    if (editingId && !run.rules.some((rule) => rule.id === editingId)) {
      return NextResponse.json({ error: 'That rule has been deleted since this page loaded.' }, { status: 404 })
    }
    await ensureAttributeFacts(run, [check.draft])
    const preview = previewRule(run.rules, check.draft, editingId, run.subjects, run.outcomes)
    return NextResponse.json({ preview, serverMs: Math.round(performance.now() - started) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[google-shopping] rule preview failed:', error)
    return NextResponse.json({ error: 'Could not work out what that rule would do. Try again in a moment.' }, { status: 500 })
  }
}
