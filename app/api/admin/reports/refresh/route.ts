// POST /api/m/google-shopping-for-shop/admin/reports/refresh
//
// Asks Google for its figures now, rather than waiting for the daily check.
// Exactly what the cron does, and with the same budget: on a first run over a
// quarter of history it will not finish in one press, and the answer says so
// rather than pretending it did.
//
// The two imports are kept apart on purpose. Best sellers is a separate report
// on a separate switch, and a shop that cannot have it should still get its own
// performance figures.
import { NextResponse } from 'next/server'
import { requireShopUser } from '@/modules/shop/lib/access'
import { importPerformance } from '@/modules/google-shopping-for-shop/lib/performance/import'
import { importBestSellers } from '@/modules/google-shopping-for-shop/lib/best-sellers/import'
import type { RefreshFailure, RefreshReportsResult } from '@/modules/google-shopping-for-shop/lib/performance/refresh-types'

function failure(error: unknown, fallback: string): RefreshFailure {
  return { status: 'failed', message: error instanceof Error ? error.message : fallback }
}

export async function POST() {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  // Each in its own try: one report Google will not answer must not throw away
  // the other one, which has already been written by the time it fails.
  let performance: RefreshReportsResult['performance']
  try {
    // manual: a press of this button is the owner saying "try again", which
    // is the one thing that overrides a remembered refusal of the conversion
    // metrics (lib/performance/import.ts, shouldAskForConversions).
    performance = await importPerformance({ manual: true })
  } catch (error) {
    console.error('[google-shopping] performance import failed:', error)
    performance = failure(error, 'Could not fetch Google’s figures')
  }

  let bestSellers: RefreshReportsResult['bestSellers']
  try {
    bestSellers = await importBestSellers()
  } catch (error) {
    console.error('[google-shopping] best sellers import failed:', error)
    bestSellers = failure(error, 'Could not fetch the best sellers rankings')
  }

  // 200 even when both failed: both answers are reported in the body and the
  // screen shows each one in its own words. A bare 400 here would lose which
  // of the two went wrong.
  return NextResponse.json({ performance, bestSellers } satisfies RefreshReportsResult, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
