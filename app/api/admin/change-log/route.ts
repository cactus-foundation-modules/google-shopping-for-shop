// GET /api/m/google-shopping-for-shop/admin/change-log?area=feed-rules&area=products&limit=30
// The workbench's general change log, newest first, for one or more areas.
// Each entry says whether it can be undone from here. The snapshots themselves
// stay on the server: only the area's own undo reads them.
import { NextRequest, NextResponse } from 'next/server'
import { requireShopUser } from '@/modules/shop/lib/access'
import { canUndoArea, isChangeLogArea, listChanges, type ChangeLogArea, type ChangeLogEntry } from '@/modules/google-shopping-for-shop/lib/change-log'
import { loadChangeLogHandlers } from '@/modules/google-shopping-for-shop/lib/change-log-handlers'

loadChangeLogHandlers()

export async function GET(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const params = new URL(request.url).searchParams
  const areas = [...new Set(params.getAll('area').filter(isChangeLogArea))]
  const limit = Math.min(Math.max(1, Number(params.get('limit')) || 30), 200)

  const lists = areas.length === 0
    ? [await listChanges({ limit })]
    : await Promise.all(areas.map((area: ChangeLogArea) => listChanges({ area, limit })))
  const entries: ChangeLogEntry[] = lists.flat()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
    .slice(0, limit)

  return NextResponse.json({
    changes: entries.map((entry) => ({
      id: entry.id,
      area: entry.area,
      action: entry.action,
      summary: entry.summary,
      createdBy: entry.createdBy,
      createdAt: entry.createdAt.toISOString(),
      undoneAt: entry.undoneAt?.toISOString() ?? null,
      canUndo: canUndoArea(entry.area),
    })),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
