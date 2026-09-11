// Fills shop's `shop.product-merchant-facts` point: the make, the barcode, the
// part number and the condition of a product, plus the country this shop
// delivers to.
//
// Why this module answers. None of it is shop's own - a shop knows what it sells
// and what it charges, and who made the thing is something an owner types in for
// a feed's benefit. This module is the one that asked for it, so this module is
// the one that keeps it, and handing it back through a point is what lets the
// product page publish a brand and a GTIN in its structured data without shop
// becoming a dependent of an optional module.
//
// It is the same resolution the feed itself does, through the same function
// (identifiersOf), deliberately: a shopping assistant reading the page and
// Merchant Center reading the feed must not be told two different brands for the
// same product, and two renderings of the same rule is how that happens.
//
// Standalone terms throughout. A product page is a listing, not one of its
// combinations, so the listing's own GTIN and MPN apply - the feed's narrower
// variant rules (a child may not inherit its parent's part number) belong to the
// feed's own rows.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { getProductDataForProducts } from '@/modules/google-shopping-for-shop/lib/product-data'
import { identifiersOf } from '@/modules/google-shopping-for-shop/lib/identifiers'
import { EMPTY_PRODUCT_DATA, type GsfCondition } from '@/modules/google-shopping-for-shop/lib/types'

/** The shape shop reads back. Kept as a local structural type rather than an
 *  import from shop: this module already depends on shop, but the point is a
 *  seam and a seam that only compiles against one version of the other side is
 *  not a seam. */
type MerchantIdentifiers = {
  brand?: string | null
  gtin?: string | null
  mpn?: string | null
  condition?: string | null
}

// Google spells conditions in lower case; schema.org spells them as named
// OfferItemCondition members. Same three facts, two vocabularies, and the
// translation belongs here rather than in shop - shop has no opinion about
// Google's spelling and should not learn one.
const SCHEMA_CONDITION: Record<GsfCondition, string> = {
  new: 'NewCondition',
  refurbished: 'RefurbishedCondition',
  used: 'UsedCondition',
}

export const googleShoppingMerchantFacts = {
  async shopFacts(): Promise<{ shippingCountry: string | null }> {
    const settings = await getGsfSettings()
    return { shippingCountry: settings.shippingCountry || null }
  },

  async identifiers(productIds: string[]): Promise<Record<string, MerchantIdentifiers>> {
    const out: Record<string, MerchantIdentifiers> = {}
    const ids = [...new Set(productIds)].filter(Boolean)
    if (ids.length === 0) return out

    const [settings, data, rows] = await Promise.all([
      getGsfSettings(),
      getProductDataForProducts(ids),
      prisma.$queryRaw<Array<{ id: string; supplier: string | null; barcode: string | null }>>`
        SELECT "id", "supplier", "barcode" FROM "shp_products" WHERE "id" IN (${Prisma.join(ids)})
      `,
    ])

    for (const row of rows) {
      const stored = data.get(row.id) ?? { productId: row.id, ...EMPTY_PRODUCT_DATA }
      const { brand, gtin, mpn } = identifiersOf(
        stored,
        {
          supplier: row.supplier,
          defaultBrand: settings.defaultBrand || null,
          useSupplier: settings.brandFromSupplier,
        },
        row.barcode,
        { standalone: true },
      )
      const condition = stored.condition ?? settings.defaultCondition
      const facts: MerchantIdentifiers = {
        brand: brand ?? null,
        gtin: gtin ?? null,
        mpn: mpn ?? null,
        condition: SCHEMA_CONDITION[condition] ?? null,
      }
      // A product this module knows nothing about must stay absent, so another
      // provider could still answer for it - and so shop falls back to the
      // barcode on the product row rather than to four nulls.
      if (facts.brand || facts.gtin || facts.mpn || facts.condition) out[row.id] = facts
    }
    return out
  },
}
