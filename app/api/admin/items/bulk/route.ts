// POST /api/m/google-shopping-for-shop/admin/items/bulk
// Sets or clears the feed-only title template on many items at once: a picked
// selection, or every item a workbench query matches.
//
// Two-step by design. `dryRun: true` answers what WOULD happen - how many items,
// how many hand-written templates it would replace, a few before/after titles -
// and the owner confirms against that. The real call then carries the count it
// was shown (`expectedCount`), and is refused if the query now matches a
// different number, so a list that moved underneath the owner (another person's
// edit, a catalogue re-read) is never acted on sight unseen.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSiteUrlOrNull } from '@/lib/config/env'
import { requireShopUser } from '@/modules/shop/lib/access'
import { GOOGLE_TITLE_MAX, renderTitleTemplate } from '@/modules/google-shopping-for-shop/lib/title-template-render'
import { applyTitleTemplateChanges } from '@/modules/google-shopping-for-shop/lib/title-template-changes'
import { loadWorkbench, type WorkbenchState } from '@/modules/google-shopping-for-shop/lib/workbench-data'
import { filterWorkbench } from '@/modules/google-shopping-for-shop/lib/workbench-filter'
import { parseWorkbenchQueryObject } from '@/modules/google-shopping-for-shop/lib/workbench-query'
import type { WorkbenchView } from '@/modules/google-shopping-for-shop/lib/workbench-view'
import { changedBy } from '@/modules/google-shopping-for-shop/lib/workbench-actor'

const Scope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ids'), ids: z.array(z.string().min(1).max(100)).min(1).max(50_000) }),
  z.object({ kind: z.literal('query'), query: z.record(z.unknown()), expectedCount: z.number().int().min(0).optional() }),
])

const Action = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('set-template'), template: z.string().trim().min(1, 'Type a template first').max(500) }),
  z.object({ kind: z.literal('clear-template') }),
])

const Body = z.object({ scope: Scope, action: Action, dryRun: z.boolean() })

type BulkAction = z.infer<typeof Action>

const SAMPLE_SIZE = 5

function targetsOf(state: WorkbenchState, scope: z.infer<typeof Scope>): WorkbenchView[] {
  if (scope.kind === 'query') {
    // Sorted as the list is, so the preview's samples are the rows at the top.
    const query = parseWorkbenchQueryObject(scope.query)
    return filterWorkbench(state.sorted(query.sort), query)
  }
  const targets: WorkbenchView[] = []
  for (const id of new Set(scope.ids)) {
    const view = state.byId.get(id)
    if (view) targets.push(view)
  }
  return targets
}

function templateAfter(action: BulkAction): string | null {
  return action.kind === 'set-template' ? action.template : null
}

function preview(targets: WorkbenchView[], action: BulkAction) {
  const next = templateAfter(action)
  let changing = 0
  let replacingOwn = 0
  let unknownTokenItems = 0
  let tooLongItems = 0
  const samples: Array<{ id: string; before: string; after: string; unknownTokens: string[] }> = []
  for (const view of targets) {
    if (view.titleTemplate === next) continue
    changing++
    if (view.titleTemplate !== null) replacingOwn++
    const rendered = renderTitleTemplate(next, view.context, view.originalTitle)
    if (rendered.unknownTokens.length > 0) unknownTokenItems++
    if (rendered.title.length > GOOGLE_TITLE_MAX) tooLongItems++
    if (samples.length < SAMPLE_SIZE) samples.push({ id: view.id, before: view.renderedTitle, after: rendered.title, unknownTokens: rendered.unknownTokens })
  }
  return { affected: targets.length, changing, unchanged: targets.length - changing, replacingOwn, unknownTokenItems, tooLongItems, samples }
}

function summaryOf(action: BulkAction, changed: number): string {
  const items = changed === 1 ? '1 item' : `${changed.toLocaleString('en-GB')} items`
  return action.kind === 'set-template' ? `Set "${action.template}" on ${items}` : `Cleared the template on ${items}`
}

export async function POST(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const siteUrl = getSiteUrlOrNull()
  if (!siteUrl) return NextResponse.json({ error: 'Site URL is not configured' }, { status: 500 })

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid bulk change' }, { status: 400 })
  const { scope, action, dryRun } = parsed.data

  let state: WorkbenchState
  try {
    state = await loadWorkbench(siteUrl)
  } catch (error) {
    console.error('[google-shopping] bulk load failed:', error)
    return NextResponse.json({ error: 'Could not read the catalogue. Try again in a moment.' }, { status: 500 })
  }

  const targets = targetsOf(state, scope)
  const outcome = preview(targets, action)
  if (dryRun) return NextResponse.json({ dryRun: true, ...outcome })

  if (scope.kind === 'query' && scope.expectedCount !== undefined && scope.expectedCount !== targets.length) {
    return NextResponse.json({
      error: `The list has moved since you looked: ${targets.length.toLocaleString('en-GB')} items match now, not ${scope.expectedCount.toLocaleString('en-GB')}. Nothing was changed - have another look and try again.`,
      affected: targets.length,
    }, { status: 409 })
  }
  if (outcome.changing === 0) return NextResponse.json({ dryRun: false, ...outcome, changed: 0, batchId: null })

  const next = templateAfter(action)
  try {
    const applied = await applyTitleTemplateChanges(
      targets.map((view) => ({ itemId: view.id, titleTemplate: next })),
      { summarise: (changed) => summaryOf(action, changed), createdBy: changedBy(gate.user) },
    )
    return NextResponse.json({ dryRun: false, ...outcome, changed: applied.changed, batchId: applied.batchId })
  } catch (error) {
    console.error('[google-shopping] bulk title change failed:', error)
    return NextResponse.json({ error: 'Could not save the titles. Nothing was changed.' }, { status: 500 })
  }
}
