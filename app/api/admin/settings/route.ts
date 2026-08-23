// GET/PATCH /api/m/google-shopping-for-shop/admin/settings
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { getSiteUrlOrNull } from '@/lib/config/env'
import { getGsfSettings, regenerateGsfFeedToken, updateGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { GSF_CONDITIONS, type GsfSettingsView } from '@/modules/google-shopping-for-shop/lib/types'

async function view(): Promise<GsfSettingsView> {
  const settings = await getGsfSettings()
  const siteUrl = getSiteUrlOrNull()
  return {
    enabled: settings.enabled,
    feedUrl: siteUrl && settings.feedToken ? `${siteUrl}/google-shopping/feed.xml?key=${settings.feedToken}` : null,
    defaultBrand: settings.defaultBrand ?? '',
    brandFromSupplier: settings.brandFromSupplier,
    defaultCondition: settings.defaultCondition,
    merchantId: settings.merchantId ?? '',
    feedLabel: settings.feedLabel ?? '',
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
  })
  if (body.regenerateToken) await regenerateGsfFeedToken()
  return NextResponse.json({ settings: await view() })
}
