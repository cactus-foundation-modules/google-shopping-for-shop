// GET/PATCH /api/m/google-shopping-for-shop/admin/items
// The Google Shopping workbench list: one page of feed items for a query
// (lib/workbench-query.ts), with the catalogue-wide summary, and row saves of
// feed-only title templates.
//
// GET extras: `reread=1` waits for a fresh read of the shop instead of the one
// held in memory; `known=<key>` leaves out the summary when the browser already
// holds the one for that key.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSiteUrlOrNull } from '@/lib/config/env'
import { hasShopPermission, requireShopUser } from '@/modules/shop/lib/access'
import { canRefreshMerchantMatchStatus } from '@/modules/google-shopping-for-shop/lib/merchant-reports'
import { applyTitleTemplateChanges } from '@/modules/google-shopping-for-shop/lib/title-template-changes'
import { loadWorkbench, type WorkbenchState } from '@/modules/google-shopping-for-shop/lib/workbench-data'
import { filterWorkbench, pageOf } from '@/modules/google-shopping-for-shop/lib/workbench-filter'
import { parseWorkbenchQuery } from '@/modules/google-shopping-for-shop/lib/workbench-query'
import { toWorkbenchRow } from '@/modules/google-shopping-for-shop/lib/workbench-view'
import { changedBy } from '@/modules/google-shopping-for-shop/lib/workbench-actor'

const PatchBody = z.object({
  updates: z.array(z.object({
    itemId: z.string().min(1).max(100),
    titleTemplate: z.string().max(500).nullable(),
  })).min(1).max(500),
})

const noStore = { 'Cache-Control': 'no-store' }

export async function GET(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const siteUrl = getSiteUrlOrNull()
  if (!siteUrl) return NextResponse.json({ error: 'Site URL is not configured' }, { status: 500 })

  const started = performance.now()
  const params = new URL(request.url).searchParams
  const query = parseWorkbenchQuery(params)

  let state: WorkbenchState
  try {
    state = await loadWorkbench(siteUrl, { forceCatalogue: params.get('reread') === '1' })
  } catch (error) {
    console.error('[google-shopping] workbench load failed:', error)
    return NextResponse.json({ error: 'Could not read the catalogue. Try again in a moment.' }, { status: 500, headers: noStore })
  }

  const matching = filterWorkbench(state.sorted(query.sort), query)
  const page = pageOf(matching, query.page, query.perPage)
  const canRefresh = canRefreshMerchantMatchStatus() && await hasShopPermission(gate.user, 'shop.manage')

  return NextResponse.json({
    rows: page.rows.map((view) => toWorkbenchRow(view, state.listingSize(view))),
    page: page.page,
    pageCount: page.pageCount,
    perPage: query.perPage,
    total: page.total,
    key: state.key,
    summary: params.get('known') === state.key ? null : state.summary,
    catalogue: {
      readAt: state.catalogueReadAt.toISOString(),
      // Worked out here so the browser can say "read 3 minutes ago" without a clock of its own.
      ageSeconds: Math.max(0, Math.round((Date.now() - state.catalogueReadAt.getTime()) / 1000)),
      stale: state.catalogueStale,
      // What goes to Google. Rows kept out (by a rule or by hand) are in the
      // list too, behind the feed filter, and counted on their own.
      items: state.summary.total,
      outOfFeed: state.summary.outOfFeed.rule + state.summary.outOfFeed.hand,
      withheld: state.withheldCount,
    },
    canRefresh,
    serverMs: Math.round(performance.now() - started),
  }, { headers: noStore })
}

export async function PATCH(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const parsed = PatchBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid title updates' }, { status: 400 })

  try {
    const result = await applyTitleTemplateChanges(parsed.data.updates, {
      summarise: (changed) => (changed === 1 ? 'Edited 1 title' : `Edited ${changed.toLocaleString('en-GB')} titles`),
      createdBy: changedBy(gate.user),
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    console.error('[google-shopping] title save failed:', error)
    return NextResponse.json({ error: 'Could not save the titles. Nothing was changed.' }, { status: 500 })
  }
}
