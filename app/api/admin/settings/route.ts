// GET/PATCH /api/m/google-shopping-for-shop/admin/settings
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { getSiteUrlOrNull } from '@/lib/config/env'
import { getGsfSettings, regenerateGsfFeedToken, updateGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { GSF_CONDITIONS, GSF_OPT_IN_STYLES, type GsfSettingsView } from '@/modules/google-shopping-for-shop/lib/types'
import { hasDeliveryTimingProvider } from '@/modules/google-shopping-for-shop/lib/delivery-timing'
import { listLabelAttributes } from '@/modules/google-shopping-for-shop/lib/product-labels'
import { hasReviewsProvider } from '@/modules/google-shopping-for-shop/lib/reviews-source'

async function view(): Promise<GsfSettingsView> {
  const [settings, labelAttributes, shopConfig] = await Promise.all([
    getGsfSettings(),
    listLabelAttributes(),
    getShopConfigCached(),
  ])
  const siteUrl = getSiteUrlOrNull()
  const base = siteUrl && settings.feedToken ? `${siteUrl}/google-shopping/feed.xml?key=${settings.feedToken}` : null
  return {
    enabled: settings.enabled,
    feedUrl: base,
    defaultBrand: settings.defaultBrand ?? '',
    brandFromSupplier: settings.brandFromSupplier,
    mpnFromSku: settings.mpnFromSku,
    defaultCondition: settings.defaultCondition,
    merchantId: settings.merchantId ?? '',
    feedLabel: settings.feedLabel ?? '',
    sendDeliveryOptions: settings.sendDeliveryOptions,
    shippingCountry: settings.shippingCountry,
    shippingLabelAttributeId: settings.shippingLabelAttributeId ?? '',
    shippingLabelAttributes: labelAttributes,
    deliveryOptionsAvailable: hasDeliveryTimingProvider(),
    returnPolicyLabelsEnabled: settings.returnPolicyLabelsEnabled,
    parentImagesOnVariations: settings.parentImagesOnVariations,
    reviewsFeedEnabled: settings.reviewsFeedEnabled,
    // The same address as the product feed, one parameter apart - see the
    // route's own note on why there is not a second file name.
    reviewsFeedUrl: base ? `${base}&content=reviews` : null,
    reviewsAvailable: hasReviewsProvider(),
    promotionsFeedEnabled: settings.promotionsFeedEnabled,
    promotionsFinePrint: settings.promotionsFinePrint ?? '',
    promotionsFeedUrl: base ? `${base}&content=promotions` : null,
    // There is only one thing to advertise, and it is shop's own order-size
    // deduction. Switched off there, the source would be an empty document.
    promotionsAvailable: shopConfig.orderSizeDeductionEnabled,
    customerReviewsEnabled: settings.customerReviewsEnabled,
    customerReviewsStyle: settings.customerReviewsStyle,
    customerReviewsDeliveryDays: settings.customerReviewsDeliveryDays,
  }
}

export async function GET() {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error
  return NextResponse.json({ settings: await view() })
}

const PatchBody = z.object({
  enabled: z.boolean().optional(),
  defaultBrand: z.string().max(70).optional(),
  brandFromSupplier: z.boolean().optional(),
  mpnFromSku: z.boolean().optional(),
  defaultCondition: z.enum(GSF_CONDITIONS).optional(),
  // The account number is reduced to its digits server-side; the length caps
  // only stop a paste of half a page ending up in the column.
  merchantId: z.string().max(40).optional(),
  feedLabel: z.string().max(40).optional(),
  sendDeliveryOptions: z.boolean().optional(),
  // Normalised to two upper-case letters server-side; anything else becomes GB.
  shippingCountry: z.string().max(8).optional(),
  // An attribute id from whichever module publishes them, or '' for off. Not
  // checked against the list here on purpose: an id that no longer exists finds
  // nothing and leaves the label off, which is the same as off, and refusing
  // the save would only strand an owner whose attribute had been deleted.
  shippingLabelAttributeId: z.string().max(64).optional(),
  returnPolicyLabelsEnabled: z.boolean().optional(),
  parentImagesOnVariations: z.boolean().optional(),
  reviewsFeedEnabled: z.boolean().optional(),
  promotionsFeedEnabled: z.boolean().optional(),
  // Cut to Google's 500 characters server-side; this only stops a paste of half
  // a contract reaching the column.
  promotionsFinePrint: z.string().max(2000).optional(),
  customerReviewsEnabled: z.boolean().optional(),
  customerReviewsStyle: z.enum(GSF_OPT_IN_STYLES).optional(),
  // Clamped to something sane server-side; this only stops a paste of War and
  // Peace reaching the column.
  customerReviewsDeliveryDays: z.number().int().min(0).max(365).optional(),
  // Cuts the old feed URL off immediately and mints a fresh one.
  regenerateToken: z.boolean().optional(),
})

export async function PATCH(request: NextRequest) {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error
  const parsed = PatchBody.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid settings' }, { status: 400 })
  const body = parsed.data
  await updateGsfSettings({
    enabled: body.enabled,
    defaultBrand: body.defaultBrand,
    brandFromSupplier: body.brandFromSupplier,
    mpnFromSku: body.mpnFromSku,
    defaultCondition: body.defaultCondition,
    merchantId: body.merchantId,
    feedLabel: body.feedLabel,
    sendDeliveryOptions: body.sendDeliveryOptions,
    shippingCountry: body.shippingCountry,
    shippingLabelAttributeId: body.shippingLabelAttributeId,
    returnPolicyLabelsEnabled: body.returnPolicyLabelsEnabled,
    parentImagesOnVariations: body.parentImagesOnVariations,
    reviewsFeedEnabled: body.reviewsFeedEnabled,
    promotionsFeedEnabled: body.promotionsFeedEnabled,
    promotionsFinePrint: body.promotionsFinePrint,
    customerReviewsEnabled: body.customerReviewsEnabled,
    customerReviewsStyle: body.customerReviewsStyle,
    customerReviewsDeliveryDays: body.customerReviewsDeliveryDays,
  })
  if (body.regenerateToken) await regenerateGsfFeedToken()
  return NextResponse.json({ settings: await view() })
}
