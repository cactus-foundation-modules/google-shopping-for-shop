// Reading and writing gsf_best_sellers, and the one join that answers "do we
// sell this?".
//
// Raw SQL, which no typechecker, linter or build ever executes - so every
// statement here is run against a real database by lib/performance-sql.test.ts,
// which covers both halves of the Reports tab.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { dayFromDate } from '@/modules/google-shopping-for-shop/lib/performance/days'
import {
  catalogueVerdict,
  isBestSellerKind,
  storedDemandChange,
  storedInventoryStatus,
  storedRelativeDemand,
  asGranularity,
  type BestSellerGranularity,
  type BestSellerKind,
  type BestSellerRow,
  type CatalogueVerdict,
  type DemandChange,
  type InventoryStatus,
  type RelativeDemand,
} from '@/modules/google-shopping-for-shop/lib/best-sellers/types'

const BATCH = 200

/**
 * What this view is NOT showing, as one predicate written once.
 *
 * Two callers need it - the main read and the empty-answer read - and they
 * must agree, because between them they decide whether the panel says "you
 * have rankings under another setting" or "Google has nothing for you". Two
 * copies of a condition that must stay in step is two copies that will not.
 *
 * "Not showing" is deliberately wider than granularity and country. A category
 * the owner has since dropped from the setting is also hidden, and it is
 * hidden for the same reason and wants the same sentence.
 */
function notShown(query: BestSellersView): Prisma.Sql {
  return Prisma.sql`(
    "granularity" <> ${query.granularity}
    OR "country_code" <> ${query.countryCode}
    OR NOT (cardinality(${query.categoryIds}::text[]) = 0 OR "category_id" = ANY(${query.categoryIds}::text[]))
  )`
}

/** What the tab is asking to see. */
export type BestSellersView = {
  granularity: BestSellerGranularity
  countryCode: string
  perCategory: number
  /**
   * The Google category numbers currently configured. EMPTY MEANS NO FILTER,
   * which is the shop that has named none: Google then ranks its own top-level
   * categories and we are never told which ids those were, so there is nothing
   * to match against.
   *
   * A category the owner drops from the setting is filtered out rather than
   * deleted. Filtering is reversible and keeps the history: putting the
   * category back shows its last ranking immediately, dated, instead of an
   * empty list until the next fetch. Deleting on a settings change would throw
   * data away on a keystroke, which is not a thing a report should do.
   */
  categoryIds: readonly string[]
}

/** A row as the Reports tab draws it: Google's ranking plus our own verdict. */
export type BestSellerRowView = {
  kind: BestSellerKind
  reportDate: string
  granularity: BestSellerGranularity
  countryCode: string
  categoryId: string
  categoryPath: string | null
  rank: number
  previousRank: number | null
  title: string | null
  brand: string | null
  relativeDemand: RelativeDemand
  previousRelativeDemand: RelativeDemand
  demandChange: DemandChange
  inventoryStatus: InventoryStatus
  verdict: CatalogueVerdict
  /** The product a barcode match landed on, for the row to link to. */
  matchedProductId: string | null
  variantGtins: string[]
}

/**
 * Which of Google's example barcodes this shop already sells, and what it sells
 * them as.
 *
 * Two places a barcode can live: the shop's own column on the product or
 * variation row, and the GTIN typed into this module's per-product fields for a
 * listing that has no barcode of its own. Both are checked, the shop's own
 * first - it is the one an import keeps up to date.
 *
 * Returns a map from barcode to product id. A barcode nothing sells is simply
 * absent, which is what makes "not known" tellable from "no".
 */
export async function matchGtins(barcodes: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(barcodes.map((code) => code.trim()).filter((code) => /^\d{8,14}$/.test(code)))]
  if (wanted.length === 0) return new Map()

  const rows = await prisma.$queryRaw<Array<{ code: string; product_id: string }>>`
    SELECT p."barcode" AS "code", p."id" AS "product_id"
    FROM "shp_products" p
    WHERE p."barcode" = ANY(${wanted}::text[])
    UNION ALL
    SELECT d."gtin" AS "code", d."product_id" AS "product_id"
    FROM "gsf_product_data" d
    WHERE d."gtin" = ANY(${wanted}::text[])
  `
  const found = new Map<string, string>()
  // First writer wins, and shp_products comes first in the union: the shop's
  // own column is the one an import keeps current.
  for (const row of rows) if (!found.has(row.code)) found.set(row.code, row.product_id)
  return found
}

/**
 * A batch of ranking rows, written idempotently.
 *
 * `matched` is the map from matchGtins. A row whose GTINs are all absent from
 * it gets in_catalogue from Google's own inventory status instead, and a row
 * with no GTINs and no status from Google gets NULL - "not known", never a no.
 */
export async function writeBestSellers(rows: readonly BestSellerRow[], matched: Map<string, string>): Promise<void> {
  // Deduplicated on the PRIMARY KEY TUPLE first, and it has to be.
  //
  // Postgres refuses an INSERT ... ON CONFLICT DO UPDATE whose own VALUES list
  // carries the same key twice - "command cannot affect row a second time" -
  // and that is a throw, so two rows sharing a rank in one category would lose
  // the WHOLE run rather than one row of it. The performance path has the same
  // guard inside DayAccumulator; this is the best-sellers half of it. Last one
  // in wins, which is arbitrary and fine: they are two readings of one rank.
  const byKey = new Map<string, BestSellerRow>()
  for (const row of rows) {
    byKey.set([row.kind, row.reportDate, row.granularity, row.countryCode, row.categoryId, row.rank].join('\u0000'), row)
  }
  const unique = [...byKey.values()]

  for (let i = 0; i < unique.length; i += BATCH) {
    const values = unique.slice(i, i + BATCH).map((row) => {
      const matchedProductId = row.variantGtins.map((gtin) => matched.get(gtin)).find((id) => id !== undefined) ?? null
      const verdict = catalogueVerdict({ matchedProductId, inventoryStatus: row.inventoryStatus })
      const inCatalogue = verdict === 'unknown' ? null : verdict !== 'no'
      return Prisma.sql`(
        ${row.kind}::text,
        ${row.reportDate}::date,
        ${row.granularity}::text,
        ${row.countryCode}::text,
        ${row.categoryId}::text,
        ${row.rank}::bigint,
        ${row.previousRank}::bigint,
        ${row.title}::text,
        ${row.brand}::text,
        ${row.categoryPath}::text,
        ${row.relativeDemand}::text,
        ${row.previousRelativeDemand}::text,
        ${row.demandChange}::text,
        ${row.inventoryStatus}::text,
        ${row.brandInventoryStatus}::text,
        ${JSON.stringify(row.variantGtins)}::jsonb,
        ${inCatalogue}::boolean,
        ${matchedProductId}::text
      )`
    })
    await prisma.$executeRaw`
      INSERT INTO "gsf_best_sellers"
        ("kind", "report_date", "granularity", "country_code", "category_id", "rank", "previous_rank",
         "title", "brand", "category_path", "relative_demand", "previous_relative_demand", "demand_change",
         "inventory_status", "brand_inventory_status", "variant_gtins", "in_catalogue", "matched_product_id", "fetched_at")
      SELECT v."kind", v."report_date", v."granularity", v."country_code", v."category_id", v."rank", v."previous_rank",
             v."title", v."brand", v."category_path", v."relative_demand", v."previous_relative_demand", v."demand_change",
             v."inventory_status", v."brand_inventory_status", v."variant_gtins", v."in_catalogue", v."matched_product_id",
             CURRENT_TIMESTAMP
      FROM (VALUES ${Prisma.join(values)})
        AS v("kind", "report_date", "granularity", "country_code", "category_id", "rank", "previous_rank",
              "title", "brand", "category_path", "relative_demand", "previous_relative_demand", "demand_change",
              "inventory_status", "brand_inventory_status", "variant_gtins", "in_catalogue", "matched_product_id")
      ON CONFLICT ("kind", "report_date", "granularity", "country_code", "category_id", "rank") DO UPDATE SET
        "previous_rank" = EXCLUDED."previous_rank",
        "title" = EXCLUDED."title",
        "brand" = EXCLUDED."brand",
        "category_path" = EXCLUDED."category_path",
        "relative_demand" = EXCLUDED."relative_demand",
        "previous_relative_demand" = EXCLUDED."previous_relative_demand",
        "demand_change" = EXCLUDED."demand_change",
        "inventory_status" = EXCLUDED."inventory_status",
        "brand_inventory_status" = EXCLUDED."brand_inventory_status",
        "variant_gtins" = EXCLUDED."variant_gtins",
        "in_catalogue" = EXCLUDED."in_catalogue",
        "matched_product_id" = EXCLUDED."matched_product_id",
        "fetched_at" = CURRENT_TIMESTAMP
    `
  }
}

/**
 * Drops rankings older than a given report date, so the table does not grow a
 * row per rank per category per week for ever.
 *
 * WITH ONE REFUSAL: the newest report for each (kind, granularity, country,
 * category) is never deleted, however old it is.
 *
 * That guard is not belt and braces, it is load-bearing. The retention window
 * is a number of DAYS, sized for the daily figures, and a report_date here is
 * the first day of a WEEK OR A MONTH. Set to MONTHLY with thirty days of
 * retention, a report Google publishes in arrears is older than the window the
 * moment it lands - so the same run that wrote it would delete it, and the tab
 * would show the "Google gave no rankings" empty state for ever while the
 * fetch quietly worked every single day.
 *
 * Keeping the newest per category costs a handful of rows and makes the
 * pathological case impossible rather than unlikely.
 */
export async function pruneBestSellers(beforeReportDate: string): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM "gsf_best_sellers" b
    WHERE b."report_date" < ${beforeReportDate}::date
      AND b."report_date" < (
        SELECT max(n."report_date") FROM "gsf_best_sellers" n
        WHERE n."kind" = b."kind" AND n."granularity" = b."granularity"
          AND n."country_code" = b."country_code" AND n."category_id" = b."category_id"
      )
  `
}

type BestSellerDbRow = {
  kind: string
  report_date: Date
  granularity: string
  country_code: string
  category_id: string
  category_path: string | null
  rank: bigint
  previous_rank: bigint | null
  title: string | null
  brand: string | null
  relative_demand: string
  previous_relative_demand: string
  demand_change: string
  inventory_status: string
  in_catalogue: boolean | null
  matched_product_id: string | null
  variant_gtins: unknown
}

function toView(row: BestSellerDbRow): BestSellerRowView | null {
  const reportDate = dayFromDate(row.report_date)
  if (!reportDate || !isBestSellerKind(row.kind)) return null
  const inventoryStatus = storedInventoryStatus(row.inventory_status)
  return {
    kind: row.kind,
    reportDate,
    granularity: asGranularity(row.granularity),
    countryCode: row.country_code,
    categoryId: row.category_id,
    categoryPath: row.category_path,
    rank: Number(row.rank),
    previousRank: row.previous_rank === null ? null : Number(row.previous_rank),
    title: row.title,
    brand: row.brand,
    relativeDemand: storedRelativeDemand(row.relative_demand),
    previousRelativeDemand: storedRelativeDemand(row.previous_relative_demand),
    demandChange: storedDemandChange(row.demand_change),
    inventoryStatus,
    // Worked out again from what is stored rather than read back out of
    // in_catalogue: the boolean cannot tell "we matched a barcode" from
    // "Google says it is in your data source", and the screen says which.
    verdict: catalogueVerdict({ matchedProductId: row.matched_product_id, inventoryStatus }),
    matchedProductId: row.matched_product_id,
    variantGtins: Array.isArray(row.variant_gtins) ? row.variant_gtins.filter((v): v is string => typeof v === 'string') : [],
  }
}

/**
 * The newest ranking we hold of one kind, capped per category.
 *
 * Two things this gets right that the obvious version does not:
 *
 *  - THE CAP IS PER CATEGORY, applied with a window function. A plain LIMIT
 *    over rows ordered by category and then rank does not trim the bottom of
 *    each category, it drops the LAST CATEGORIES ENTIRELY - so a shop trading
 *    in six categories would silently see three of them while the settings
 *    screen promised "the top fifty per category".
 *
 *  - IT READS ONLY THE GRANULARITY AND COUNTRY NOW CONFIGURED. Switching from
 *    weekly to monthly leaves last week's rows in the table (history is kept,
 *    not shown), and matching on category alone would put them alongside the
 *    monthly ones as though they were the same ranking.
 *
 * "Newest" is then per category within that: a category Google has since
 * stopped ranking keeps its last answer, dated, rather than disappearing.
 *
 * `truncated` is how many rows the cap left out, and `heldElsewhere` how many
 * rows exist under a DIFFERENT granularity or country. The second one matters
 * as much as the first: switching weekly to monthly makes every stored row
 * invisible at once, and without a count the panel would print "Google gave no
 * rankings, not every account has this report" - untrue, and untrue in the
 * direction that makes an owner switch the feature off while their rankings
 * sit in the table one setting away.
 *
 * A note on the tie-break: `row_number() OVER (PARTITION BY category_id ORDER
 * BY rank)` is deterministic here ONLY because `rank` is part of the primary
 * key over exactly the columns the query has already narrowed to - kind,
 * report_date, granularity, country, category - so within a partition no two
 * rows can share one. Widen what this reads without re-checking that and the
 * order becomes arbitrary, which on a paged screen is a row that appears
 * twice and a row that never appears at all.
 */
export async function readBestSellers(
  kind: BestSellerKind,
  query: BestSellersView,
): Promise<{ rows: BestSellerRowView[]; reportDate: string | null; truncated: number; heldElsewhere: number }> {
  const perCategory = Math.max(1, Math.trunc(query.perCategory))
  const rows = await prisma.$queryRaw<Array<BestSellerDbRow & { truncated: number; held_elsewhere: number }>>`
    WITH "matching" AS (
      SELECT * FROM "gsf_best_sellers"
      WHERE "kind" = ${kind} AND NOT ${notShown(query)}
    ),
    "latest" AS (
      SELECT "category_id", max("report_date") AS "report_date"
      FROM "matching"
      GROUP BY "category_id"
    ),
    "ranked" AS (
      SELECT m.*, row_number() OVER (PARTITION BY m."category_id" ORDER BY m."rank" ASC) AS "place"
      FROM "matching" m
      JOIN "latest" l ON l."category_id" = m."category_id" AND l."report_date" = m."report_date"
    ),
    -- Rankings this shop holds that this view is not showing. What turns a
    -- false "Google gave us nothing" into "you have just switched to monthly,
    -- and your weekly rankings are still here".
    "elsewhere" AS (
      SELECT 1 FROM "gsf_best_sellers" WHERE "kind" = ${kind} AND ${notShown(query)}
    )
    SELECT "kind", "report_date", "granularity", "country_code", "category_id", "category_path",
           "rank", "previous_rank", "title", "brand", "relative_demand", "previous_relative_demand",
           "demand_change", "inventory_status", "in_catalogue", "matched_product_id", "variant_gtins",
           (SELECT count(*) FROM "ranked" WHERE "place" > ${perCategory})::int AS "truncated",
           (SELECT count(*) FROM "elsewhere")::int AS "held_elsewhere"
    FROM "ranked"
    WHERE "place" <= ${perCategory}
    ORDER BY "category_id" ASC, "rank" ASC
  `
  const views = rows.map(toView).filter((view): view is BestSellerRowView => view !== null)
  // The newest date any of them carries, for the "as at" line on the screen.
  const reportDate = views.reduce<string | null>((newest, view) => (newest === null || view.reportDate > newest ? view.reportDate : newest), null)
  // The counts ride on every row, so an EMPTY answer carries none of them -
  // and an empty answer is exactly when heldElsewhere is worth knowing. One
  // more small query for that case only.
  if (rows.length === 0) {
    const [counts] = await prisma.$queryRaw<Array<{ held_elsewhere: number }>>`
      SELECT count(*)::int AS "held_elsewhere" FROM "gsf_best_sellers"
      WHERE "kind" = ${kind} AND ${notShown(query)}
    `
    return { rows: [], reportDate: null, truncated: 0, heldElsewhere: counts?.held_elsewhere ?? 0 }
  }

  return {
    rows: views,
    reportDate,
    truncated: rows[0]?.truncated ?? 0,
    heldElsewhere: rows[0]?.held_elsewhere ?? 0,
  }
}
