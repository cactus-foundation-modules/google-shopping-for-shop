// Fetching Google's best sellers rankings and filing them.
//
// Off by default, and for good reason: it is a second daily call, the report is
// not available to every Merchant Center account, and it answers a question
// about the market rather than about this shop's own feed.
//
// The shape of the ask is decided by two of Google's rules, both quoted in
// lib/best-sellers/query.ts: a country and a timeframe are compulsory, and a
// category is optional but LIMIT applies to the whole answer rather than to
// each category in it. So this asks once per category, and once with no
// category at all when there are none to ask about.
//
// NOTHING HERE HAS BEEN RUN AGAINST A REAL MERCHANT CENTER ACCOUNT.
import { prisma } from '@/lib/db/prisma'
import { getGsfSettings, recordBestSellersCheck } from '@/modules/google-shopping-for-shop/lib/settings'
import { searchReport } from '@/modules/google-shopping-for-shop/lib/google/client'
import { hasGoogleCredentials } from '@/modules/google-shopping-for-shop/lib/google/credentials'
import { GoogleApiError } from '@/modules/google-shopping-for-shop/lib/google/errors'
import { brandQuery, clusterQuery } from '@/modules/google-shopping-for-shop/lib/best-sellers/query'
import {
  parseBrandRow,
  parseClusterRow,
  type BestSellersBrandResult,
  type BestSellersClusterResult,
} from '@/modules/google-shopping-for-shop/lib/best-sellers/parse'
import { matchGtins, pruneBestSellers, writeBestSellers } from '@/modules/google-shopping-for-shop/lib/best-sellers/store'
import { addDays, todayUtc } from '@/modules/google-shopping-for-shop/lib/performance/days'
import type { BestSellerRow, BestSellersSkipReason } from '@/modules/google-shopping-for-shop/lib/best-sellers/types'

/** How many categories may be asked about in one run. Each one is two calls -
 *  products and brands - so ten categories is twenty calls a day, which is a
 *  rounding error against a Merchant API quota and still a list worth reading.
 *  Tuning, not policy. */
const MAX_CATEGORIES = 10

export type BestSellersOutcome =
  | {
      status: 'ok'
      /** Rows written, products and brands together. */
      rows: number
      /** The categories actually asked about. Empty means the one query with
       *  no category condition, which Google answers with every top-level
       *  category it ranks. */
      categories: string[]
      /** The ones Google turned down, which is a different thing from the
       *  whole report being unavailable: a shop trading in six categories may
       *  well find Google ranks five of them. Named so the owner can see WHICH
       *  came back empty rather than wondering why a list looks short. An
       *  empty string is the no-category query. */
      refusedCategories: string[]
      /** True when Google would not answer for ANY category - an account
       *  without the report, most likely. The rows already held are left alone
       *  and the screen says Google would not answer rather than showing
       *  nothing. */
      unavailable: boolean
      /** Google's own words for why, when it gave any. */
      message: string | null
      /** Rankings dropped by the retention setting. */
      pruned: number
      checkedAt: Date
    }
  | { status: 'skipped'; reason: BestSellersSkipReason }

/**
 * The Google category numbers to rank, in order of preference:
 *
 *  1. Whatever the owner typed into the setting.
 *  2. The numeric ids already typed against this shop's own categories on the
 *     taxonomy screen, which is almost always the right answer and needs
 *     nobody to type anything twice.
 *
 * A taxonomy entry can be a full "A > B > C" path rather than a number, and
 * Google's best sellers report wants a number - so a path is skipped here
 * rather than guessed at.
 */
export async function resolveBestSellerCategories(setting: string | null): Promise<string[]> {
  const typed = (setting ?? '')
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => /^\d{1,18}$/.test(part))
  if (typed.length > 0) return [...new Set(typed)].slice(0, MAX_CATEGORIES)

  const rows = await prisma.$queryRaw<Array<{ google_product_category: string }>>`
    SELECT DISTINCT "google_product_category"
    FROM "gsf_category_taxonomy"
    WHERE "google_product_category" ~ '^[0-9]+$'
    ORDER BY "google_product_category"
    LIMIT ${MAX_CATEGORIES}
  `
  return rows.map((row) => row.google_product_category)
}

export function canImportBestSellers(): boolean {
  return hasGoogleCredentials()
}

export async function importBestSellers(): Promise<BestSellersOutcome> {
  const settings = await getGsfSettings()
  if (!settings.bestSellersEnabled) return { status: 'skipped', reason: 'switched-off' }
  if (!hasGoogleCredentials()) return { status: 'skipped', reason: 'no-credentials' }
  if (!settings.merchantId) return { status: 'skipped', reason: 'no-merchant-id' }

  const merchantId = settings.merchantId
  const categories = await resolveBestSellerCategories(settings.bestSellersCategoryIds)
  // null asks with no category condition at all, which Google answers with
  // rankings for every top-level category it holds.
  const targets: Array<string | null> = categories.length > 0 ? categories : [null]

  const options = {
    granularity: settings.bestSellersGranularity,
    countryCode: settings.shippingCountry,
    limit: settings.bestSellersLimit,
  }

  const collected: BestSellerRow[] = []
  const refusedCategories: string[] = []
  let message: string | null = null

  for (const categoryId of targets) {
    try {
      const [clusters, brands] = await Promise.all([
        searchReport<BestSellersClusterResult>(merchantId, clusterQuery({ ...options, categoryId })),
        searchReport<BestSellersBrandResult>(merchantId, brandQuery({ ...options, categoryId })),
      ])
      for (const result of clusters) {
        const row = parseClusterRow(result)
        if (row) collected.push(row)
      }
      for (const result of brands) {
        const row = parseBrandRow(result)
        if (row) collected.push(row)
      }
    } catch (error) {
      // A refusal on ONE category is that category's answer, not the whole
      // run's: a shop trading in six categories should not lose five of them
      // because Google does not rank the sixth. A refusal on every category
      // is what the screen shows as "Google would not answer".
      if (error instanceof GoogleApiError && (error.status === 400 || error.forbidden || error.status === 404)) {
        refusedCategories.push(categoryId ?? '')
        message = message ?? error.message
        continue
      }
      throw error
    }
  }

  if (collected.length > 0) {
    const matched = await matchGtins(collected.flatMap((row) => row.variantGtins))
    await writeBestSellers(collected, matched)
  }

  // Nothing came back for ANY category. That is the report being unavailable;
  // a refusal on some of them is a per-category answer and is named instead.
  const unavailable = refusedCategories.length === targets.length

  // Rankings are pruned on the same window as the daily figures, and for the
  // same reason: without this the table grows a row per rank per category per
  // week for ever, while the retention box on the tab claims otherwise. 0 is
  // "keep the lot", exactly as it is for the performance table.
  let pruned = 0
  if (settings.performanceRetentionDays > 0) {
    pruned = await pruneBestSellers(addDays(todayUtc(), -settings.performanceRetentionDays))
  }

  const checkedAt = new Date()
  await recordBestSellersCheck(checkedAt)
  return {
    status: 'ok',
    rows: collected.length,
    categories: categories.slice(),
    refusedCategories,
    unavailable,
    message: refusedCategories.length > 0 ? message : null,
    pruned,
    checkedAt,
  }
}
