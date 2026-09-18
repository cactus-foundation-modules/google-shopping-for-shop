// GET /api/m/google-shopping-for-shop/admin/items/changes
// The workbench's recent title template saves, newest first, for the "Recent
// changes" panel and its Undo buttons.
import { NextResponse } from 'next/server'
import { requireShopUser } from '@/modules/shop/lib/access'
import { listTitleTemplateBatches } from '@/modules/google-shopping-for-shop/lib/title-template-changes'

const SHOWN = 15

export async function GET() {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  try {
    const batches = await listTitleTemplateBatches(SHOWN)
    return NextResponse.json({
      changes: batches.map((batch) => ({
        id: batch.id,
        summary: batch.summary,
        itemCount: batch.itemCount,
        createdBy: batch.createdBy,
        createdAt: batch.createdAt.toISOString(),
        undoneAt: batch.undoneAt?.toISOString() ?? null,
      })),
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[google-shopping] change list failed:', error)
    return NextResponse.json({ error: 'Could not load recent changes' }, { status: 500 })
  }
}
