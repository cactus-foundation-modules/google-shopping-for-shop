import { prisma, type PrismaTransactionClient } from '@/lib/db/prisma'
import { EMPTY_PRODUCT_DATA, GSF_CONDITIONS, asFeedChoice, type GsfCondition, type GsfProductData } from '@/modules/google-shopping-for-shop/lib/types'

type Row = {
  product_id: string
  brand: string | null
  gtin: string | null
  mpn: string | null
  google_product_category: string | null
  condition: string | null
  feed_choice: string
}

function mapRow(row: Row): GsfProductData {
  return {
    productId: row.product_id,
    brand: row.brand,
    gtin: row.gtin,
    mpn: row.mpn,
    googleProductCategory: row.google_product_category,
    condition: GSF_CONDITIONS.includes(row.condition as GsfCondition) ? (row.condition as GsfCondition) : null,
    feedChoice: asFeedChoice(row.feed_choice),
  }
}

/** This product's Google fields, defaults when no row exists. */
export async function getProductData(productId: string): Promise<GsfProductData> {
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT "product_id", "brand", "gtin", "mpn", "google_product_category", "condition", "feed_choice"
    FROM "gsf_product_data" WHERE "product_id" = ${productId}
  `
  return rows[0] ? mapRow(rows[0]) : { productId, ...EMPTY_PRODUCT_DATA }
}

/** Bulk read for the feed run: only products that actually have a row come back,
 *  so absence in the map means defaults. One array parameter rather than one
 *  per id, because the feed asks for every listing AND every variation, which
 *  on a real catalogue is tens of thousands of ids. */
export async function getProductDataForProducts(productIds: string[]): Promise<Map<string, GsfProductData>> {
  const map = new Map<string, GsfProductData>()
  const unique = [...new Set(productIds)].filter(Boolean)
  if (unique.length === 0) return map
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT "product_id", "brand", "gtin", "mpn", "google_product_category", "condition", "feed_choice"
    FROM "gsf_product_data" WHERE "product_id" = ANY(${unique}::text[])
  `
  for (const row of rows) map.set(row.product_id, mapRow(row))
  return map
}

/** Writes the product's typed-in Google fields, creating the row on first save.
 *  The feed choice is NOT written here: it has a change log of its own
 *  (lib/feed-choice.ts), and a save of the brand must not quietly reset it.
 *  Clearing every field still keeps the row - harmless, and simpler than
 *  deciding when to delete. */
export async function upsertProductData(
  data: Omit<GsfProductData, 'feedChoice'>,
  db: PrismaTransactionClient = prisma,
): Promise<void> {
  const brand = data.brand?.trim() || null
  const gtin = data.gtin?.trim() || null
  const mpn = data.mpn?.trim() || null
  const category = data.googleProductCategory?.trim() || null
  await db.$executeRaw`
    INSERT INTO "gsf_product_data"
      ("product_id", "brand", "gtin", "mpn", "google_product_category", "condition", "updated_at")
    VALUES (${data.productId}, ${brand}, ${gtin}, ${mpn}, ${category}, ${data.condition}, CURRENT_TIMESTAMP)
    ON CONFLICT ("product_id") DO UPDATE SET
      "brand" = EXCLUDED."brand",
      "gtin" = EXCLUDED."gtin",
      "mpn" = EXCLUDED."mpn",
      "google_product_category" = EXCLUDED."google_product_category",
      "condition" = EXCLUDED."condition",
      "updated_at" = CURRENT_TIMESTAMP
  `
}
