// The workbench's reads of the two tables it edits or reports from: whole-table
// fingerprints, and Google's match snapshots. Kept apart from the in-memory
// cache (lib/workbench-data.ts) so the SQL can be run on its own against a
// real database (lib/workbench-sql.test.ts).
import { prisma } from '@/lib/db/prisma'
import { storedReportingStatus } from '@/modules/google-shopping-for-shop/lib/health/types'
import type { MatchSnapshot } from '@/modules/google-shopping-for-shop/lib/workbench-view'

/** One opaque string per table; equal strings mean equal contents.
 *
 *  `rules` covers everything that decides what the feed build itself sends:
 *  the feed rules, the owner's per-product fields and feed choices, and the
 *  range setting. Unlike the other two, a change there means the catalogue
 *  must be built again, not just re-joined. */
export type WorkbenchFingerprints = { templates: string; snapshots: string; rules: string; issues: string }

type FingerprintRow = {
  template_count: number
  template_hash: bigint | null
  status_count: number
  status_hash: bigint | null
  rule_count: number
  rule_hash: bigint | null
  product_count: number
  product_hash: bigint | null
  range_attribute: string | null
  issue_count: number
  issue_hash: bigint | null
}

// A count and an order-free hash sum over each table's content. Any insert,
// delete or changed value moves one of them, including a write from another
// server instance and a write that commits late carrying an older timestamp -
// the case a max(updated_at) stamp would miss. Milliseconds on tens of
// thousands of rows.
export async function readWorkbenchFingerprints(): Promise<WorkbenchFingerprints> {
  const [row] = await prisma.$queryRaw<FingerprintRow[]>`
    SELECT
      (SELECT count(*)::int FROM "gsf_title_templates") AS "template_count",
      (SELECT sum(hashtext("item_id" || chr(31) || "title_template")) FROM "gsf_title_templates") AS "template_hash",
      (SELECT count(*)::int FROM "gsf_item_match_status") AS "status_count",
      (SELECT sum(hashtext(
         "item_id" || chr(31) || "matched"::text || chr(31) || coalesce("merchant_title", '') || chr(31)
         || coalesce("benchmark_amount_micros"::text, '') || chr(31) || coalesce("benchmark_currency", '') || chr(31)
         || coalesce("reporting_status", '') || chr(31)
         || "checked_at"::text
       )) FROM "gsf_item_match_status") AS "status_hash",
      (SELECT count(*)::int FROM "gsf_feed_rules") AS "rule_count",
      (SELECT sum(hashtext(
         "id" || chr(31) || "name" || chr(31) || "enabled"::text || chr(31) || "position"::text || chr(31)
         || "conditions"::text || chr(31) || "action"::text
       )) FROM "gsf_feed_rules") AS "rule_hash",
      (SELECT count(*)::int FROM "gsf_product_data") AS "product_count",
      (SELECT sum(hashtext(
         "product_id" || chr(31) || "feed_choice" || chr(31) || coalesce("brand", '') || chr(31) || coalesce("gtin", '') || chr(31)
         || coalesce("mpn", '') || chr(31) || coalesce("google_product_category", '') || chr(31) || coalesce("condition", '')
       )) FROM "gsf_product_data") AS "product_hash",
      (SELECT coalesce("rules_range_attribute_id", '') FROM "gsf_settings" WHERE "id" = 'singleton') AS "range_attribute",
      -- Only OPEN issues are joined onto a row, so a closed one moving is not
      -- a reason to rebuild anything. resolved_at is in the hash all the same,
      -- because closing one is exactly what takes a badge off a row.
      (SELECT count(*)::int FROM "gsf_item_issues" WHERE "resolved_at" IS NULL) AS "issue_count",
      (SELECT sum(hashtext("item_id" || chr(31) || "code" || chr(31) || "attribute" || chr(31) || "severity"))
       FROM "gsf_item_issues" WHERE "resolved_at" IS NULL) AS "issue_hash"
  `
  return {
    templates: `${row?.template_count ?? 0}:${row?.template_hash ?? 0}`,
    snapshots: `${row?.status_count ?? 0}:${row?.status_hash ?? 0}`,
    rules: `${row?.rule_count ?? 0}:${row?.rule_hash ?? 0}|${row?.product_count ?? 0}:${row?.product_hash ?? 0}|${row?.range_attribute ?? ''}`,
    issues: `${row?.issue_count ?? 0}:${row?.issue_hash ?? 0}`,
  }
}

type SnapshotRow = {
  item_id: string
  matched: boolean
  merchant_title: string | null
  benchmark_amount_micros: string | null
  benchmark_currency: string | null
  reporting_status: string | null
  checked_at: Date
}

/** Every match snapshot Google has given us, by item id. */
export async function readMatchSnapshots(): Promise<Map<string, MatchSnapshot>> {
  const rows = await prisma.$queryRaw<SnapshotRow[]>`
    SELECT "item_id", "matched", "merchant_title", "benchmark_amount_micros"::text AS "benchmark_amount_micros",
           "benchmark_currency", "reporting_status", "checked_at"
    FROM "gsf_item_match_status"
  `
  return new Map(rows.map((row) => [row.item_id, {
    matched: row.matched,
    merchantTitle: row.merchant_title,
    benchmarkAmountMicros: row.benchmark_amount_micros,
    benchmarkCurrency: row.benchmark_currency,
    reportingStatus: storedReportingStatus(row.reporting_status),
    checkedAt: row.checked_at,
  }]))
}
