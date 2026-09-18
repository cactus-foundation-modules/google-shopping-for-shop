// GET /api/m/google-shopping-for-shop/admin/items/history?itemId=
// One feed item's match history, newest first. Loaded when a workbench row is expanded.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { requireShopUser } from '@/modules/shop/lib/access'

type HistoryRow = {
  matched: boolean
  merchant_title: string | null
  benchmark_amount_micros: string | null
  benchmark_currency: string | null
  recorded_at: Date
}

const Query = z.object({ itemId: z.string().min(1).max(100) })

export async function GET(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const parsed = Query.safeParse({ itemId: new URL(request.url).searchParams.get('itemId') })
  if (!parsed.success) return NextResponse.json({ error: 'Missing item id' }, { status: 400 })

  const rows = await prisma.$queryRaw<HistoryRow[]>`
    SELECT "matched", "merchant_title", "benchmark_amount_micros"::text AS "benchmark_amount_micros",
           "benchmark_currency", "recorded_at"
    FROM "gsf_item_match_history"
    WHERE "item_id" = ${parsed.data.itemId}
    ORDER BY "recorded_at" DESC
    LIMIT 200
  `
  return NextResponse.json({
    history: rows.map((row) => ({
      matched: row.matched,
      merchantTitle: row.merchant_title ?? '',
      benchmarkAmountMicros: row.benchmark_amount_micros ?? '',
      benchmarkCurrency: row.benchmark_currency ?? '',
      recordedAt: row.recorded_at.toISOString(),
    })),
  })
}
