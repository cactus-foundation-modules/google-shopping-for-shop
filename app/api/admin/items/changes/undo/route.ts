// POST /api/m/google-shopping-for-shop/admin/items/changes/undo  { batchId }
// Puts one recorded title template save back. Items edited since are left as
// they are and counted, never overwritten (lib/title-template-changes.ts).
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { undoTitleTemplateBatch } from '@/modules/google-shopping-for-shop/lib/title-template-changes'
import { changedBy } from '@/modules/google-shopping-for-shop/lib/workbench-actor'

const Body = z.object({ batchId: z.string().min(1).max(100) })

export async function POST(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Missing change id' }, { status: 400 })

  try {
    const outcome = await undoTitleTemplateBatch(parsed.data.batchId, changedBy(gate.user))
    if (outcome.status === 'not-found') return NextResponse.json({ error: 'That change is no longer in the log.' }, { status: 404 })
    if (outcome.status === 'already-undone') return NextResponse.json({ error: 'That change has already been undone.' }, { status: 409 })
    return NextResponse.json(outcome)
  } catch (error) {
    console.error('[google-shopping] undo failed:', error)
    return NextResponse.json({ error: 'Could not undo that change. Nothing was altered.' }, { status: 500 })
  }
}
