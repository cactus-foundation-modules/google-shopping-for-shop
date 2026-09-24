import { randomBytes } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { GSF_CONDITIONS, GSF_OPT_IN_STYLES, asLabelSource, type GsfCondition, type GsfLabelSource, type GsfOptInStyle, type GsfSettings } from '@/modules/google-shopping-for-shop/lib/types'
import { asGranularity, type BestSellerGranularity } from '@/modules/google-shopping-for-shop/lib/best-sellers/types'
import { dayFromDate, isDayString } from '@/modules/google-shopping-for-shop/lib/performance/days'

function asCondition(value: unknown): GsfCondition {
  return GSF_CONDITIONS.includes(value as GsfCondition) ? (value as GsfCondition) : 'new'
}

// A position Google's own script understands. Anything else falls back to the
// middle of the page, which is both Google's default and the placement they say
// gets opted into most.
export function asOptInStyle(value: unknown): GsfOptInStyle {
  return GSF_OPT_IN_STYLES.includes(value as GsfOptInStyle) ? (value as GsfOptInStyle) : 'CENTER_DIALOG'
}

// Working days between order and doorstep. Whole, positive, and short of a
// year: the figure only ever becomes a date on a survey invitation, and a
// nonsense one there is a survey nobody is ever asked to fill in.
export function asDeliveryDays(value: unknown): number {
  const days = typeof value === 'number' ? Math.round(value) : Number.NaN
  if (!Number.isFinite(days)) return 5
  return Math.min(365, Math.max(0, days))
}

type SettingsRow = {
  enabled: boolean
  feed_token: string | null
  default_brand: string | null
  brand_from_supplier: boolean
  mpn_from_sku: boolean
  default_condition: string
  merchant_id: string | null
  feed_label: string | null
  send_delivery_options: boolean
  shipping_country: string | null
  shipping_label_attribute_id: string | null
  shipping_label_source: string | null
  delivery_sync_enabled: boolean
  reviews_feed_enabled: boolean
  customer_reviews_enabled: boolean
  customer_reviews_style: string | null
  customer_reviews_delivery_days: number
  return_policy_labels_enabled: boolean
  parent_images_on_variations: boolean
  promotions_feed_enabled: boolean
  promotions_fine_print: string | null
  feed_data_source_id: string | null
  feed_data_source_detected_id: string | null
  disapproval_alert_threshold: number
  alert_email_enabled: boolean
  alert_email: string | null
  issues_checked_at: Date | null
  last_disapproved_count: number | null
  performance_import_enabled: boolean
  performance_backfill_days: number
  performance_retention_days: number
  performance_imported_through: Date | null
  performance_checked_at: Date | null
  performance_conversions_available: boolean | null
  performance_conversions_checked_at: Date | null
  performance_failed_at: Date | null
  performance_last_error: string | null
  best_sellers_enabled: boolean
  best_sellers_category_ids: string | null
  best_sellers_granularity: string | null
  best_sellers_limit: number
  best_sellers_checked_at: Date | null
  link_tagging_enabled: boolean
  click_tracking_enabled: boolean
  click_retention_days: number
  price_push_enabled: boolean
  push_data_source_id: string | null
  push_linked_source_ids: unknown
  push_linked_at: Date | null
  push_debounce_seconds: number
  push_reconcile_sample: number
  content_language: string
  ads_enabled: boolean
  ads_spend_import_enabled: boolean
  ads_spend_backfill_days: number
  ads_spend_retention_days: number
  ads_conversion_upload_enabled: boolean
  ads_conversion_action: string | null
  ads_conversion_action_name: string | null
  ads_conversion_action_primary: boolean | null
  ads_conversion_action_checked_at: Date | null
  ads_currency: string | null
  ads_time_zone: string | null
  ads_account_checked_at: Date | null
}

// How many products may newly stop being shown before the site says something.
// Whole and not negative; a shop with a hundred thousand items may want a much
// larger figure, so the ceiling is generous rather than opinionated. 0 is off.
export function asAlertThreshold(value: unknown): number {
  const count = typeof value === 'number' ? Math.round(value) : Number.NaN
  if (!Number.isFinite(count)) return 25
  return Math.min(1_000_000, Math.max(0, count))
}

// A Merchant Center data source number is digits, like the account number;
// owners paste them with spaces or an "ID:" in front. Nothing left is "not set".
export function asDataSourceId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.replace(/\D+/g, '') || null
}

/**
 * A Google Ads conversion action resource name, or nothing.
 *
 * Checked rather than trimmed because this string becomes SYNTAX: it is
 * interpolated into a GAQL query (there is no parameter binding in that
 * language) and sent as a field in an upload. The only shape Google ever issues
 * is customers/{digits}/conversionActions/{digits}, so anything else is stored
 * as NULL - which reads as "not set up" and stops the upload, rather than
 * reaching Google as a malformed query.
 */
export function asConversionActionName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return /^customers\/\d+\/conversionActions\/\d+$/.test(name) ? name : null
}

// Not a full address parser - the point is only to refuse something that could
// never be delivered to, so an alert is not silently posted into the void.
//
// This is the LAST line of defence, not the first: the settings route rejects a
// malformed address with a message the owner can read (a save that quietly
// blanked the field was how a typo became a silent no-op). Anything reaching
// here malformed is a caller that skipped the route, and storing NULL is the
// safe answer for that.
export function asAlertEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const address = value.trim()
  if (address === '') return null
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(address) ? address : null
}

// A country Google will take on a shipping group: two letters, upper case.
// Anything else falls back to GB rather than sending a group Google rejects.
export function asShippingCountry(value: unknown): string {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return /^[A-Z]{2}$/.test(code) ? code : 'GB'
}

// How far back the first performance import reaches. A quarter by default;
// two years is as far as anyone sensibly asks Google for daily figures, and
// nothing below a day is a window at all.
export function asBackfillDays(value: unknown): number {
  const days = typeof value === 'number' ? Math.round(value) : Number.NaN
  if (!Number.isFinite(days)) return 90
  return Math.min(730, Math.max(1, days))
}

// How long a day's figures are kept. 0 is "keep the lot", which is a real
// answer for a shop that wants its whole history; ten years is the ceiling so
// a typo cannot make the table immortal by accident.
export function asRetentionDays(value: unknown): number {
  const days = typeof value === 'number' ? Math.round(value) : Number.NaN
  if (!Number.isFinite(days)) return 400
  return Math.min(3_650, Math.max(0, days))
}

// Ranked rows kept per category. Google's own LIMIT clause refuses anything
// above a thousand, so this is clamped to what the query could ask for.
export function asBestSellersLimit(value: unknown): number {
  const limit = typeof value === 'number' ? Math.round(value) : Number.NaN
  if (!Number.isFinite(limit)) return 50
  return Math.min(1_000, Math.max(1, limit))
}

// How long a landing is kept. Thirteen months by default, so last year's same
// month is still there to compare against; 0 is "keep the lot", which is a real
// answer; ten years is the ceiling so a typo cannot make the table immortal.
// Same shape as asRetentionDays above, and deliberately a separate function:
// these are landings rather than Google's daily figures, and an owner may well
// want to keep one longer than the other.
export function asClickRetentionDays(value: unknown): number {
  const days = typeof value === 'number' ? Math.round(value) : Number.NaN
  if (!Number.isFinite(days)) return 400
  return Math.min(3_650, Math.max(0, days))
}

// Google's numeric product category ids, as the owner typed them. Anything
// that is not a run of digits is dropped rather than sent: it would be a
// syntax error in a query language with no parameter binding, and a category
// nobody meant is worse than one nobody asked for. Nothing left is "not set".
export function asCategoryIdList(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const ids = value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => /^\d{1,18}$/.test(part))
  return ids.length > 0 ? [...new Set(ids)].join(',') : null
}

// A 24-character url-safe shared secret for the feed URL. Long enough that the
// URL cannot be guessed, short enough to read out over the phone at a push.
function mintToken(): string {
  return randomBytes(18).toString('base64url')
}

/** The settings row, minting the feed token on first read so a URL exists the
 *  moment the tab is opened. The mint is written with a NULL guard, so two
 *  concurrent first reads cannot each install their own token. */
/** The shortest gap between two live-update runs, in seconds.
 *
 *  Floored at 30: each run rebuilds the feed, and a run every few seconds would
 *  cost more in compute than the freshness is worth. Capped at an hour, which
 *  is where the hourly sweep takes over anyway. */
export function asDebounceSeconds(value: unknown): number {
  const seconds = Math.trunc(Number(value))
  if (!Number.isFinite(seconds)) return 120
  return Math.min(Math.max(seconds, 30), 3600)
}

/** How many items one reconcile asks Google about. One API call each, so this
 *  is a quota decision rather than a taste one. Zero switches the check off. */
export function asReconcileSample(value: unknown): number {
  const items = Math.trunc(Number(value))
  if (!Number.isFinite(items)) return 20
  return Math.min(Math.max(items, 0), 200)
}

/**
 * A feed label, in the only case Google has.
 *
 * Google's spec for the field: "The maximum allowed characters are 20, and the
 * supported characters are `A-Z`, `0-9`, hyphen, and underscore." There is no
 * lower case in that list, and Merchant Center stores and reports labels
 * upper-cased - so an owner who types "uk" against an account whose label is
 * "UK" was passing the setup's identity check (which compares case-insensitively
 * and correctly) and then having "uk" sent on every product input.
 *
 * Applied on the way IN and on the way OUT, so a value stored in another case by
 * an earlier build is normalised on read rather than waiting for somebody to
 * re-save it. Nothing else is stripped or rewritten: a label with a character
 * Google does not allow is the owner's typo and Google's refusal to report, not
 * something to silently mangle into a different label.
 */
export function asFeedLabel(value: unknown): string | null {
  const label = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return label === '' ? null : label
}

/** The two-letter ISO 639-1 language Google files this shop's products under.
 *
 *  Falls back to 'en' rather than refusing: it is half of every product's
 *  identity at Google, and an empty one would file everything against a product
 *  that does not exist. Lower-cased and cut to two letters, which is the only
 *  shape Google's `contentLanguage` field takes. */
export function asContentLanguage(value: unknown): string {
  const code = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return /^[a-z]{2}$/.test(code) ? code : 'en'
}

/** Google's own data source ids, as we recorded them. Checked rather than cast:
 *  jsonb written by an older build must leave the panel empty, not throw. */
function asSourceIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map((id) => id.trim()))]
}

export async function getGsfSettings(): Promise<GsfSettings> {
  const rows = await prisma.$queryRaw<SettingsRow[]>`
    SELECT "enabled", "feed_token", "default_brand", "brand_from_supplier", "mpn_from_sku", "default_condition",
           "merchant_id", "feed_label", "send_delivery_options", "shipping_country",
           "shipping_label_attribute_id", "shipping_label_source", "delivery_sync_enabled",
           "reviews_feed_enabled", "customer_reviews_enabled", "customer_reviews_style",
           "customer_reviews_delivery_days", "return_policy_labels_enabled",
           "parent_images_on_variations", "promotions_feed_enabled", "promotions_fine_print",
           "feed_data_source_id", "feed_data_source_detected_id", "disapproval_alert_threshold",
           "alert_email_enabled", "alert_email", "issues_checked_at", "last_disapproved_count",
           "performance_import_enabled", "performance_backfill_days", "performance_retention_days",
           "performance_imported_through", "performance_checked_at", "performance_conversions_available",
           "performance_conversions_checked_at", "performance_failed_at", "performance_last_error",
           "best_sellers_enabled", "best_sellers_category_ids", "best_sellers_granularity",
           "best_sellers_limit", "best_sellers_checked_at",
           "link_tagging_enabled", "click_tracking_enabled", "click_retention_days",
           "price_push_enabled", "push_data_source_id", "push_linked_source_ids", "push_linked_at",
           "push_debounce_seconds", "push_reconcile_sample", "content_language",
           "ads_enabled", "ads_spend_import_enabled", "ads_spend_backfill_days",
           "ads_spend_retention_days", "ads_conversion_upload_enabled",
           "ads_conversion_action", "ads_conversion_action_name",
           "ads_conversion_action_primary", "ads_conversion_action_checked_at",
           "ads_currency", "ads_time_zone", "ads_account_checked_at"
    FROM "gsf_settings" WHERE "id" = 'singleton'
  `
  const row = rows[0]
  if (!row) {
    // The migration seeds the singleton; reaching here means it has not run yet.
    return {
      enabled: false, feedToken: null, defaultBrand: null, brandFromSupplier: true,
      mpnFromSku: false, defaultCondition: 'new', merchantId: null, feedLabel: null, sendDeliveryOptions: false,
      shippingCountry: 'GB', shippingLabelAttributeId: null,
      shippingLabelSource: 'attribute', deliverySyncEnabled: false,
      reviewsFeedEnabled: false, customerReviewsEnabled: false,
      customerReviewsStyle: 'CENTER_DIALOG', customerReviewsDeliveryDays: 5,
      returnPolicyLabelsEnabled: false, parentImagesOnVariations: false,
      promotionsFeedEnabled: false, promotionsFinePrint: null,
      feedDataSourceId: null, feedDataSourceDetectedId: null,
      disapprovalAlertThreshold: 25, alertEmailEnabled: false, alertEmail: null,
      issuesCheckedAt: null, lastDisapprovedCount: null,
      performanceImportEnabled: true, performanceBackfillDays: 90, performanceRetentionDays: 400,
      performanceImportedThrough: null, performanceCheckedAt: null, performanceConversionsAvailable: null,
      performanceConversionsCheckedAt: null, performanceFailedAt: null, performanceLastError: null,
      bestSellersEnabled: false, bestSellersCategoryIds: null, bestSellersGranularity: 'WEEKLY',
      bestSellersLimit: 50, bestSellersCheckedAt: null,
      linkTaggingEnabled: false, clickTrackingEnabled: false, clickRetentionDays: 400,
      pricePushEnabled: false, pushDataSourceId: null, pushLinkedSourceIds: [], pushLinkedAt: null,
      pushDebounceSeconds: 120, pushReconcileSample: 20, contentLanguage: 'en',
      adsEnabled: false, adsSpendImportEnabled: true, adsSpendBackfillDays: 90,
      adsSpendRetentionDays: 400, adsConversionUploadEnabled: false,
      adsConversionAction: null, adsConversionActionName: null,
      adsConversionActionPrimary: null, adsConversionActionCheckedAt: null,
      adsCurrency: null, adsTimeZone: null, adsAccountCheckedAt: null,
    }
  }
  let feedToken = row.feed_token
  if (!feedToken) {
    const fresh = mintToken()
    await prisma.$executeRaw`
      UPDATE "gsf_settings" SET "feed_token" = ${fresh}, "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = 'singleton' AND "feed_token" IS NULL
    `
    // Re-read rather than trust our own value: on a tie the other writer won.
    const check = await prisma.$queryRaw<Array<{ feed_token: string | null }>>`
      SELECT "feed_token" FROM "gsf_settings" WHERE "id" = 'singleton'
    `
    feedToken = check[0]?.feed_token ?? fresh
  }
  return {
    enabled: row.enabled,
    feedToken,
    defaultBrand: row.default_brand,
    brandFromSupplier: row.brand_from_supplier,
    mpnFromSku: row.mpn_from_sku,
    defaultCondition: asCondition(row.default_condition),
    merchantId: row.merchant_id,
    feedLabel: asFeedLabel(row.feed_label),
    sendDeliveryOptions: row.send_delivery_options,
    shippingCountry: asShippingCountry(row.shipping_country),
    shippingLabelAttributeId: row.shipping_label_attribute_id?.trim() || null,
    shippingLabelSource: asLabelSource(row.shipping_label_source),
    deliverySyncEnabled: row.delivery_sync_enabled,
    reviewsFeedEnabled: row.reviews_feed_enabled,
    customerReviewsEnabled: row.customer_reviews_enabled,
    customerReviewsStyle: asOptInStyle(row.customer_reviews_style),
    customerReviewsDeliveryDays: asDeliveryDays(Number(row.customer_reviews_delivery_days)),
    returnPolicyLabelsEnabled: row.return_policy_labels_enabled,
    parentImagesOnVariations: row.parent_images_on_variations,
    promotionsFeedEnabled: row.promotions_feed_enabled,
    promotionsFinePrint: row.promotions_fine_print?.trim() || null,
    feedDataSourceId: row.feed_data_source_id?.trim() || null,
    feedDataSourceDetectedId: row.feed_data_source_detected_id?.trim() || null,
    disapprovalAlertThreshold: asAlertThreshold(Number(row.disapproval_alert_threshold)),
    alertEmailEnabled: row.alert_email_enabled,
    alertEmail: row.alert_email?.trim() || null,
    issuesCheckedAt: row.issues_checked_at,
    lastDisapprovedCount: row.last_disapproved_count === null ? null : Number(row.last_disapproved_count),
    performanceImportEnabled: row.performance_import_enabled,
    performanceBackfillDays: asBackfillDays(Number(row.performance_backfill_days)),
    performanceRetentionDays: asRetentionDays(Number(row.performance_retention_days)),
    // A DATE read back through dayFromDate, which reads it in UTC - the only
    // way to get the day that was stored rather than the day it happens to be
    // wherever this server is running.
    performanceImportedThrough: dayFromDate(row.performance_imported_through),
    performanceCheckedAt: row.performance_checked_at,
    performanceConversionsAvailable: row.performance_conversions_available,
    performanceConversionsCheckedAt: row.performance_conversions_checked_at,
    performanceFailedAt: row.performance_failed_at,
    performanceLastError: row.performance_last_error?.trim() || null,
    bestSellersEnabled: row.best_sellers_enabled,
    bestSellersCategoryIds: asCategoryIdList(row.best_sellers_category_ids),
    bestSellersGranularity: asGranularity(row.best_sellers_granularity),
    bestSellersLimit: asBestSellersLimit(Number(row.best_sellers_limit)),
    bestSellersCheckedAt: row.best_sellers_checked_at,
    linkTaggingEnabled: row.link_tagging_enabled,
    clickTrackingEnabled: row.click_tracking_enabled,
    clickRetentionDays: asClickRetentionDays(Number(row.click_retention_days)),
    pricePushEnabled: row.price_push_enabled,
    pushDataSourceId: row.push_data_source_id?.trim() || null,
    pushLinkedSourceIds: asSourceIdList(row.push_linked_source_ids),
    pushLinkedAt: row.push_linked_at,
    pushDebounceSeconds: asDebounceSeconds(Number(row.push_debounce_seconds)),
    pushReconcileSample: asReconcileSample(Number(row.push_reconcile_sample)),
    contentLanguage: asContentLanguage(row.content_language),
    adsEnabled: row.ads_enabled,
    adsSpendImportEnabled: row.ads_spend_import_enabled,
    adsSpendBackfillDays: asBackfillDays(Number(row.ads_spend_backfill_days)),
    adsSpendRetentionDays: asRetentionDays(Number(row.ads_spend_retention_days)),
    adsConversionUploadEnabled: row.ads_conversion_upload_enabled,
    adsConversionAction: asConversionActionName(row.ads_conversion_action),
    adsConversionActionName: row.ads_conversion_action_name?.trim() || null,
    adsConversionActionPrimary: row.ads_conversion_action_primary,
    adsConversionActionCheckedAt: row.ads_conversion_action_checked_at,
    adsCurrency: row.ads_currency?.trim().toUpperCase() || null,
    adsTimeZone: row.ads_time_zone?.trim() || null,
    adsAccountCheckedAt: row.ads_account_checked_at,
  }
}

// A short-lived copy of the settings row.
//
// Why this exists at all: lib/head.ts runs on EVERY public page render, and the
// read below is a raw query with no cache of its own - so without this, every
// page view on every install carrying this module costs one extra round trip to
// Postgres, whether click tracking is on or off. The two public beacon routes
// read it too, ahead of their own rate limiter, so a flood would otherwise buy
// itself a query per request that the brake cannot refuse.
//
// Five seconds, invalidated on every write, copied from shop's own
// getShopConfigCached (modules/shop/lib/config.ts) - the precedent lib/head.ts
// is modelled on. Per process, like that one: several serverless invocations
// each hold their own, and the worst case is one of them answering with a
// setting five seconds stale.
//
// Deliberately NOT what getGsfSettings itself became. Several routes save a
// setting and immediately re-read to answer with, and a memoised read there
// would hand the owner back the value they had just changed.
let cachedSettings: GsfSettings | null = null
let cachedSettingsAt = 0
const SETTINGS_CACHE_TTL_MS = 5_000

export async function getGsfSettingsCached(): Promise<GsfSettings> {
  const now = Date.now()
  if (cachedSettings && now - cachedSettingsAt < SETTINGS_CACHE_TTL_MS) return cachedSettings
  const settings = await getGsfSettings()
  cachedSettings = settings
  cachedSettingsAt = now
  return settings
}

export function invalidateGsfSettingsCache(): void {
  cachedSettings = null
  cachedSettingsAt = 0
}

export async function updateGsfSettings(patch: {
  enabled?: boolean
  defaultBrand?: string | null
  brandFromSupplier?: boolean
  mpnFromSku?: boolean
  defaultCondition?: GsfCondition
  merchantId?: string | null
  feedLabel?: string | null
  sendDeliveryOptions?: boolean
  shippingCountry?: string
  shippingLabelAttributeId?: string | null
  shippingLabelSource?: GsfLabelSource
  deliverySyncEnabled?: boolean
  reviewsFeedEnabled?: boolean
  customerReviewsEnabled?: boolean
  customerReviewsStyle?: GsfOptInStyle
  customerReviewsDeliveryDays?: number
  returnPolicyLabelsEnabled?: boolean
  parentImagesOnVariations?: boolean
  promotionsFeedEnabled?: boolean
  promotionsFinePrint?: string | null
  feedDataSourceId?: string | null
  disapprovalAlertThreshold?: number
  alertEmailEnabled?: boolean
  alertEmail?: string | null
  performanceImportEnabled?: boolean
  performanceBackfillDays?: number
  performanceRetentionDays?: number
  bestSellersEnabled?: boolean
  bestSellersCategoryIds?: string | null
  bestSellersGranularity?: BestSellerGranularity
  bestSellersLimit?: number
  linkTaggingEnabled?: boolean
  clickTrackingEnabled?: boolean
  clickRetentionDays?: number
  pricePushEnabled?: boolean
  pushDebounceSeconds?: number
  pushReconcileSample?: number
  contentLanguage?: string
  adsEnabled?: boolean
  adsSpendImportEnabled?: boolean
  adsSpendBackfillDays?: number
  adsSpendRetentionDays?: number
  adsConversionUploadEnabled?: boolean
}): Promise<void> {
  if (patch.enabled !== undefined) {
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "enabled" = ${patch.enabled}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.defaultBrand !== undefined) {
    const value = patch.defaultBrand?.trim() || null
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "default_brand" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.brandFromSupplier !== undefined) {
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "brand_from_supplier" = ${patch.brandFromSupplier}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.mpnFromSku !== undefined) {
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "mpn_from_sku" = ${patch.mpnFromSku}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.defaultCondition !== undefined) {
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "default_condition" = ${patch.defaultCondition}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.merchantId !== undefined) {
    // Merchant Center account numbers are digits; owners paste them with spaces,
    // hyphens or an "ID:" in front, so keep only the digits and treat nothing
    // left as "not set".
    const value = patch.merchantId?.replace(/\D+/g, '') || null
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "merchant_id" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.feedLabel !== undefined) {
    const value = asFeedLabel(patch.feedLabel)
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "feed_label" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.sendDeliveryOptions !== undefined) {
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "send_delivery_options" = ${patch.sendDeliveryOptions}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.shippingCountry !== undefined) {
    const value = asShippingCountry(patch.shippingCountry)
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "shipping_country" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.shippingLabelAttributeId !== undefined) {
    // An empty choice is "off", stored as NULL rather than an empty string so
    // there is one answer to "is this set" and not two.
    const value = patch.shippingLabelAttributeId?.trim() || null
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "shipping_label_attribute_id" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.shippingLabelSource !== undefined) {
    const value = asLabelSource(patch.shippingLabelSource)
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "shipping_label_source" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.deliverySyncEnabled !== undefined) {
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "delivery_sync_enabled" = ${patch.deliverySyncEnabled}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.reviewsFeedEnabled !== undefined) {
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "reviews_feed_enabled" = ${patch.reviewsFeedEnabled}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.customerReviewsEnabled !== undefined) {
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "customer_reviews_enabled" = ${patch.customerReviewsEnabled}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.customerReviewsStyle !== undefined) {
    const value = asOptInStyle(patch.customerReviewsStyle)
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "customer_reviews_style" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.customerReviewsDeliveryDays !== undefined) {
    const value = asDeliveryDays(patch.customerReviewsDeliveryDays)
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "customer_reviews_delivery_days" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.returnPolicyLabelsEnabled !== undefined) {
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "return_policy_labels_enabled" = ${patch.returnPolicyLabelsEnabled}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.parentImagesOnVariations !== undefined) {
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "parent_images_on_variations" = ${patch.parentImagesOnVariations}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.promotionsFeedEnabled !== undefined) {
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "promotions_feed_enabled" = ${patch.promotionsFeedEnabled}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.promotionsFinePrint !== undefined) {
    // Google takes 500 characters of terms; cut here rather than at the feed so
    // the owner sees what was kept the moment they save it.
    const value = patch.promotionsFinePrint?.trim().slice(0, 500) || null
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "promotions_fine_print" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.feedDataSourceId !== undefined) {
    // Clearing it goes back to "work it out"; the discovered id is left where
    // it is, so clearing an override falls back to what was already found
    // rather than to nothing at all.
    const value = asDataSourceId(patch.feedDataSourceId)
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "feed_data_source_id" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.disapprovalAlertThreshold !== undefined) {
    const value = asAlertThreshold(patch.disapprovalAlertThreshold)
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "disapproval_alert_threshold" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.alertEmailEnabled !== undefined) {
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "alert_email_enabled" = ${patch.alertEmailEnabled}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.alertEmail !== undefined) {
    // An address that could never be delivered to is stored as nothing, so
    // "switched on with nowhere to send" is one state rather than two.
    const value = asAlertEmail(patch.alertEmail)
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "alert_email" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.performanceImportEnabled !== undefined) {
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "performance_import_enabled" = ${patch.performanceImportEnabled}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.performanceBackfillDays !== undefined) {
    // Widening the window does NOT clear the cursor: the next run's plan
    // reaches further back on its own (lib/performance/plan.ts), which fills
    // the gap without re-reading the months already held.
    const value = asBackfillDays(patch.performanceBackfillDays)
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "performance_backfill_days" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.performanceRetentionDays !== undefined) {
    const value = asRetentionDays(patch.performanceRetentionDays)
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "performance_retention_days" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.bestSellersEnabled !== undefined) {
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "best_sellers_enabled" = ${patch.bestSellersEnabled}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.bestSellersCategoryIds !== undefined) {
    // Nothing usable left is stored as NULL rather than an empty string, so
    // "not set" is one state and not two. NULL falls back to the ids already
    // typed against the shop's own categories.
    const value = asCategoryIdList(patch.bestSellersCategoryIds)
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "best_sellers_category_ids" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.bestSellersGranularity !== undefined) {
    const value = asGranularity(patch.bestSellersGranularity)
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "best_sellers_granularity" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.bestSellersLimit !== undefined) {
    const value = asBestSellersLimit(patch.bestSellersLimit)
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "best_sellers_limit" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.linkTaggingEnabled !== undefined) {
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "link_tagging_enabled" = ${patch.linkTaggingEnabled}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.clickTrackingEnabled !== undefined) {
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "click_tracking_enabled" = ${patch.clickTrackingEnabled}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.clickRetentionDays !== undefined) {
    // Shortening it does NOT prune straight away: the daily check does that,
    // so a mistyped figure can be put right before anything is thrown away.
    const value = asClickRetentionDays(patch.clickRetentionDays)
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "click_retention_days" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.pricePushEnabled !== undefined) {
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "price_push_enabled" = ${patch.pricePushEnabled}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.pushDebounceSeconds !== undefined) {
    const value = asDebounceSeconds(patch.pushDebounceSeconds)
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "push_debounce_seconds" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.pushReconcileSample !== undefined) {
    const value = asReconcileSample(patch.pushReconcileSample)
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "push_reconcile_sample" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.contentLanguage !== undefined) {
    const value = asContentLanguage(patch.contentLanguage)
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "content_language" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.adsEnabled !== undefined) {
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "ads_enabled" = ${patch.adsEnabled}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.adsSpendImportEnabled !== undefined) {
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "ads_spend_import_enabled" = ${patch.adsSpendImportEnabled}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.adsSpendBackfillDays !== undefined) {
    // Widening the window does NOT clear the cursor: the next run reaches
    // further back on its own, filling the gap without re-reading the months
    // already held. Same rule as the Merchant Center import next door.
    const value = asBackfillDays(patch.adsSpendBackfillDays)
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "ads_spend_backfill_days" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.adsSpendRetentionDays !== undefined) {
    const value = asRetentionDays(patch.adsSpendRetentionDays)
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "ads_spend_retention_days" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.adsConversionUploadEnabled !== undefined) {
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "ads_conversion_upload_enabled" = ${patch.adsConversionUploadEnabled}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  invalidateGsfSettingsCache()
}

/**
 * The Google Ads conversion action we upload against, and what Google said
 * about it.
 *
 * Kept out of updateGsfSettings because nobody types any of this: the resource
 * name is Google's own, learned by creating or reading the action, and
 * `primary` is GOOGLE'S ANSWER rather than our intention. That distinction is
 * the whole safeguard against a sale being counted twice, so it may only ever
 * be written by a caller that has just read it back from Google.
 *
 * Passing null for the whole action clears it, which is what "set it up again"
 * starts from.
 */
export async function recordAdsConversionAction(input: {
  resourceName: string | null
  name: string | null
  /** What Google says. Null where Google did not send the field, which is
   *  stored as null and read as "not known", never as secondary. */
  primary: boolean | null
  checkedAt: Date
}): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "gsf_settings"
    SET "ads_conversion_action" = ${asConversionActionName(input.resourceName)},
        "ads_conversion_action_name" = ${input.name?.trim().slice(0, 200) || null},
        "ads_conversion_action_primary" = ${input.primary},
        "ads_conversion_action_checked_at" = ${input.checkedAt}::timestamp(3),
        "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = 'singleton'
  `
  invalidateGsfSettingsCache()
}

/** The Google Ads account's own currency and timezone, as Google reported them.
 *  Learned rather than typed, so it lives here rather than in the patch above. */
export async function recordAdsAccount(input: {
  currency: string | null
  timeZone: string | null
  checkedAt: Date
}): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "gsf_settings"
    SET "ads_currency" = ${input.currency?.trim().toUpperCase().slice(0, 8) || null},
        "ads_time_zone" = ${input.timeZone?.trim().slice(0, 64) || null},
        "ads_account_checked_at" = ${input.checkedAt}::timestamp(3),
        "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = 'singleton'
  `
  invalidateGsfSettingsCache()
}

/** The supplemental data source the module created, and the primary sources it
 *  is linked into. Kept out of updateGsfSettings because nobody types these:
 *  they are Google's own ids, learned by creating or reading the source, and a
 *  hand-typed one would point the sends at somebody else's feed. */
export async function recordPushDataSource(input: {
  dataSourceId: string | null
  /** Left out leaves the recorded links alone; [] says "linked into nothing". */
  linkedSourceIds?: string[]
  linkedAt?: Date | null
}): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "gsf_settings"
    SET "push_data_source_id" = ${input.dataSourceId},
        "push_linked_source_ids" = CASE
          WHEN ${input.linkedSourceIds === undefined} THEN "push_linked_source_ids"
          ELSE ${JSON.stringify([...new Set(input.linkedSourceIds ?? [])])}::jsonb
        END,
        "push_linked_at" = CASE
          WHEN ${input.linkedAt === undefined} THEN "push_linked_at"
          ELSE ${input.linkedAt ?? null}::timestamp(3)
        END,
        "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = 'singleton'
  `
  invalidateGsfSettingsCache()
}

/** Bookkeeping the performance import writes after a run: when it looked, how
 *  far it has settled, and whether Google will answer a query with conversions
 *  in it.
 *
 *  `importedThrough` is bound as TEXT and cast in SQL, never as a JS Date: a
 *  Date binds as a timestamp, and a timestamp cast to date is whatever day it
 *  happens to be in the session's timezone. */
export async function recordPerformanceCheck(input: {
  checkedAt: Date
  importedThrough: string | null
  conversionsAvailable: boolean | null
  /** True only when this run actually ASKED Google for conversions and got an
   *  answer either way. That stamp is what stops a refusal becoming a
   *  permanent claim about the account: the daily check asks again once it has
   *  gone stale, and the screen can date the refusal rather than stating it as
   *  a standing fact. A run that did not ask leaves the stamp alone. */
  conversionsLearned?: boolean
  /** 'ok' moves the "last fetched" stamp and clears any recorded failure.
   *  'failed' does NEITHER: it records the failure and leaves the success
   *  stamp exactly where it was, so a screen can never report a fetch that
   *  did not happen. The cursor and the conversions bookkeeping are written
   *  on both, because whatever WAS read is in the table either way. */
  outcome: 'ok' | 'failed'
  /** Google's own sentence, or ours. Only read on 'failed'. */
  error?: string
}): Promise<void> {
  // Refused rather than silently dropped: a cursor that is not a date would
  // leave the import re-reading the whole backfill window every day, and
  // nothing on any screen would say why.
  if (input.importedThrough !== null && !isDayString(input.importedThrough)) {
    throw new Error(`Not a date the import can have reached: ${input.importedThrough}`)
  }
  const failed = input.outcome === 'failed'
  await prisma.$executeRaw`
    UPDATE "gsf_settings"
    SET "performance_checked_at" = CASE WHEN ${failed} THEN "performance_checked_at" ELSE ${input.checkedAt}::timestamp(3) END,
        "performance_failed_at" = CASE WHEN ${failed} THEN ${input.checkedAt}::timestamp(3) ELSE NULL END,
        -- Cut rather than refused: this is Google's sentence and it only ever
        -- goes on a screen, but a stack trace pasted into a TEXT column for
        -- ever is nobody's idea of an error message.
        "performance_last_error" = CASE WHEN ${failed} THEN ${input.error?.slice(0, 1000) ?? null}::text ELSE NULL END,
        "performance_imported_through" = ${input.importedThrough}::date,
        "performance_conversions_available" = ${input.conversionsAvailable},
        "performance_conversions_checked_at" = CASE
          WHEN ${input.conversionsLearned === true} THEN ${input.checkedAt}::timestamp(3)
          ELSE "performance_conversions_checked_at"
        END,
        "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = 'singleton'
  `
  invalidateGsfSettingsCache()
}

/** When the best sellers rankings were last fetched. Separate from the import
 *  above because the two run on their own schedules and either can be switched
 *  off without the other. */
export async function recordBestSellersCheck(checkedAt: Date): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "gsf_settings" SET "best_sellers_checked_at" = ${checkedAt}, "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = 'singleton'
  `
  invalidateGsfSettingsCache()
}

/** The data source we worked out for ourselves. Kept apart from
 *  updateGsfSettings because nobody chose it: it is a cache, refreshed by the
 *  health check, and it must never land in the column the owner types into. */
export async function rememberDetectedDataSource(dataSourceId: string | null): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "gsf_settings" SET "feed_data_source_detected_id" = ${dataSourceId}, "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = 'singleton'
  `
  invalidateGsfSettingsCache()
}

/** Bookkeeping the health check writes after a run: when it looked, and how
 *  many items were disapproved, so the next run has something to compare with. */
export async function recordIssueCheck(checkedAt: Date, disapprovedItems: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "gsf_settings"
    SET "issues_checked_at" = ${checkedAt}, "last_disapproved_count" = ${disapprovedItems}, "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = 'singleton'
  `
  invalidateGsfSettingsCache()
}

/** Replaces the feed token, cutting off the old URL immediately. For when the
 *  address has leaked somewhere it should not have. */
export async function regenerateGsfFeedToken(): Promise<string> {
  const fresh = mintToken()
  await prisma.$executeRaw`
    UPDATE "gsf_settings" SET "feed_token" = ${fresh}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'
  `
  invalidateGsfSettingsCache()
  return fresh
}
