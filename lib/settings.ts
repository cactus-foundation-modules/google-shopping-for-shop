import { randomBytes } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { GSF_CONDITIONS, type GsfCondition, type GsfSettings } from '@/modules/google-shopping-for-shop/lib/types'

function asCondition(value: unknown): GsfCondition {
  return GSF_CONDITIONS.includes(value as GsfCondition) ? (value as GsfCondition) : 'new'
}

type SettingsRow = {
  enabled: boolean
  feed_token: string | null
  default_brand: string | null
  brand_from_supplier: boolean
  default_condition: string
  merchant_id: string | null
  feed_label: string | null
  send_delivery_options: boolean
  shipping_country: string | null
}

// A country Google will take on a shipping group: two letters, upper case.
// Anything else falls back to GB rather than sending a group Google rejects.
export function asShippingCountry(value: unknown): string {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return /^[A-Z]{2}$/.test(code) ? code : 'GB'
}

// A 24-character url-safe shared secret for the feed URL. Long enough that the
// URL cannot be guessed, short enough to read out over the phone at a push.
function mintToken(): string {
  return randomBytes(18).toString('base64url')
}

/** The settings row, minting the feed token on first read so a URL exists the
 *  moment the tab is opened. The mint is written with a NULL guard, so two
 *  concurrent first reads cannot each install their own token. */
export async function getGsfSettings(): Promise<GsfSettings> {
  const rows = await prisma.$queryRaw<SettingsRow[]>`
    SELECT "enabled", "feed_token", "default_brand", "brand_from_supplier", "default_condition",
           "merchant_id", "feed_label", "send_delivery_options", "shipping_country"
    FROM "gsf_settings" WHERE "id" = 'singleton'
  `
  const row = rows[0]
  if (!row) {
    // The migration seeds the singleton; reaching here means it has not run yet.
    return { enabled: false, feedToken: null, defaultBrand: null, brandFromSupplier: true, defaultCondition: 'new', merchantId: null, feedLabel: null, sendDeliveryOptions: false, shippingCountry: 'GB' }
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
    defaultCondition: asCondition(row.default_condition),
    merchantId: row.merchant_id,
    feedLabel: row.feed_label,
    sendDeliveryOptions: row.send_delivery_options,
    shippingCountry: asShippingCountry(row.shipping_country),
  }
}

export async function updateGsfSettings(patch: {
  enabled?: boolean
  defaultBrand?: string | null
  brandFromSupplier?: boolean
  defaultCondition?: GsfCondition
  merchantId?: string | null
  feedLabel?: string | null
  sendDeliveryOptions?: boolean
  shippingCountry?: string
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
    const value = patch.feedLabel?.trim() || null
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "feed_label" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.sendDeliveryOptions !== undefined) {
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "send_delivery_options" = ${patch.sendDeliveryOptions}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
  if (patch.shippingCountry !== undefined) {
    const value = asShippingCountry(patch.shippingCountry)
    await prisma.$executeRaw`UPDATE "gsf_settings" SET "shipping_country" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
  }
}

/** Replaces the feed token, cutting off the old URL immediately. For when the
 *  address has leaked somewhere it should not have. */
export async function regenerateGsfFeedToken(): Promise<string> {
  const fresh = mintToken()
  await prisma.$executeRaw`
    UPDATE "gsf_settings" SET "feed_token" = ${fresh}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'
  `
  return fresh
}
