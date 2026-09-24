// GET/PATCH /api/m/google-shopping-for-shop/admin/settings
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { getSiteUrlOrNull } from '@/lib/config/env'
import { asAlertThreshold, getGsfSettings, regenerateGsfFeedToken, updateGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { clearAlert } from '@/lib/notifications/alerts'
import { ALERT_KEYS } from '@/modules/google-shopping-for-shop/lib/health/alerts'
import { GSF_CONDITIONS, GSF_LABEL_SOURCES, GSF_OPT_IN_STYLES, type GsfSettingsView } from '@/modules/google-shopping-for-shop/lib/types'
import { hasDeliveryTimingProvider } from '@/modules/google-shopping-for-shop/lib/delivery-timing'
import { hasDeliveryCatalogue } from '@/modules/google-shopping-for-shop/lib/delivery/catalogue'
import { listLabelAttributes } from '@/modules/google-shopping-for-shop/lib/product-labels'
import { hasReviewsProvider } from '@/modules/google-shopping-for-shop/lib/reviews-source'
import { getWithheldReport } from '@/modules/google-shopping-for-shop/lib/withheld'
import { listPromotionWindows, reissuePromotion } from '@/modules/google-shopping-for-shop/lib/promotion-windows-data'

async function view(): Promise<GsfSettingsView> {
  const [settings, labelAttributes, shopConfig, withheld, promotionWindows] = await Promise.all([
    getGsfSettings(),
    listLabelAttributes(),
    getShopConfigCached(),
    getWithheldReport(),
    listPromotionWindows(),
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
    shippingLabelSource: settings.shippingLabelSource,
    deliveryScopesAvailable: hasDeliveryCatalogue(),
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
    promotionWindows: promotionWindows.map((w) => ({
      baseKey: w.baseKey,
      promotionId: w.promotionId,
      revision: w.revision,
      startsAt: w.startsAt.toISOString(),
      endsAt: w.endsAt.toISOString(),
    })),
    customerReviewsEnabled: settings.customerReviewsEnabled,
    customerReviewsStyle: settings.customerReviewsStyle,
    customerReviewsDeliveryDays: settings.customerReviewsDeliveryDays,
    withheld: {
      total: withheld.items.length,
      // A handful is enough to recognise what is missing and go and fix it; the
      // full list belongs in the catalogue, not on a settings tab.
      titles: withheld.items.slice(0, 10).map((i) => i.title),
      checkedAt: withheld.checkedAt?.toISOString() ?? null,
    },
    feedDataSourceId: settings.feedDataSourceId ?? '',
    feedDataSourceDetectedId: settings.feedDataSourceDetectedId ?? '',
    disapprovalAlertThreshold: settings.disapprovalAlertThreshold,
    alertEmailEnabled: settings.alertEmailEnabled,
    alertEmail: settings.alertEmail ?? '',
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
  // Where the label comes from at all. Anything unrecognised falls back to the
  // attribute server-side, which is the behaviour every install started with.
  shippingLabelSource: z.enum(GSF_LABEL_SOURCES).optional(),
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
  // Digits only server-side; '' clears the override and goes back to working
  // it out from the feed address.
  feedDataSourceId: z.string().max(40).optional(),
  // Clamped server-side; this only stops a nonsense paste reaching the column.
  disapprovalAlertThreshold: z.number().int().min(0).max(1_000_000).optional(),
  alertEmailEnabled: z.boolean().optional(),
  // An empty string clears it. Anything else has to look like an address it is
  // possible to deliver to: storing a typo as NULL and saying nothing was how
  // an owner could switch alerts on, type their address with a comma in it,
  // press save, and be told everything was fine while the field quietly
  // emptied itself. Better to refuse and say why.
  alertEmail: z.string().max(320).refine(
    (value) => value.trim() === '' || /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value.trim()),
    { message: 'That does not look like an email address, so it has not been saved.' },
  ).optional(),
  // Cuts the old feed URL off immediately and mints a fresh one.
  regenerateToken: z.boolean().optional(),
  // The base key of one promotion to give a brand-new id to. For the one thing
  // Google leaves no other way out of: an id that has stopped is dead for good,
  // and their own instruction is to create a new promotion with a new id.
  reissuePromotion: z.string().max(120).optional(),
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
    shippingLabelSource: body.shippingLabelSource,
    returnPolicyLabelsEnabled: body.returnPolicyLabelsEnabled,
    parentImagesOnVariations: body.parentImagesOnVariations,
    reviewsFeedEnabled: body.reviewsFeedEnabled,
    promotionsFeedEnabled: body.promotionsFeedEnabled,
    promotionsFinePrint: body.promotionsFinePrint,
    customerReviewsEnabled: body.customerReviewsEnabled,
    customerReviewsStyle: body.customerReviewsStyle,
    customerReviewsDeliveryDays: body.customerReviewsDeliveryDays,
    feedDataSourceId: body.feedDataSourceId,
    disapprovalAlertThreshold: body.disapprovalAlertThreshold,
    alertEmailEnabled: body.alertEmailEnabled,
    alertEmail: body.alertEmail,
  })
  // Switching the spike alert off takes down any notice already showing, now
  // rather than at the next daily check. syncDisapprovalAlert clears it too,
  // but that is only reached from the match refresh - and is skipped entirely
  // on an empty-report run - so without this the settings hint and the wiki
  // would be promising something that might not happen for a day or more.
  if (body.disapprovalAlertThreshold !== undefined && asAlertThreshold(body.disapprovalAlertThreshold) === 0) {
    await clearAlert(ALERT_KEYS.disapprovalSpike)
  }

  if (body.regenerateToken) await regenerateGsfFeedToken()
  // After the settings save, so a request doing both ends up with the reissue
  // reflected in the view it gets back.
  if (body.reissuePromotion) await reissuePromotion(body.reissuePromotion)
  return NextResponse.json({ settings: await view() })
}
