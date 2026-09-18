// GET /api/m/google-shopping-for-shop/admin/items/export?<workbench query>
// The rows a workbench query matches, every page of them, as a spreadsheet.
//
// Streamed a few hundred rows at a time: a whole catalogue with three titles a
// row runs to megabytes, past what a function may answer in one piece.
import { NextRequest, NextResponse } from 'next/server'
import { getSiteUrlOrNull } from '@/lib/config/env'
import { requireShopUser } from '@/modules/shop/lib/access'
import { toCsvRow } from '@/modules/shop/lib/csv'
import { loadWorkbench, type WorkbenchState } from '@/modules/google-shopping-for-shop/lib/workbench-data'
import { filterWorkbench } from '@/modules/google-shopping-for-shop/lib/workbench-filter'
import { ISSUE_LABELS, parseWorkbenchQuery } from '@/modules/google-shopping-for-shop/lib/workbench-query'
import type { WorkbenchView } from '@/modules/google-shopping-for-shop/lib/workbench-view'

const HEADER = [
  'Item id', 'Listing id', 'Title on the site', 'Title sent to Google', 'Title Google holds', 'Template',
  'Match', 'Price', 'Regular price', 'Typical price', 'Difference %', 'Currency', 'Availability',
  'SKU', 'MPN', 'GTIN', 'Brand', 'Category', 'Google category', 'Problems', 'Link', 'Last checked by Google',
]

const ROWS_PER_CHUNK = 500

function money(amount: number | null): string {
  return amount === null ? '' : amount.toFixed(2)
}

function csvLine(view: WorkbenchView): string {
  return toCsvRow([
    view.id,
    view.groupId ?? '',
    view.originalTitle,
    view.renderedTitle,
    view.merchantTitle,
    view.titleTemplate ?? '',
    view.matched,
    money(view.priceAmount),
    money(view.regularPrice),
    money(view.benchmarkAmount),
    view.gapPercent === null ? '' : String(view.gapPercent),
    view.currency,
    view.availability,
    view.sku,
    view.mpn,
    view.gtin,
    view.brand,
    view.productType,
    view.googleProductCategory,
    view.issues.map((code) => ISSUE_LABELS[code]).join('; '),
    view.url,
    view.checkedAt ?? '',
  ])
}

export async function GET(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const siteUrl = getSiteUrlOrNull()
  if (!siteUrl) return NextResponse.json({ error: 'Site URL is not configured' }, { status: 500 })

  const query = parseWorkbenchQuery(new URL(request.url).searchParams)
  let state: WorkbenchState
  try {
    state = await loadWorkbench(siteUrl)
  } catch (error) {
    console.error('[google-shopping] export load failed:', error)
    return NextResponse.json({ error: 'Could not read the catalogue. Try again in a moment.' }, { status: 500 })
  }
  const rows = filterWorkbench(state.sorted(query.sort), query)

  const encoder = new TextEncoder()
  let next = 0
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // A byte-order mark so Excel reads the file as UTF-8 and keeps the £.
      controller.enqueue(encoder.encode(`﻿${toCsvRow(HEADER)}\n`))
    },
    pull(controller) {
      if (next >= rows.length) {
        controller.close()
        return
      }
      const chunk = rows.slice(next, next + ROWS_PER_CHUNK)
      next += chunk.length
      controller.enqueue(encoder.encode(`${chunk.map(csvLine).join('\n')}\n`))
    },
  })

  const date = new Date().toISOString().slice(0, 10)
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="google-shopping-${date}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}
