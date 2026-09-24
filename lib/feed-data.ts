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
import { effectivePrice, isOnSale } from '@/modules/shop/lib/pricing'
import { hidesOutOfStockFromShoppers, outOfStockSql } from '@/modules/shop/lib/stock-visibility'
import { deductionAmount } from '@/modules/shop/lib/order-size-deduction'
import { getDeductionRules } from '@/modules/shop/lib/db/suppliers'
import { stripHtmlToPlainText } from '@/modules/shop/lib/strip-html'
import type { ShpProduct } from '@/modules/shop/lib/types'
import { getProductIdsWithVariations } from '@/modules/shop-variations/lib/db/variants'
import { getEditorPayloadsBatch } from '@/modules/shop-variations/lib/variants-service'
import { variationCanonicalQuery } from '@/modules/shop-variations/lib/url-selection'
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { getProductDataForProducts } from '@/modules/google-shopping-for-shop/lib/product-data'
import { getDeliveryTiming } from '@/modules/google-shopping-for-shop/lib/delivery-timing'
import { getProductLabels } from '@/modules/google-shopping-for-shop/lib/product-labels'
import { getDeliveryCatalogue, getProductDeliveryScopes } from '@/modules/google-shopping-for-shop/lib/delivery/catalogue'
import { assignDeliveryLabels } from '@/modules/google-shopping-for-shop/lib/delivery/labels'
import { returnPolicyLabelFor } from '@/modules/google-shopping-for-shop/lib/return-policy'
import { variationImageLinks, variantImageKeySet } from '@/modules/google-shopping-for-shop/lib/variation-images'
import { fitShippingLabel, mapVariantAxes, type FeedAvailability, type FeedItem, type FeedOptionPair } from '@/modules/google-shopping-for-shop/lib/feed-xml'
import { partitionPublishable } from '@/modules/google-shopping-for-shop/lib/withholding'
import { adsRedirectLink, taggedLink } from '@/modules/google-shopping-for-shop/lib/feed-link-tags'
import { getCategoryTaxonomy, googleCategoryResolver } from '@/modules/google-shopping-for-shop/lib/category-taxonomy'
import { getTitleTemplatesForItems } from '@/modules/google-shopping-for-shop/lib/title-templates'
import type { TitleTemplateContext } from '@/modules/google-shopping-for-shop/lib/title-template-render'
import { listFeedRules, getRangeAttributeId } from '@/modules/google-shopping-for-shop/lib/feed-rules/store'
import { attributeIdsIn, categoryTrail, fillAttributeFacts, readProductCategories, textFact } from '@/modules/google-shopping-for-shop/lib/feed-rules/facts'
import { optionFieldKey } from '@/modules/google-shopping-for-shop/lib/feed-rules/fields'
import {
  EMPTY_OUTCOME,
  evaluateFeedRules,
  type Exclusion,
  type RuleFacts,
  type RuleOutcome,
  type RuleSubject,
} from '@/modules/google-shopping-for-shop/lib/feed-rules/evaluate'
import { customLabelsOf, identifiersAfterRules, titleAfterRules, type IdentityInputs, type TitleInputs } from '@/modules/google-shopping-for-shop/lib/feed-rules/apply'
import { manualChoiceOf } from '@/modules/google-shopping-for-shop/lib/feed-rules/manual-choice'
import type { FeedRule } from '@/modules/google-shopping-for-shop/lib/feed-rules/types'
import { groupPromotions, promotionTerms, promotionTitle, type PromotionCandidate } from '@/modules/google-shopping-for-shop/lib/promotions'
import type { FeedPromotion } from '@/modules/google-shopping-for-shop/lib/promotions-xml'
import { freshWindow, promotionIdForRevision } from '@/modules/google-shopping-for-shop/lib/promotion-windows'
import { resolvePromotionWindows } from '@/modules/google-shopping-for-shop/lib/promotion-windows-data'

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
  returnable: boolean | null
  non_returnable_note: string | null
}

// The per-child columns VariantEditorRow does not carry (availability inputs
// and the deep-link slug), read once for every child in the run.
type ChildRow = {
  id: string
  slug: string
  status: string
  // The code this variation is ordered by, published as Google's `mpn` when
  // the owner has said the code is the maker's rather than their own.
  sku: string | null
  track_inventory: boolean
  stock_count: number | null
  out_of_stock_behaviour: string
  is_pre_order: boolean
  tax_class_id: string | null
  weight_unit: string | null
  supplier: string | null
  returnable: boolean | null
  non_returnable_note: string | null
  order_size_deduction: unknown
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
/** The two documents one pass over the catalogue produces. They are fetched by
 *  Google separately, minutes or hours apart, and are joined only by the
 *  promotion ids both spell - which is precisely why they are derived together
 *  here rather than by two scans that could disagree. */
/** A product the feed built a row for and then withheld, with the reason. Kept
 *  so the admin can say WHY something is not being advertised - a silently
 *  dropped product is a support ticket six weeks later. */
export type FeedWithheldItem = { id: string; title: string; reason: 'no-image' }

/** An item built in full and then kept out on purpose: by the owner's own
 *  choice on the product or variation, or by a feed rule. Kept whole, because
 *  the workbench lists these too - "why is this not on Google" wants an
 *  answer on the same screen as everything that is. */
export type FeedExcludedItem = { item: FeedItem; exclusion: Exclusion }

/** The feed rules as this build applied them. The subjects are held for the
 *  workbench's preview, which runs a draft rule over them without rebuilding
 *  the catalogue. */
export type FeedRulesRun = {
  rules: FeedRule[]
  rangeAttributeId: string | null
  subjects: RuleSubject[]
  outcomes: Map<string, RuleOutcome>
  /** Attribute ids whose values are already on the subjects. */
  attributesRead: Set<string>
  /** Every variation option name in the catalogue, as the shop spells it -
   *  the Option fields a rule can ask about. */
  optionNames: string[]
}

/** What an item's feed title was made from: the title it would carry with no
 *  template, and the tokens a template can use. Handed back so the admin
 *  workbench previews a template against exactly what the feed fills it from,
 *  rather than rebuilding the same answer from the tables and drifting. */
export type FeedTitleSource = { originalTitle: string; parentTitle: string; context: TitleTemplateContext }

export type FeedData = {
  items: FeedItem[]
  promotions: FeedPromotion[]
  withheld: FeedWithheldItem[]
  excluded: FeedExcludedItem[]
  /** Keyed by item id; one entry per item built, withheld and excluded ones included. */
  titleSources: Map<string, FeedTitleSource>
  rules: FeedRulesRun
}

/** One built row waiting for the feed rules: the row itself, what the rules
 *  are asked about it, and the inputs its identifiers and title are finished
 *  from once the rules have answered. */
type PendingItem = {
  item: FeedItem
  subject: RuleSubject
  identity: IdentityInputs
  titleInputs: TitleInputs
}


export async function collectFeedItems(siteUrl: string): Promise<FeedData> {
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
  // can see: ACTIVE, not themselves hidden, not a spare part (shop 404s their
  // pages, so a feed entry would be a dead link), physical, and - when the shop hides
  // sold-out products - not out of stock (the same test the sitemap applies,
  // which for a variant parent asks whether every child is out of stock).
  const variationParentIds = await getProductIdsWithVariations()
  let parents: ParentRow[] = []
  if (variationParentIds.length > 0) {
    const stockFilter = hideOutOfStock ? Prisma.sql`AND NOT ${await outOfStockSql()}` : Prisma.empty
    parents = await prisma.$queryRaw<ParentRow[]>`
      SELECT p."id", p."name", p."slug", p."price", p."sale_price", p."description", p."short_description",
             p."meta_description", p."master_category_id", p."tax_class_id", p."supplier",
             p."returnable", p."non_returnable_note"
      FROM "shp_products" p
      WHERE p."id" IN (${Prisma.join(variationParentIds)})
        AND p."status" = 'ACTIVE' AND p."catalogue_hidden" = false AND p."parts_only" = false AND p."type" = 'PHYSICAL'
        ${stockFilter}
    `
  }

  const payloads = await getEditorPayloadsBatch(parents.map((p) => ({ id: p.id, name: p.name, slug: p.slug, price: Number(p.price) })))

  // The child columns the payload rows do not carry.
  const childIds = [...payloads.values()].flatMap((p) => p.variants.filter((v) => v.enabled).map((v) => v.childProductId))
  const childById = new Map<string, ChildRow>()
  if (childIds.length > 0) {
    const rows = await prisma.$queryRaw<ChildRow[]>`
      SELECT "id", "slug", "status", "sku", "track_inventory", "stock_count", "out_of_stock_behaviour",
             "is_pre_order", "tax_class_id", "weight_unit", "supplier",
             "returnable", "non_returnable_note", "order_size_deduction"
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
  const [productData, mediaByProduct, categories, categoryTaxonomy, titleTemplates, rules, rangeAttributeId, filedCategories] = await Promise.all([
    // Variations too: each can carry the owner's own feed choice.
    getProductDataForProducts([...parentIds, ...standaloneIds, ...childIds]),
    getProductMediaForProducts([...parentIds, ...standaloneIds]),
    listCategories(),
    getCategoryTaxonomy(),
    getTitleTemplatesForItems([...childIds, ...standaloneIds]),
    listFeedRules(),
    getRangeAttributeId(),
    readProductCategories([...parentIds, ...standaloneIds]),
  ])
  const categoryPaths = buildCategoryPaths(categories)
  const categoryParent = new Map(categories.map((c) => [c.id, c.parentId]))
  // Every category a product is filed in, and every one above those - what a
  // rule's "category is in or under" reads.
  const categoryFact = (productId: string, masterCategoryId: string | null): readonly string[] =>
    categoryTrail([...(masterCategoryId ? [masterCategoryId] : []), ...(filedCategories.get(productId) ?? [])], categoryParent)
  // Google's own taxonomy, resolved through the category tree so a leaf with
  // nothing typed against it still answers with its parent's.
  const googleCategoryFor = googleCategoryResolver(categories, categoryTaxonomy)

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
  // The one category an item is filed under for Google's benefit: the master
  // where the product has one, else the first it is filed in. Both the shop's
  // own trail (product_type) and Google's taxonomy come off this same answer,
  // so the two can never describe an item as two different things.
  const leadCategoryOf = (productId: string, masterCategoryId: string | null): string | undefined =>
    masterCategoryId ?? fallbackCategory.get(productId)
  const productTypeOf = (productId: string, masterCategoryId: string | null): string | undefined => {
    const categoryId = leadCategoryOf(productId, masterCategoryId)
    return categoryId ? categoryPaths.get(categoryId) : undefined
  }
  // A product's own answer outranks its category's - it is the more specific
  // thing said about it, and the only reason to type one in is to disagree.
  const googleCategoryOf = (productId: string, masterCategoryId: string | null, own: string | null | undefined): string | undefined =>
    own?.trim() || googleCategoryFor(leadCategoryOf(productId, masterCategoryId))

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

  // Read once for the whole run: off is the common case, and asking per item
  // would be asking the same question twenty thousand times.
  const returnLabels = settings.returnPolicyLabelsEnabled

  const pending: PendingItem[] = []
  const optionNames = new Map<string, string>()
  const titleSources = new Map<string, FeedTitleSource>()
  // The tax class each finished item was priced under, so the delivery pass at
  // the bottom can gross up a service charge exactly as the item's own price was
  // grossed - the charge is folded into the line and taxed at the product's rate.
  const taxClassByItem = new Map<string, string | null>()

  // Items that would lose money if their supplier's order-size threshold were
  // met, gathered as the two loops go rather than in a second pass, because both
  // already have the supplier, the stamped amount and the sale price in hand.
  //
  // The qualifying test is shop's own, spelt exactly as lib/checkout.ts spells
  // it, because a promotion advertised on an item the basket will not discount
  // is the one failure mode worth designing against:
  //   - the supplier on the ROW ITSELF, with no fall back to the listing above
  //     it (checkout reads line.product.supplier, and for a variation the
  //     product IS the child);
  //   - a stamped amount that survives deductionAmount (null, zero and
  //     negatives are all "no amount");
  //   - and the amount strictly under what the item is charged, since the rule
  //     floors a line at zero rather than going negative. Such a row would
  //     advertise more than ever comes off, and shop's own report already flags
  //     it as a mis-stamp.
  // Being on offer is NOT one of the tests, and has not been since shop stopped
  // asking: an amount may sit inside an item's ordinary price just as well as
  // inside a sale one, and the price passed below is whichever the shop charges.
  // Empty on every shop not running the feature, and it costs nothing to be.
  type OsdCandidate = { itemId: string; supplier: string; storedDeduction: number; taxClassId: string | null }
  const osdCandidates: OsdCandidate[] = []
  const promotionsWanted = config.orderSizeDeductionEnabled && settings.promotionsFeedEnabled
  const considerForPromotion = (
    itemId: string,
    supplier: string | null | undefined,
    stored: number | string | null | undefined,
    chargedUnitPrice: number | null,
    taxClassId: string | null,
  ): void => {
    if (!promotionsWanted) return
    const name = supplier?.trim()
    if (!name) return
    const amount = deductionAmount(stored)
    if (amount == null) return
    if (chargedUnitPrice == null || !(amount < chargedUnitPrice)) return
    osdCandidates.push({ itemId, supplier: name, storedDeduction: amount, taxClassId })
  }

  // ----- One item per enabled variant ---------------------------------------
  for (const parent of parents) {
    const data = productData.get(parent.id)
    const payload = payloads.get(parent.id)
    if (!payload) continue
    const parentImages = imagesOf(parent.id)
    // Every picture any of this listing's variations owns - the disabled ones
    // too, since a variation being off the shelf does not make its photograph
    // anybody else's. Built once here, read once per variation below.
    const variantImageKeys = variantImageKeySet(payload.variants)
    const productType = productTypeOf(parent.id, parent.master_category_id)
    const googleCategory = googleCategoryOf(parent.id, parent.master_category_id, data?.googleProductCategory)
    const description = descriptionOf(parent, parent.name)
    const condition = data?.condition ?? settings.defaultCondition
    // What the rules read about the listing, shared by every variation of it.
    // Attribute values are added once the whole catalogue is built.
    const listingFacts: RuleFacts = {
      supplier: textFact(parent.supplier),
      category: categoryFact(parent.id, parent.master_category_id),
      status: ['ACTIVE'],
    }

    for (const variant of payload.variants) {
      if (!variant.enabled) continue
      const child = childById.get(variant.childProductId)
      if (!child || child.status !== 'ACTIVE') continue

      const pairs: FeedOptionPair[] = []
      for (const option of payload.options) {
        const value = option.values.find((v) => variant.optionValueIds.includes(v.id))
        if (value) pairs.push({ name: option.name, value: value.label })
      }

      // Where the item lands. The address the sitemap publishes and the page
      // declares canonical for this combination - the parent listing carrying
      // the option parameters - and NOT the variation's own child-product slug.
      // Both render the same configured page, but the child slug is one the
      // page itself disowns: Google follows it out of the feed, reads the
      // canonical, and files every variation under "alternative page with a
      // proper canonical tag" instead of indexing it. Same function the sitemap
      // and the canonical tag spell it with, so the three cannot disagree.
      //
      // The child slug still stands in where the combination has no address of
      // its own (an option left unanswered, two options sharing a parameter
      // name) - it renders the right page, and a landing page that works beats
      // a tidy one that does not. `id` is untouched either way, so Merchant
      // Center sees the same listings it always did, at a new address.
      const variationQuery = variationCanonicalQuery(payload.options, variant.optionValueIds)
      const link = variationQuery
        ? `${productUrl(siteUrl, parent.slug, config.productUrlStyle)}?${variationQuery}`
        : productUrl(siteUrl, child.slug, config.productUrlStyle)

      const priced = { price: variant.price, salePrice: variant.salePrice }
      const onSale = isOnSale(priced, config.enabledPriceTypes)
      const taxClassId = child.tax_class_id ?? parent.tax_class_id
      taxClassByItem.set(variant.childProductId, taxClassId)
      const identity: IdentityInputs = {
        data: data ?? { brand: null, gtin: null, mpn: null },
        fallbacks: brandFallbacks(child.supplier, parent.supplier),
        // The variation's own codes. Its own SKU and not its listing's: a
        // part number names one part, and the child row is the part.
        codes: { barcode: variant.barcode, sku: variant.sku },
        standalone: false,
        mpnFromSku: settings.mpnFromSku,
      }
      // Before the rules: what a rule asking about the brand or the barcode
      // is asking about.
      const identifiers = identifiersAfterRules(identity, EMPTY_OUTCOME)
      const originalTitle = variant.label ? `${parent.name} - ${variant.label}` : parent.name

      const item: FeedItem = {
        id: variant.childProductId,
        itemGroupId: parent.id,
        // Finished once the rules have run.
        title: originalTitle,
        description,
        link,
        imageLinks: variationImageLinks({
          ownImages: variant.imageUrls,
          parentImages,
          allVariantImages: variantImageKeys,
          includeParentImages: settings.parentImagesOnVariations,
        }),
        availability: availabilityOf({
          trackInventory: variant.trackInventory,
          stockCount: variant.stockCount,
          outOfStockBehaviour: child.out_of_stock_behaviour,
          isPreOrder: child.is_pre_order,
        }),
        price: gross(variant.price, taxClassId),
        ...(onSale && variant.salePrice != null ? { salePrice: gross(variant.salePrice, taxClassId) } : {}),
        currency,
        identifierExists: identifiers.identifierExists,
        condition,
        productType,
        ...(googleCategory ? { googleProductCategory: googleCategory } : {}),
        shippingWeight: shippingWeightOf(variant.weight, child.weight_unit),
        // The variation's own answer where it has one, its listing's where it
        // has not - resolved here rather than in a pass at the bottom because
        // both rows are already in hand and neither costs a query.
        ...(returnLabels
          ? { returnPolicyLabel: returnPolicyLabelFor(
              { returnable: child.returnable, nonReturnableNote: child.non_returnable_note },
              { returnable: parent.returnable, nonReturnableNote: parent.non_returnable_note },
            ) }
          : {}),
        axes: mapVariantAxes(pairs),
      }

      const own: RuleFacts = {
        supplier: textFact(child.supplier),
        brand: textFact(identifiers.brand),
        stock_quantity: variant.trackInventory ? variant.stockCount ?? 0 : null,
        stock_status: [item.availability],
        price: item.price,
        sale_price: item.salePrice ?? null,
        status: textFact(child.status),
        has_image: item.imageLinks.some((url) => url.trim() !== ''),
        has_gtin: Boolean(identifiers.gtin),
      }
      for (const pair of pairs) {
        const key = optionFieldKey(pair.name)
        own[key] = textFact(pair.value)
        if (!optionNames.has(key)) optionNames.set(key, pair.name.trim())
      }

      pending.push({
        item,
        subject: {
          itemId: item.id,
          title: originalTitle,
          parentId: parent.id,
          own,
          parent: listingFacts,
          manual: manualChoiceOf(productData.get(variant.childProductId), data),
        },
        identity,
        titleInputs: { originalTitle, parentTitle: parent.name, variantLabel: variant.label, sku: child.sku, options: pairs },
      })

      considerForPromotion(
        variant.childProductId,
        // The child's own supplier and nothing behind it - see the note above.
        child.supplier,
        child.order_size_deduction as number | string | null,
        effectivePrice(priced, config.enabledPriceTypes),
        taxClassId,
      )
    }
  }

  // ----- One item per standalone product ------------------------------------
  for (const product of standalone) {
    const data = productData.get(product.id)
    const onSale = isOnSale(product, config.enabledPriceTypes)
    const googleCategory = googleCategoryOf(product.id, product.masterCategoryId, data?.googleProductCategory)
    taxClassByItem.set(product.id, product.taxClassId)
    const identity: IdentityInputs = {
      data: data ?? { brand: null, gtin: null, mpn: null },
      fallbacks: brandFallbacks(product.supplier),
      codes: { barcode: product.barcode, sku: product.sku },
      standalone: true,
      mpnFromSku: settings.mpnFromSku,
    }
    const identifiers = identifiersAfterRules(identity, EMPTY_OUTCOME)

    const item: FeedItem = {
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
      identifierExists: identifiers.identifierExists,
      condition: data?.condition ?? settings.defaultCondition,
      productType: productTypeOf(product.id, product.masterCategoryId),
      ...(googleCategory ? { googleProductCategory: googleCategory } : {}),
      shippingWeight: shippingWeightOf(product.weight, product.weightUnit),
      // No listing above it to inherit from, so it answers as both halves.
      ...(returnLabels
        ? { returnPolicyLabel: returnPolicyLabelFor(
            { returnable: product.returnable, nonReturnableNote: product.nonReturnableNote },
            undefined,
          ) }
        : {}),
    }

    pending.push({
      item,
      subject: {
        itemId: product.id,
        title: product.name,
        parentId: null,
        own: {
          supplier: textFact(product.supplier),
          brand: textFact(identifiers.brand),
          category: categoryFact(product.id, product.masterCategoryId),
          stock_quantity: product.trackInventory ? product.stockCount ?? 0 : null,
          stock_status: [item.availability],
          price: item.price,
          sale_price: item.salePrice ?? null,
          status: textFact(product.status),
          has_image: item.imageLinks.some((url) => url.trim() !== ''),
          has_gtin: Boolean(identifiers.gtin),
        },
        parent: null,
        manual: manualChoiceOf(data, undefined),
      },
      identity,
      titleInputs: { originalTitle: product.name, parentTitle: product.name, sku: product.sku, options: [] },
    })

    considerForPromotion(
      product.id,
      product.supplier,
      product.orderSizeDeduction,
      effectivePrice(product, config.enabledPriceTypes),
      product.taxClassId,
    )
  }

  // ----- Feed rules -----------------------------------------------------------
  // Every row is built before any rule is asked about it, so a rule sees the
  // same price, stock and brand the feed would send without it. Then each row
  // is finished from its outcome - identifiers, title, custom labels - and the
  // ones kept out, by the owner's own hand or by a rule, step aside here,
  // before the delivery passes below spend anything on them. The precedence is
  // the evaluator's (lib/feed-rules/evaluate.ts).
  const subjects = pending.map((entry) => entry.subject)
  const attributesRead = new Set(attributeIdsIn(rules.filter((rule) => rule.enabled)))
  if (rangeAttributeId) attributesRead.add(rangeAttributeId)
  await fillAttributeFacts(subjects, [...attributesRead], rangeAttributeId)
  const outcomes = evaluateFeedRules(rules, subjects)

  const items: FeedItem[] = []
  const excluded: FeedExcludedItem[] = []
  for (const { item, subject, identity, titleInputs } of pending) {
    const outcome = outcomes.get(subject.itemId) ?? EMPTY_OUTCOME
    const identifiers = identifiersAfterRules(identity, outcome)
    const { title, context } = titleAfterRules(titleInputs, identifiers, titleTemplates.get(item.id), outcome)
    const finished: FeedItem = { ...item, title, ...identifiers }
    const labels = customLabelsOf(outcome)
    if (labels) finished.customLabels = labels
    titleSources.set(item.id, { originalTitle: titleInputs.originalTitle, parentTitle: titleInputs.parentTitle, context })
    if (outcome.exclusion) excluded.push({ item: finished, exclusion: outcome.exclusion })
    else items.push(finished)
  }

  // ----- Delivery groups -----------------------------------------------------
  // The label Merchant Center matches its own delivery rates against, taken
  // from whichever product attribute the owner picked. One pass over the
  // finished items and one call for the whole run, for the same reason the
  // delivery times below take one: a call per item would undo the batching that
  // makes a catalogue-sized feed affordable at all.
  //
  // A variation answers for itself where it has an answer, and inherits its
  // parent's where it has not - which is how the shop reads everywhere else,
  // and how an owner who set the attribute once on the parent expects it to
  // behave. Off unless the owner chose an attribute, and silent when nothing
  // publishes attributes at all.
  if (settings.shippingLabelSource === 'delivery-services') {
    // The other source: the group each product's own DELIVERY PRICE is written
    // against - its range, category or supplier - taken from whichever module
    // publishes delivery services, resolved exactly as that module resolves it
    // for the basket.
    //
    // Which is the whole point of doing it this way. The rate groups this
    // module sends to Merchant Center are built from those same groups and
    // named by the same function, so every label in the feed is one Merchant
    // Center has a price for. Labelling by an attribute cannot promise that:
    // the owner has to keep two lists in step by hand, and a product whose
    // label matches no rate group silently takes whatever the last one says.
    //
    // No inheritance pass here, unlike the attribute below: the delivery
    // module already falls a variation back to its parent for every scope fact
    // it lacks, so an answer for a variation is the answer.
    const [scopes, catalogue] = await Promise.all([
      getProductDeliveryScopes(items.map((item) => item.id)),
      getDeliveryCatalogue(),
    ])
    const labels = assignDeliveryLabels(catalogue?.scopes ?? [])
    for (const item of items) {
      const scopeId = scopes.get(item.id)?.scopeId
      const label = scopeId ? labels.byScopeId.get(scopeId) : undefined
      // A product in no delivery group at all gets no label. What that means at
      // Google depends on the account: where a service has a rate group with no
      // labels on it, such a product lands there; where none of them has one -
      // which is the case on a shop whose delivery rules are all written
      // against ranges - it gets NO delivery price at all, and Google stops
      // showing it. Either way, inventing a label would be worse: it would put
      // the product on a price that was never meant for it. The Delivery tab
      // counts these and says which of the two is happening.
      if (label) item.shippingLabel = label
    }
  } else if (settings.shippingLabelAttributeId) {
    const wanted = new Set<string>()
    for (const item of items) {
      wanted.add(item.id)
      if (item.itemGroupId) wanted.add(item.itemGroupId)
    }
    const labels = await getProductLabels(settings.shippingLabelAttributeId, [...wanted])
    for (const item of items) {
      const own = labels.get(item.id)
      const inherited = item.itemGroupId ? labels.get(item.itemGroupId) : undefined
      const fitted = fitShippingLabel(own ?? inherited)
      if (fitted) item.shippingLabel = fitted
    }
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

  // ----- Withholding what cannot possibly be accepted -------------------------
  //
  // `image_link` is required, and Google rejects an item without one every
  // single time - there is no shop, no category and no country where an
  // imageless row is anything but a guaranteed disapproval sitting in Merchant
  // Center. Publishing it anyway buys nothing and costs the owner a rejection
  // they then have to interpret, so the row is withheld and counted instead.
  //
  // Counted rather than merely dropped: silence here just moves the confusion
  // from Merchant Center to "why is this product not on Google", which is the
  // harder question to answer. The settings tab reads this back.
  const { publishable, withheld } = partitionPublishable(items)
  items.length = 0
  items.push(...publishable)

  // ----- Campaign tags -------------------------------------------------------
  // Last of all, on the finished list, so the address every rule above reasoned
  // about is the plain one and only what actually reaches Google carries the
  // tag.
  //
  // Two addresses, differing in one parameter: `link` for a free listing and
  // `ads_redirect` for a paid click. Google's free Shopping results carry no
  // identifier of their own, so without this tag a free click is
  // indistinguishable from somebody typing the address in - which is the whole
  // reason the live figures on the Reports tab can exist at all.
  //
  // The ads address is composed from the UNTAGGED link, before the free tag
  // goes on, or it would end up carrying both mediums.
  //
  // Worth separating two things that sit next to each other here. The warning
  // in lib/feed-link-tags.ts about never parsing and re-serialising a URL is
  // about the ENCODING of the option parameters already on it: those are
  // spelled by shop-variations and have to come out of here character for
  // character, or the feed address stops matching the sitemap and the canonical
  // tag. Adding the campaign parameters does not affect that match at all -
  // Google follows the tagged address, the page renders and declares the same
  // canonical it always did, and the tag is simply not part of that comparison.
  if (settings.linkTaggingEnabled) {
    for (const item of items) {
      item.adsRedirect = adsRedirectLink(item.link)
      item.link = taggedLink(item.link)
    }
  }

  // A withheld or excluded row must not leave a promotion behind advertising
  // it. Cheap to keep in step here, and a promotions source naming items that
  // are not in the product feed is its own class of Merchant Center complaint.
  if (withheld.length > 0 || excluded.length > 0) {
    const live = new Set(items.map((i) => i.id))
    for (let i = osdCandidates.length - 1; i >= 0; i--) {
      const candidate = osdCandidates[i]
      if (candidate && !live.has(candidate.itemId)) osdCandidates.splice(i, 1)
    }
  }

  // ----- Promotions ----------------------------------------------------------
  // One promotion per (supplier, stamped amount), and the id of the one it
  // belongs to written onto each item. The supplier read is the last query of
  // the run and only happens where something actually qualifies, so a shop not
  // running the deduction - or running it with the promotions source switched
  // off - pays nothing for any of this.
  //
  // Google's minimum spend is a WHOLE-BASKET figure and the shop's is one
  // supplier's goods, delivery excluded. Nothing in the specification can
  // express the narrower condition, so it goes in the terms instead
  // (lib/promotions.ts) and the owner switches the whole thing on knowing that.
  const promotions: FeedPromotion[] = []
  if (osdCandidates.length > 0) {
    const rules = await getDeductionRules(osdCandidates.map((c) => c.supplier))
    const thresholds = new Map(rules.map((r) => [r.supplier.trim().toLowerCase(), r.threshold]))
    const candidates: PromotionCandidate[] = []
    for (const candidate of osdCandidates) {
      const threshold = thresholds.get(candidate.supplier.toLowerCase())
      // A supplier with no threshold has no rule, so nothing of theirs can ever
      // qualify and there is no offer to advertise.
      if (threshold == null || threshold <= 0) continue
      candidates.push({
        itemId: candidate.itemId,
        supplier: candidate.supplier,
        storedPence: Math.round(candidate.storedDeduction * 100),
        // Both figures are stored-price terms, exactly as the basket compares
        // them, and both are grossed the same way every price in this feed is:
        // Google quotes a UK shopper what they pay.
        grossDeduction: gross(candidate.storedDeduction, candidate.taxClassId),
        grossThreshold: gross(threshold, candidate.taxClassId),
      })
    }

    const { promotions: built, promotionIdByItem } = groupPromotions(candidates)

    // The id and the dates come off the stored window, never off the clock.
    // Google refuses to change a promotion's start time once it exists, so
    // stamping `now` every fetch was an edit it rejected every time; and it caps
    // a promotion at 183 days, so a standing offer has to become a NEW
    // promotion before the cap rather than one with an end date that keeps
    // moving. Both are lib/promotion-windows.ts's job, and the row it keeps is
    // also what lets the two documents - fetched hours apart - agree on the id.
    const now = new Date()
    const stored = await resolvePromotionWindows(built.map((p) => p.id), now)
    const windows = new Map(built.map((p) => [p.id, stored.get(p.id) ?? freshWindow(p.id, 0, now)]))
    const idFor = (baseKey: string): string => {
      const window = windows.get(baseKey)
      return window ? promotionIdForRevision(window.baseKey, window.revision) : baseKey
    }

    for (const item of items) {
      const baseKey = promotionIdByItem.get(item.id)
      if (baseKey) item.promotionIds = [idFor(baseKey)]
    }

    for (const promotion of built) {
      const window = windows.get(promotion.id)
      if (!window) continue
      promotions.push({
        id: idFor(promotion.id),
        longTitle: promotionTitle(promotion, config.currencySymbol),
        moneyOff: promotion.moneyOff,
        minimumPurchase: promotion.minimumPurchase,
        currency,
        finePrint: promotionTerms(promotion, config.currencySymbol, settings.promotionsFinePrint),
        startsAt: window.startsAt,
        endsAt: window.endsAt,
      })
    }
  }

  return {
    items,
    promotions,
    withheld,
    excluded,
    titleSources,
    rules: {
      rules,
      rangeAttributeId,
      subjects,
      outcomes,
      attributesRead,
      optionNames: [...optionNames.values()].sort((a, b) => a.localeCompare(b)),
    },
  }
}
