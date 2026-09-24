// GET /api/m/google-shopping-for-shop/admin/health
// What Google is unhappy about, and how its last read of the feed went.
//
// Reads our own tables only. Asking Google again is the refresh button next
// door, so opening the tab costs a few milliseconds and none of the account's
// Merchant API quota.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { HEALTH_PAGE_SIZES, readHealthReport } from '@/modules/google-shopping-for-shop/lib/health/report'
import { ISSUE_SEVERITIES } from '@/modules/google-shopping-for-shop/lib/health/types'

// Every field falls back rather than failing: a hand-edited or stale link
// should open the tab, not an error.
const Query = z.object({
  page: z.coerce.number().int().min(1).max(100_000).catch(1),
  perPage: z.coerce
    .number()
    .refine((value): value is (typeof HEALTH_PAGE_SIZES)[number] => (HEALTH_PAGE_SIZES as readonly number[]).includes(value))
    .catch(50),
  // Google's own issue codes, so whatever they send is what is filtered on.
  code: z.string().trim().max(200).catch(''),
  severity: z.enum(ISSUE_SEVERITIES).optional().catch(undefined),
})

export async function GET(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error

  const params = new URL(request.url).searchParams
  const query = Query.parse({
    page: params.get('page') ?? 1,
    perPage: params.get('perPage') ?? 50,
    code: params.get('code') ?? '',
    ...(params.get('severity') ? { severity: params.get('severity') } : {}),
  })

  try {
    const report = await readHealthReport({
      page: query.page,
      perPage: query.perPage,
      ...(query.code ? { code: query.code } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
    })
    return NextResponse.json({ report }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[google-shopping] health read failed:', error)
    return NextResponse.json({ error: 'Could not read the health figures. Try again in a moment.' }, { status: 500 })
  }
}
