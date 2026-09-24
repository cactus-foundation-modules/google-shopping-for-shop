// /api/m/google-shopping-for-shop/admin/feed-rules
//   GET                       the rules in list order, and what the builder needs to offer
//   POST   { draft }          adds a rule at the end of the list
//   PATCH  { id, draft }      replaces a rule (switching one on or off is a PATCH too)
//   DELETE ?id=...            deletes a rule
// Every write is logged in the workbench change log and can be undone.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { listCategories } from '@/modules/shop/lib/db/catalogue'
import { hasAttributeProvider, listLabelAttributes } from '@/modules/google-shopping-for-shop/lib/product-labels'
import { createFeedRule, deleteFeedRule, getRangeAttributeId, listFeedRules, updateFeedRule } from '@/modules/google-shopping-for-shop/lib/feed-rules/store'
import { checkDraft } from '@/modules/google-shopping-for-shop/lib/feed-rules/validate'
import { categoryOptions } from '@/modules/google-shopping-for-shop/lib/feed-rules/category-options'
import { changedBy } from '@/modules/google-shopping-for-shop/lib/workbench-actor'

const noStore = { 'Cache-Control': 'no-store' }

export async function GET() {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const [rules, attributes, categories, rangeAttributeId] = await Promise.all([
    listFeedRules(),
    listLabelAttributes(),
    listCategories(),
    getRangeAttributeId(),
  ])
  return NextResponse.json({
    rules,
    attributes,
    attributesAvailable: hasAttributeProvider(),
    categories: categoryOptions(categories),
    rangeAttributeId,
  }, { headers: noStore })
}

export async function POST(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const body: unknown = await request.json().catch(() => null)
  const check = await checkDraft(typeof body === 'object' && body !== null && 'draft' in body ? body.draft : null)
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 })
  try {
    const result = await createFeedRule(check.draft, changedBy(gate.user))
    return NextResponse.json(result)
  } catch (error) {
    console.error('[google-shopping] rule create failed:', error)
    return NextResponse.json({ error: 'Could not save the rule. Nothing was changed.' }, { status: 500 })
  }
}

const PatchBody = z.object({ id: z.string().min(1).max(100), draft: z.unknown() })

export async function PATCH(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const parsed = PatchBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Missing rule' }, { status: 400 })
  const check = await checkDraft(parsed.data.draft)
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 })
  try {
    const outcome = await updateFeedRule(parsed.data.id, check.draft, changedBy(gate.user))
    if (outcome.status === 'not-found') return NextResponse.json({ error: 'That rule has been deleted since this page loaded.' }, { status: 404 })
    return NextResponse.json({ rule: outcome.rule, changeId: outcome.changeId })
  } catch (error) {
    console.error('[google-shopping] rule update failed:', error)
    return NextResponse.json({ error: 'Could not save the rule. Nothing was changed.' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const id = new URL(request.url).searchParams.get('id')
  if (!id || id.length > 100) return NextResponse.json({ error: 'Missing rule' }, { status: 400 })
  try {
    const outcome = await deleteFeedRule(id, changedBy(gate.user))
    if (outcome.status === 'not-found') return NextResponse.json({ error: 'That rule has already been deleted.' }, { status: 404 })
    return NextResponse.json(outcome)
  } catch (error) {
    console.error('[google-shopping] rule delete failed:', error)
    return NextResponse.json({ error: 'Could not delete the rule. Nothing was changed.' }, { status: 500 })
  }
}
