// Assembles the feed's items from the shop and shop-variations modules. All the
// judgement calls live here; lib/feed-xml.ts only renders what this hands it.
//
// Reads go through the two modules' own lib functions wherever one exists
// (declared dependencies - see requiresModules in cactus.module.json), with raw
// SQL only for the handful of child-product columns no existing bulk read
// carries. Pricing, tax and stock rules are the shop's own helpers, never
// re-derived: a feed that disagrees with the storefront about a price is a
// Merchant Center disapproval waiting to happen.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { productUrl } from '@/modules/shop/lib/product-url'
import { listProducts, getProductMediaForProducts, HARD_MAX_PER_PAGE } from '@/modules/shop/lib/db/products'
import { listCategories } from '@/modules/shop/lib/db/catalogue'
import { getDefaultTaxZoneId, listTaxZoneRates } from '@/modules/shop/lib/db/tax-shipping'
import { displayAmount, type PriceDisplay } from '@/modules/shop/lib/tax-display-shared'
import { isOnSale } from '@/modules/shop/lib/pricing'
import { hidesOutOfStockFromShoppers, outOfStockSql } from '@/modules/shop/lib/stock-visibility'
import { stripHtmlToPlainText } from '@/modules/shop/lib/strip-html'
import type { ShpProduct } from '@/modules/shop/lib/types'
import { getProductIdsWithVariations } from '@/modules/shop-variations/lib/db/variants'
import { getEditorPayloadsBatch } from '@/modules/shop-variations/lib/variants-service'
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { getProductDataForProducts } from '@/modules/google-shopping-for-shop/lib/product-data'
import { getDeliveryTiming } from '@/modules/google-shopping-for-shop/lib/delivery-timing'
import { mapVariantAxes, normaliseGtin, type FeedAvailability, type FeedItem, type FeedOptionPair } from '@/modules/google-shopping-for-shop/lib/feed-xml'
import type { GsfProductData } from '@/modules/google-shopping-for-shop/lib/types'

// The parent-product columns the feed needs, fetched raw because listProducts
// cannot select by an id list. Numeric columns arrive as Prisma.Decimal.
type ParentRow = {
  id: string
  name: string
  slug: string
  price: unknown
  sale_price: unknown
  description: string | null
  short_description: string | null
  meta_description: string | null
  master_category_id: string | null
  tax_class_id: string | null
  supplier: string | null
}

// The per-child columns VariantEditorRow does not carry (availability inputs
// and the deep-link slug), read once for every child in the run.
type ChildRow = {
  id: string
  slug: string
  status: string
  track_inventory: boolean
  stock_count: number | null
  out_of_stock_behaviour: string
  is_pre_order: boolean
  tax_class_id: string | null
  weight_unit: string | null
  supplier: string | null
}

// Units Google's shipping_weight accepts; anything else drops the attribute.
const WEIGHT_UNITS = new Set(['g', 'kg', 'oz', 'lb', 'lbs'])

function availabilityOf(row: { trackInventory: boolean; stockCount: number | null; outOfStockBehaviour: string; isPreOrder: boolean }): FeedAvailability {
  // Pre-order outranks stock: the shop takes the order either way.
  if (row.isPreOrder) return 'preorder'
  const inStock = !row.trackInventory || (row.stockCount ?? 0) > 0
  if (inStock) return 'in_stock'
  return row.outOfStockBehaviour === 'BACKORDER' ? 'backorder' : 'out_of_stock'
}

function shippingWeightOf(weight: number | string | null | undefined, unit: string | null | undefined): string | undefined {
  const value = weight == null ? null : Number(weight)
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined
  const u = (unit ?? 'kg').toLowerCase()
  if (!WEIGHT_UNITS.has(u)) return undefined
  return `${value} ${u === 'lbs' ? 'lb' : u}`
}

/** Category id -> "Root > Child > Leaf" trail, built once per run from the flat
 *  category list rather than a recursive query per product. */
function buildCategoryPaths(categories: Array<{ id: string; name: string; parentId: string | null }>): Map<string, string> {
  const byId = new Map(categories.map((c) => [c.id, c]))
  const paths = new Map<string, string>()
  for (const category of categories) {
    const names: string[] = []
    let current: { id: string; name: string; parentId: string | null } | undefined = category
    // Depth guard: a cycle in parent ids must not hang the feed.
    for (let hops = 0; current && hops < 20; hops++) {
      names.unshift(current.name)
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
    paths.set(category.id, names.join(' > '))
  }
  return paths
}

function descriptionOf(parent: { meta_description?: string | null; short_description?: string | null; description?: string | null }, fallback: string): string {
  const raw = parent.meta_description || parent.short_description || parent.description || ''
  const text = stripHtmlToPlainText(raw).trim()
  return text || fallback
}

// Identifier fields for one item. GTINs come from the barcode column (per
// variant) or the per-product override; MPN only ever from the per-product row,
// and only on standalone items - one parent-level MPN across every variation
// would claim they are all the same part. SKUs are deliberately never used:
// the shop withholds its buying codes from shoppers, so the feed must not
// publish them either.
//
// Brand runs per-product override, then the supplier the shop files the product
// under (when the setting allows), then the shop-wide default. The supplier is
// the nearest thing the shop already knows to a maker's name, so a catalogue
// filed by supplier needs no per-product brand typed in at all. On a variation
// it is the CHILD row's supplier first: an import fills the supplier in on the
// rows it creates, which are the children, and a parent assembled by hand in the
// admin often has the column left blank. The parent only stands in behind it.
function identifiersOf(
  data: Pick<GsfProductData, 'brand' | 'gtin' | 'mpn'>,
  brandFallbacks: { supplier: string | null; defaultBrand: string | null; useSupplier: boolean },
  barcode: string | null,
  opts: { standalone: boolean },
): { brand?: string; gtin?: string; mpn?: string; identifierExists: boolean } {
  const supplier = brandFallbacks.useSupplier ? brandFallbacks.supplier : null
  const brand = data.brand ?? supplier ?? brandFallbacks.defaultBrand ?? undefined
  const gtin = normaliseGtin(barcode) ?? (opts.standalone ? normaliseGtin(data.gtin) : null) ?? undefined
  const mpn = opts.standalone ? data.mpn ?? undefined : undefined
  return { brand, gtin, mpn, identifierExists: Boolean(gtin || (brand && mpn)) }
}

export async function collectFeedItems(siteUrl: string): Promise<FeedItem[]> {
  const [config, settings] = await Promise.all([getShopConfigCached(), getGsfSettings()])
  const currency = config.currency
  const hideOutOfStock = hidesOutOfStockFromShoppers(config)

  // What the stored figures mean, and the default-zone rates needed to turn a
  // net price gross. Google requires the price a UK shopper actually pays, so
  // the display mode is forced INCLUSIVE regardless of what the storefront
  // prints; on a shop storing gross that is a multiply-by-one.
  const display: PriceDisplay = { mode: 'INCLUSIVE', storedIncludesTax: config.taxMode === 'INCLUSIVE', suffix: '' }
  const rates = new Map<string, number>()
  if (!display.storedIncludesTax) {
    const zoneId = await getDefaultTaxZoneId()
    if (zoneId) {
      for (const rate of await listTaxZoneRates(zoneId)) {
        const value = Number(rate.rate)
        if (Number.isFinite(value)) rates.set(rate.taxClassId, value)
      }
    }
  }
  const gross = (amount: number, taxClassId: string | null): number => {
    const converted = displayAmount(amount, display, taxClassId ? rates.get(taxClassId) ?? 0 : 0)
    return Math.round(converted * 100) / 100
  }

  // ----- Variant-bearing parents ---------------------------------------------
  // Every product shop-variations knows about, narrowed to the ones a shopper
  // can see: ACTIVE, not themselves hidden, physical, and - when the shop hides
  // sold-out products - not out of stock (the same test the sitemap applies,
  // which for a variant parent asks whether every child is out of stock).
  const variationParentIds = await getProductIdsWithVariations()
  let parents: ParentRow[] = []
  if (variationParentIds.length > 0) {
    const stockFilter = hideOutOfStock ? Prisma.sql`AND NOT ${await outOfStockSql()}` : Prisma.empty
    parents = await prisma.$queryRaw<ParentRow[]>`
      SELECT p."id", p."name", p."slug", p."price", p."sale_price", p."description", p."short_description",
             p."meta_description", p."master_category_id", p."tax_class_id", p."supplier"
      FROM "shp_products" p
      WHERE p."id" IN (${Prisma.join(variationParentIds)})
        AND p."status" = 'ACTIVE' AND p."catalogue_hidden" = false AND p."type" = 'PHYSICAL'
        ${stockFilter}
    `
  }

  const payloads = await getEditorPayloadsBatch(parents.map((p) => ({ id: p.id, name: p.name, slug: p.slug, price: Number(p.price) })))

  // The child columns the payload rows do not carry.
  const childIds = [...payloads.values()].flatMap((p) => p.variants.filter((v) => v.enabled).map((v) => v.childProductId))
  const childById = new Map<string, ChildRow>()
  if (childIds.length > 0) {
    const rows = await prisma.$queryRaw<ChildRow[]>`
      SELECT "id", "slug", "status", "track_inventory", "stock_count", "out_of_stock_behaviour",
             "is_pre_order", "tax_class_id", "weight_unit", "supplier"
      FROM "shp_products" WHERE "id" IN (${Prisma.join(childIds)})
    `
    for (const row of rows) childById.set(row.id, row)
  }

  // ----- Standalone products -------------------------------------------------
  // Everything the storefront lists that has no variations. listProducts applies
  // the same ACTIVE/hidden/out-of-stock rules the shop grid does. Parents that
  // are known to shop-variations but have no enabled variants (options-only or
  // add-ons-only products) fall through to here via the payload check below.
  const variationParentSet = new Set(variationParentIds)
  const standalone: ShpProduct[] = []
  for (let page = 1; ; page++) {
    const { products, total } = await listProducts({
      status: 'ACTIVE',
      type: 'PHYSICAL',
      excludeHidden: true,
      storefront: true,
      page,
      perPage: HARD_MAX_PER_PAGE,
      maxPerPage: HARD_MAX_PER_PAGE,
    })
    for (const product of products) {
      const payload = payloads.get(product.id)
      const hasEnabledVariants = (payload?.variants ?? []).some((v) => v.enabled)
      if (variationParentSet.has(product.id) && hasEnabledVariants) continue
      standalone.push(product)
    }
    if (page * HARD_MAX_PER_PAGE >= total || products.length === 0) break
  }

  // ----- Shared lookups ------------------------------------------------------
  const parentIds = parents.map((p) => p.id)
  const standaloneIds = standalone.map((p) => p.id)
  const [productData, mediaByProduct, categories] = await Promise.all([
    getProductDataForProducts([...parentIds, ...standaloneIds]),
    getProductMediaForProducts([...parentIds, ...standaloneIds]),
    listCategories(),
  ])
  const categoryPaths = buildCategoryPaths(categories)

  // Lead category per product: the master when set, else the first filed. Bulk
  // fallback query instead of a per-product helper call.
  const needFallbackCategory = [...parents, ...standalone]
    .filter((p) => !('master_category_id' in p ? p.master_category_id : (p as ShpProduct).masterCategoryId))
    .map((p) => p.id)
  const fallbackCategory = new Map<string, string>()
  if (needFallbackCategory.length > 0) {
    const rows = await prisma.$queryRaw<Array<{ product_id: string; category_id: string }>>`
      SELECT DISTINCT ON ("product_id") "product_id", "category_id"
      FROM "shp_product_categories" WHERE "product_id" IN (${Prisma.join(needFallbackCategory)})
      ORDER BY "product_id"
    `
    for (const row of rows) fallbackCategory.set(row.product_id, row.category_id)
  }
  const productTypeOf = (productId: string, masterCategoryId: string | null): string | undefined => {
    const categoryId = masterCategoryId ?? fallbackCategory.get(productId)
    return categoryId ? categoryPaths.get(categoryId) : undefined
  }

  // First supplier name with anything in it, so a blank column on the row nearest
  // the item still lets the one behind it answer.
  const brandFallbacks = (...suppliers: Array<string | null | undefined>) => ({
    supplier: suppliers.map((s) => s?.trim() || null).find((s) => s !== null) ?? null,
    defaultBrand: settings.defaultBrand,
    useSupplier: settings.brandFromSupplier,
  })

  const imagesOf = (productId: string): string[] =>
    (mediaByProduct.get(productId) ?? [])
      .filter((m) => m.type === 'IMAGE')
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
      .map((m) => m.url)

  const items: FeedItem[] = []
  // The tax class each finished item was priced under, so the delivery pass at
  // the bottom can gross up a service charge exactly as the item's own price was
  // grossed - the charge is folded into the line and taxed at the product's rate.
  const taxClassByItem = new Map<string, string | null>()

  // ----- One item per enabled variant ---------------------------------------
  for (const parent of parents) {
    const data = productData.get(parent.id)
    if (data?.excluded) continue
    const payload = payloads.get(parent.id)
    if (!payload) continue
    const parentImages = imagesOf(parent.id)
    const productType = productTypeOf(parent.id, parent.master_category_id)
    const description = descriptionOf(parent, parent.name)
    const condition = data?.condition ?? settings.defaultCondition

    for (const variant of payload.variants) {
      if (!variant.enabled) continue
      const child = childById.get(variant.childProductId)
      if (!child || child.status !== 'ACTIVE') continue

      const pairs: FeedOptionPair[] = []
      for (const option of payload.options) {
        const value = option.values.find((v) => variant.optionValueIds.includes(v.id))
        if (value) pairs.push({ name: option.name, value: value.label })
      }

      const priced = { price: variant.price, salePrice: variant.salePrice }
      const onSale = isOnSale(priced, config.enabledPriceTypes)
      const taxClassId = child.tax_class_id ?? parent.tax_class_id
      taxClassByItem.set(variant.childProductId, taxClassId)

      items.push({
        id: variant.childProductId,
        itemGroupId: parent.id,
        title: variant.label ? `${parent.name} - ${variant.label}` : parent.name,
        description,
        link: productUrl(siteUrl, child.slug, config.productUrlStyle),
        imageLinks: variant.imageUrls.length > 0 ? variant.imageUrls : parentImages,
        availability: availabilityOf({
          trackInventory: variant.trackInventory,
          stockCount: variant.stockCount,
          outOfStockBehaviour: child.out_of_stock_behaviour,
          isPreOrder: child.is_pre_order,
        }),
        price: gross(variant.price, taxClassId),
        ...(onSale && variant.salePrice != null ? { salePrice: gross(variant.salePrice, taxClassId) } : {}),
        currency,
        ...identifiersOf(data ?? { brand: null, gtin: null, mpn: null }, brandFallbacks(child.supplier, parent.supplier), variant.barcode, { standalone: false }),
        condition,
        productType,
        ...(data?.googleProductCategory ? { googleProductCategory: data.googleProductCategory } : {}),
        shippingWeight: shippingWeightOf(variant.weight, child.weight_unit),
        axes: mapVariantAxes(pairs),
      })
    }
  }

  // ----- One item per standalone product ------------------------------------
  for (const product of standalone) {
    const data = productData.get(product.id)
    if (data?.excluded) continue
    const onSale = isOnSale(product, config.enabledPriceTypes)
    taxClassByItem.set(product.id, product.taxClassId)

    items.push({
      id: product.id,
      title: product.name,
      description: descriptionOf(
        { meta_description: product.metaDescription, short_description: product.shortDescription, description: product.description },
        product.name,
      ),
      link: productUrl(siteUrl, product.slug, config.productUrlStyle),
      imageLinks: imagesOf(product.id),
      availability: availabilityOf(product),
      price: gross(Number(product.price), product.taxClassId),
      ...(onSale && product.salePrice != null ? { salePrice: gross(Number(product.salePrice), product.taxClassId) } : {}),
      currency,
      ...identifiersOf(data ?? { brand: null, gtin: null, mpn: null }, brandFallbacks(product.supplier), product.barcode, { standalone: true }),
      condition: data?.condition ?? settings.defaultCondition,
      productType: productTypeOf(product.id, product.masterCategoryId),
      ...(data?.googleProductCategory ? { googleProductCategory: data.googleProductCategory } : {}),
      shippingWeight: shippingWeightOf(product.weight, product.weightUnit),
    })
  }

  // ----- Delivery times ------------------------------------------------------
  // Attached in one pass over the finished items rather than inside either loop:
  // the whole point of asking a delivery module once for every id in the run is
  // that it resolves the catalogue in batches, and a call per item would undo
  // that. Silent when no delivery-timing module is installed, in which case the
  // items keep whatever Merchant Center's own account settings say.
  const timing = await getDeliveryTiming(items.map((item) => item.id))
  for (const item of items) {
    const times = timing.get(item.id)
    if (!times) continue
    // One figure each way, sent as both ends of Google's range: the shop quotes
    // a single working-day count, and inventing a spread around it would be
    // making up a promise nobody made.
    item.minHandlingTime = times.handlingDays
    item.maxHandlingTime = times.handlingDays
    item.minTransitTime = times.transitDays
    item.maxTransitTime = times.transitDays
    if (times.availabilityDate) item.availabilityDate = times.availabilityDate

    // Each service the product is sold with, as its own shipping group. Off by
    // default and left alone here when off: an item carrying its own groups
    // overrides the Merchant Center account's rates for that item, so it is the
    // owner's call rather than something the feed starts doing on its own.
    if (!settings.sendDeliveryOptions || times.options.length === 0) continue
    const taxClassId = taxClassByItem.get(item.id) ?? null
    item.shippingGroups = times.options.map((option) => ({
      country: settings.shippingCountry,
      service: option.label,
      price: gross(option.price, taxClassId),
      minHandlingTime: option.handlingDays,
      maxHandlingTime: option.handlingDays,
      minTransitTime: option.transitDays,
      maxTransitTime: option.transitDays,
    }))
  }

  return items
}
