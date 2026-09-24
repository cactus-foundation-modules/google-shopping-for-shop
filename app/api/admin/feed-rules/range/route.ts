// POST /api/m/google-shopping-for-shop/admin/feed-rules/range  { attributeId | null }
// Which product attribute the rules' Range field reads. Logged and undoable.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { listLabelAttributes } from '@/modules/google-shopping-for-shop/lib/product-labels'
import { getRangeAttributeId, setRangeAttributeId } from '@/modules/google-shopping-for-shop/lib/feed-rules/store'
import { changedBy } from '@/modules/google-shopping-for-shop/lib/workbench-actor'

const Body = z.object({ attributeId: z.string().trim().max(100).nullable() })

export async function POST(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Pick an attribute, or none' }, { status: 400 })
  const attributes = await listLabelAttributes()
  const nameOf = (id: string | null) => (id ? attributes.find((attribute) => attribute.id === id)?.name ?? null : null)
  const next = parsed.data.attributeId || null
  if (next && !nameOf(next)) return NextResponse.json({ error: 'That attribute no longer exists. Reload and pick again.' }, { status: 400 })
  try {
    const current = await getRangeAttributeId()
    const result = await setRangeAttributeId(next, { from: nameOf(current), to: nameOf(next) }, changedBy(gate.user))
    return NextResponse.json({ ok: true, rangeAttributeId: next, changeId: result.changeId })
  } catch (error) {
    console.error('[google-shopping] range attribute save failed:', error)
    return NextResponse.json({ error: 'Could not save that. Nothing was changed.' }, { status: 500 })
  }
}
