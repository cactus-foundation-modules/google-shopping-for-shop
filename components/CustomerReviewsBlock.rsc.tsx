import { connection } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { CustomerReviewsOptIn, MARKETING_CATEGORY } from './CustomerReviewsOptIn'
import { googleCustomerReviewsBlockComponent } from './CustomerReviewsBlock'

type StoredBanner = { enabled?: boolean; categories?: Array<{ key?: string }> } | null

/**
 * Whether the visitor has to say yes first.
 *
 * You can only wait for a switch that exists. A banner that is switched off, or
 * one carrying no marketing category, leaves the shopper nothing to grant - so
 * waiting would mean waiting for ever, and the survey would never be offered
 * while appearing to be switched on. Same rule, and the same reasoning, as the
 * Google Tag module's own consent gate.
 */
async function marketingCategoryExists(): Promise<boolean> {
  const config = await prisma.siteConfig
    .findUnique({ where: { id: 'singleton' }, select: { consentBannerConfig: true } })
    .catch(() => null)
  const banner = config?.consentBannerConfig as StoredBanner
  if (banner?.enabled !== true) return false
  return (banner.categories ?? []).some((category) => category?.key === MARKETING_CATEGORY)
}

async function CustomerReviewsRsc() {
  // Read per request, not per build: an owner who has just switched this on
  // expects the next order to be asked, not the next deploy.
  await connection()

  const settings = await getGsfSettings()
  if (!settings.customerReviewsEnabled) return null
  // No account number, no survey. Google's opt-in needs one and there is
  // nothing sensible to guess.
  if (!settings.merchantId) return null

  return <CustomerReviewsOptIn gated={await marketingCategoryExists()} />
}

export const googleCustomerReviewsBlockRscComponent = {
  ...googleCustomerReviewsBlockComponent,
  render: CustomerReviewsRsc,
}
