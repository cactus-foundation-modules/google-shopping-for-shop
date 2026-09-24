// The daily "what does Google make of our feed?" snapshot.
//
// Auth, paging, retries and error shapes all live in lib/google now; this file
// is only about the two report queries and what to do with their answers.
//
// One product_view query answers three questions at once - is this item
// matched, what does Google make of its price, and what is Google unhappy
// about - so the item issues ride along with the match snapshot rather than
// costing a second pass over the whole catalogue.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getGsfSettings, recordIssueCheck } from '@/modules/google-shopping-for-shop/lib/settings'
import { searchReport } from '@/modules/google-shopping-for-shop/lib/google/client'
import { hasGoogleCredentials } from '@/modules/google-shopping-for-shop/lib/google/credentials'
import { parseItemIssues, parseReportingStatus } from '@/modules/google-shopping-for-shop/lib/health/parse'
import { writeItemIssues, type ItemIssueInput } from '@/modules/google-shopping-for-shop/lib/health/item-issues'
import { readSpikeBaseline, syncDisapprovalAlert } from '@/modules/google-shopping-for-shop/lib/health/alerts'

type Money = {
  amountMicros?: string
  currencyCode?: string
}

type ProductViewResult = {
  productView?: {
    id?: string
    offerId?: string
    title?: string
    aggregatedReportingContextStatus?: string
    itemIssues?: unknown
  }
}

type PriceCompetitivenessResult = {
  priceCompetitivenessProductView?: {
    id?: string
    offerId?: string
    title?: string
    benchmarkPrice?: Money
  }
}

export type MatchRefreshResult = {
  checkedAt: Date
  products: number
  matched: number
  /** Item issues still open after this run. Null when the report came back
   *  empty and the ledger was deliberately left alone - not zero, which would
   *  read as "nothing is wrong". */
  issues: number | null
  /** Items with at least one issue that stops them being shown, or null for
   *  the same reason. */
  disapprovedItems: number | null
  /** Whether this run raised the "a lot of products stopped being shown" alert. */
  spikeAlerted: boolean
  /** True when Google returned no rows, so nothing was closed, alerted or
   *  recorded. The screens say "Google had nothing to say" rather than
   *  claiming a clean bill of health. */
  issuesSkipped: boolean
}

/** Whether the snapshot can be taken at all - the workbench hides its button
 *  when it cannot. */
export function canRefreshMerchantMatchStatus(): boolean {
  return hasGoogleCredentials()
}

function micros(value: string | undefined): bigint | null {
  if (!value || !/^-?\d+$/.test(value)) return null
  return BigInt(value)
}

export async function refreshMerchantMatchStatus(): Promise<MatchRefreshResult> {
  const settings = await getGsfSettings()
  if (!settings.merchantId) throw new Error('Merchant Center account number is not set')
  if (!hasGoogleCredentials()) throw new Error('Merchant API credentials are not configured')

  // Both queries run under one cached token, so the second does not pay for a
  // second round trip to Google's token endpoint.
  const [productRows, competitivenessRows] = await Promise.all([
    searchReport<ProductViewResult>(
      settings.merchantId,
      // item_issues and aggregated_reporting_context_status are ProductView
      // fields, confirmed against Google's own reference on 2026-09-22.
      // item_issues cannot be filtered or sorted on, which is why the whole
      // report is read and the sorting happens here.
      'SELECT product_view.id, product_view.offer_id, product_view.title, '
      + 'product_view.aggregated_reporting_context_status, product_view.item_issues '
      + 'FROM product_view',
    ),
    searchReport<PriceCompetitivenessResult>(
      settings.merchantId,
      'SELECT price_competitiveness_product_view.report_country_code, price_competitiveness_product_view.id, price_competitiveness_product_view.offer_id, price_competitiveness_product_view.title, price_competitiveness_product_view.benchmark_price FROM price_competitiveness_product_view',
    ),
  ])

  const benchmarkByOffer = new Map<string, { title: string | null; amount: bigint | null; currency: string | null }>()
  for (const row of competitivenessRows) {
    const view = row.priceCompetitivenessProductView
    const offerId = view?.offerId?.trim()
    if (!offerId) continue
    benchmarkByOffer.set(offerId, {
      title: view?.title?.trim() || null,
      amount: micros(view?.benchmarkPrice?.amountMicros),
      currency: view?.benchmarkPrice?.currencyCode?.trim() || null,
    })
  }

  const checkedAt = new Date()
  const values: Prisma.Sql[] = []
  const issueInputs: ItemIssueInput[] = []
  for (const row of productRows) {
    const view = row.productView
    const offerId = view?.offerId?.trim()
    if (!offerId) continue
    issueInputs.push({ itemId: offerId, issues: parseItemIssues(view?.itemIssues) })
    const benchmark = benchmarkByOffer.get(offerId)
    // Casts because a VALUES list inside a CTE has no target column to borrow
    // its types from.
    values.push(Prisma.sql`(
      ${offerId}::text,
      ${benchmark !== undefined}::boolean,
      ${benchmark?.title ?? view?.title?.trim() ?? null}::text,
      ${benchmark?.amount ?? null}::bigint,
      ${benchmark?.currency ?? null}::text,
      ${parseReportingStatus(view?.aggregatedReportingContextStatus)}::text,
      ${checkedAt}::timestamp(3)
    )`)
  }

  // One statement per batch: the history insert reads the snapshot as it stood
  // before the upsert (data-modifying CTEs share one snapshot), so it logs an
  // item exactly when its match state or the title Google holds has changed.
  // Benchmark prices drift daily and are carried along, never a trigger.
  for (let i = 0; i < values.length; i += 500) {
    await prisma.$executeRaw`
      WITH "incoming" ("item_id", "matched", "merchant_title", "benchmark_amount_micros", "benchmark_currency", "reporting_status", "checked_at") AS (
        VALUES ${Prisma.join(values.slice(i, i + 500))}
      ),
      "logged" AS (
        INSERT INTO "gsf_item_match_history"
          ("item_id", "matched", "merchant_title", "benchmark_amount_micros", "benchmark_currency", "recorded_at")
        SELECT n."item_id", n."matched", n."merchant_title", n."benchmark_amount_micros", n."benchmark_currency", n."checked_at"
        FROM "incoming" n
        LEFT JOIN "gsf_item_match_status" s ON s."item_id" = n."item_id"
        WHERE s."item_id" IS NULL
           OR s."matched" IS DISTINCT FROM n."matched"
           OR s."merchant_title" IS DISTINCT FROM n."merchant_title"
      )
      INSERT INTO "gsf_item_match_status"
        ("item_id", "matched", "merchant_title", "benchmark_amount_micros", "benchmark_currency", "reporting_status", "checked_at")
      SELECT "item_id", "matched", "merchant_title", "benchmark_amount_micros", "benchmark_currency", "reporting_status", "checked_at"
      FROM "incoming"
      ON CONFLICT ("item_id") DO UPDATE SET
        "matched" = EXCLUDED."matched",
        "merchant_title" = EXCLUDED."merchant_title",
        "benchmark_amount_micros" = EXCLUDED."benchmark_amount_micros",
        "benchmark_currency" = EXCLUDED."benchmark_currency",
        "reporting_status" = EXCLUDED."reporting_status",
        "checked_at" = EXCLUDED."checked_at"
    `
  }

  // An empty report is NOT an all clear, and must not be treated as one.
  //
  // Google answers 200 with no rows at all while an account is reprocessing
  // after a feed change - a state that lasts minutes to hours and says nothing
  // about the catalogue. Carrying on from here would close every open issue,
  // blank the Health tab, clear the spike alert and reset the baseline to
  // zero; tomorrow the same issues would reopen with today's date, losing the
  // day each one actually started, and the jump from 0 back to N could fire
  // the spike alert about nothing at all.
  //
  // So a report with no rows is left to touch nothing: no close, no prune, no
  // alert, no baseline. The ledger keeps yesterday's answer, which is the last
  // one anybody actually told us. A shop whose feed is genuinely empty also
  // lands here, and keeping its history is the right answer for it too.
  if (issueInputs.length === 0) {
    return {
      checkedAt,
      products: 0,
      matched: benchmarkByOffer.size,
      issues: null,
      disapprovedItems: null,
      spikeAlerted: false,
      issuesSkipped: true,
    }
  }

  // Only now, with every page of the report in hand: writeItemIssues closes
  // everything it was not told about, so it must never see a half-read
  // catalogue. A throw above gets here not at all, which is the point.
  const written = await writeItemIssues(issueInputs, checkedAt)

  const spikeAlerted = await syncDisapprovalAlert({
    disapproved: written.disapprovedItems,
    previous: settings.lastDisapprovedCount,
    threshold: settings.disapprovalAlertThreshold,
    openBaseline: await readSpikeBaseline(),
  })
  // Written after the comparison, so the next run measures against this one.
  await recordIssueCheck(checkedAt, written.disapprovedItems)

  return {
    checkedAt,
    products: values.length,
    matched: benchmarkByOffer.size,
    issues: written.open,
    disapprovedItems: written.disapprovedItems,
    spikeAlerted,
    issuesSkipped: false,
  }
}
