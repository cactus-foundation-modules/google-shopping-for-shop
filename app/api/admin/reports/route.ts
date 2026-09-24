// GET/PATCH /api/m/google-shopping-for-shop/admin/reports
//
// What Google reports about the feed - clicks, impressions, what came of them,
// and what is selling in the same categories. Reads our own tables only:
// asking Google again is the refresh button next door, so opening the tab costs
// a few milliseconds and none of the account's Merchant API quota.
//
// The PATCH is the handful of switches that belong to this screen rather than
// to the settings tab: whether to fetch these figures at all, how far back, how
// long to keep them, and the best sellers settings. Same shape as the Delivery
// tab's own switch - a setting lives where it is used.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { updateGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { readPerformanceReport, REPORT_PAGE_SIZES } from '@/modules/google-shopping-for-shop/lib/performance/report'
import { PRODUCT_SORTS, REPORT_RANGES } from '@/modules/google-shopping-for-shop/lib/performance/types'
import { BEST_SELLER_GRANULARITIES } from '@/modules/google-shopping-for-shop/lib/best-sellers/types'

// Every field falls back rather than failing: a hand-edited or stale link
// should open the tab, not an error page.
const Query = z.object({
  range: z.enum(REPORT_RANGES).catch('30'),
  // Checked properly by resolveRange, which refuses anything that is not a
  // real calendar day. The cap here only stops a paste of half a page.
  from: z.string().trim().max(10).catch(''),
  to: z.string().trim().max(10).catch(''),
  page: z.coerce.number().int().min(1).max(100_000).catch(1),
  perPage: z.coerce
    .number()
    .refine((value): value is (typeof REPORT_PAGE_SIZES)[number] => (REPORT_PAGE_SIZES as readonly number[]).includes(value))
    .catch(25),
  sort: z.enum(PRODUCT_SORTS).catch('clicks'),
  search: z.string().trim().max(200).catch(''),
})

export async function GET(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error

  const params = new URL(request.url).searchParams
  const query = Query.parse({
    range: params.get('range') ?? '30',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    page: params.get('page') ?? 1,
    perPage: params.get('perPage') ?? 25,
    sort: params.get('sort') ?? 'clicks',
    search: params.get('search') ?? '',
  })

  try {
    const report = await readPerformanceReport({
      range: query.range,
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      page: query.page,
      perPage: query.perPage,
      sort: query.sort,
      search: query.search,
    })
    return NextResponse.json({ report }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[google-shopping] reports read failed:', error)
    return NextResponse.json({ error: 'Could not read the Google figures. Try again in a moment.' }, { status: 500 })
  }
}

const PatchBody = z.object({
  importEnabled: z.boolean().optional(),
  // Clamped server-side; the bounds here only stop a nonsense paste reaching
  // the column.
  backfillDays: z.number().int().min(1).max(730).optional(),
  // 0 is a real answer: keep everything.
  retentionDays: z.number().int().min(0).max(3_650).optional(),
  bestSellersEnabled: z.boolean().optional(),
  // Numbers and commas. Anything else is dropped server-side rather than
  // refused: an owner pasting a category name alongside its number should get
  // the number, not a telling off.
  bestSellersCategoryIds: z.string().max(400).optional(),
  bestSellersGranularity: z.enum(BEST_SELLER_GRANULARITIES).optional(),
  bestSellersLimit: z.number().int().min(1).max(1_000).optional(),
})

export async function PATCH(request: NextRequest) {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  const parsed = PatchBody.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid settings' }, { status: 400 })
  const body = parsed.data

  await updateGsfSettings({
    performanceImportEnabled: body.importEnabled,
    performanceBackfillDays: body.backfillDays,
    performanceRetentionDays: body.retentionDays,
    bestSellersEnabled: body.bestSellersEnabled,
    bestSellersCategoryIds: body.bestSellersCategoryIds,
    bestSellersGranularity: body.bestSellersGranularity,
    bestSellersLimit: body.bestSellersLimit,
  })

  const report = await readPerformanceReport({ range: '30', page: 1, perPage: 25, sort: 'clicks', search: '' })
  return NextResponse.json({ report }, { headers: { 'Cache-Control': 'no-store' } })
}
