// POST /api/m/google-shopping-for-shop/admin/change-log/undo  { id }
// Puts one change log entry back through its area's own undo. Anything
// changed since is left as it is and counted, never overwritten.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { undoChange } from '@/modules/google-shopping-for-shop/lib/change-log'
import { loadChangeLogHandlers } from '@/modules/google-shopping-for-shop/lib/change-log-handlers'
import { changedBy } from '@/modules/google-shopping-for-shop/lib/workbench-actor'

loadChangeLogHandlers()

const Body = z.object({ id: z.string().min(1).max(100) })

export async function POST(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Missing change id' }, { status: 400 })

  try {
    const outcome = await undoChange(parsed.data.id, changedBy(gate.user))
    if (outcome.status === 'not-found') return NextResponse.json({ error: 'That change is no longer in the log.' }, { status: 404 })
    if (outcome.status === 'already-undone') return NextResponse.json({ error: 'That change has already been undone.' }, { status: 409 })
    if (outcome.status === 'not-undoable') return NextResponse.json({ error: 'That change cannot be undone from here.' }, { status: 409 })
    return NextResponse.json(outcome)
  } catch (error) {
    console.error('[google-shopping] change log undo failed:', error)
    return NextResponse.json({ error: 'Could not undo that change. Nothing was altered.' }, { status: 500 })
  }
}
