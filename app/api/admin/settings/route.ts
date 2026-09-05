// GET/PATCH /api/m/google-shopping-for-shop/admin/settings
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { getSiteUrlOrNull } from '@/lib/config/env'
import { getGsfSettings, regenerateGsfFeedToken, updateGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { GSF_CONDITIONS, GSF_OPT_IN_STYLES, type GsfSettingsView } from '@/modules/google-shopping-for-shop/lib/types'
import { hasDeliveryTimingProvider } from '@/modules/google-shopping-for-shop/lib/delivery-timing'
import { hasReviewsProvider } from '@/modules/google-shopping-for-shop/lib/reviews-source'

async function view(): Promise<GsfSettingsView> {
  const settings = await getGsfSettings()
  const siteUrl = getSiteUrlOrNull()
  const base = siteUrl && settings.feedToken ? `${siteUrl}/google-shopping/feed.xml?key=${settings.feedToken}` : null
  return {
    enabled: settings.enabled,
    feedUrl: base,
    defaultBrand: settings.defaultBrand ?? '',
    brandFromSupplier: settings.brandFromSupplier,
    defaultCondition: settings.defaultCondition,
    merchantId: settings.merchantId ?? '',
    feedLabel: settings.feedLabel ?? '',
    sendDeliveryOptions: settings.sendDeliveryOptions,
    shippingCountry: settings.shippingCountry,
    deliveryOptionsAvailable: hasDeliveryTimingProvider(),
    reviewsFeedEnabled: settings.reviewsFeedEnabled,
    // The same address as the product feed, one parameter apart - see the
    // route's own note on why there is not a second file name.
    reviewsFeedUrl: base ? `${base}&content=reviews` : null,
    reviewsAvailable: hasReviewsProvider(),
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
  defaultCondition: z.enum(GSF_CONDITIONS).optional(),
  // The account number is reduced to its digits server-side; the length caps
  // only stop a paste of half a page ending up in the column.
  merchantId: z.string().max(40).optional(),
  feedLabel: z.string().max(40).optional(),
  sendDeliveryOptions: z.boolean().optional(),
  // Normalised to two upper-case letters server-side; anything else becomes GB.
  shippingCountry: z.string().max(8).optional(),
  reviewsFeedEnabled: z.boolean().optional(),
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
    defaultCondition: body.defaultCondition,
    merchantId: body.merchantId,
    feedLabel: body.feedLabel,
    sendDeliveryOptions: body.sendDeliveryOptions,
    shippingCountry: body.shippingCountry,
    reviewsFeedEnabled: body.reviewsFeedEnabled,
    customerReviewsEnabled: body.customerReviewsEnabled,
    customerReviewsStyle: body.customerReviewsStyle,
    customerReviewsDeliveryDays: body.customerReviewsDeliveryDays,
  })
  if (body.regenerateToken) await regenerateGsfFeedToken()
  return NextResponse.json({ settings: await view() })
}
