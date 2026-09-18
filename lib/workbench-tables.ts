// The workbench's reads of the two tables it edits or reports from: whole-table
// fingerprints, and Google's match snapshots. Kept apart from the in-memory
// cache (lib/workbench-data.ts) so the SQL can be run on its own against a
// real database (lib/workbench-sql.test.ts).
import { prisma } from '@/lib/db/prisma'
import type { MatchSnapshot } from '@/modules/google-shopping-for-shop/lib/workbench-view'

/** One opaque string per table; equal strings mean equal contents. */
export type WorkbenchFingerprints = { templates: string; snapshots: string }

type FingerprintRow = {
  template_count: number
  template_hash: bigint | null
  status_count: number
  status_hash: bigint | null
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
         || "checked_at"::text
       )) FROM "gsf_item_match_status") AS "status_hash"
  `
  return {
    templates: `${row?.template_count ?? 0}:${row?.template_hash ?? 0}`,
    snapshots: `${row?.status_count ?? 0}:${row?.status_hash ?? 0}`,
  }
}

type SnapshotRow = {
  item_id: string
  matched: boolean
  merchant_title: string | null
  benchmark_amount_micros: string | null
  benchmark_currency: string | null
  checked_at: Date
}

/** Every match snapshot Google has given us, by item id. */
export async function readMatchSnapshots(): Promise<Map<string, MatchSnapshot>> {
  const rows = await prisma.$queryRaw<SnapshotRow[]>`
    SELECT "item_id", "matched", "merchant_title", "benchmark_amount_micros"::text AS "benchmark_amount_micros",
           "benchmark_currency", "checked_at"
    FROM "gsf_item_match_status"
  `
  return new Map(rows.map((row) => [row.item_id, {
    matched: row.matched,
    merchantTitle: row.merchant_title,
    benchmarkAmountMicros: row.benchmark_amount_micros,
    benchmarkCurrency: row.benchmark_currency,
    checkedAt: row.checked_at,
  }]))
}
