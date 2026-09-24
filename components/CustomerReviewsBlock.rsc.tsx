import { connection } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { bannerHasMarketingCategory, type StoredBanner } from '@/modules/google-shopping-for-shop/lib/consent-category'
import { CustomerReviewsOptIn } from './CustomerReviewsOptIn'
import { googleCustomerReviewsBlockComponent } from './CustomerReviewsBlock'

/** Whether the visitor has to say yes first - see bannerHasMarketingCategory. */
async function marketingCategoryExists(): Promise<boolean> {
  const config = await prisma.siteConfig
    .findUnique({ where: { id: 'singleton' }, select: { consentBannerConfig: true } })
    .catch(() => null)
  return bannerHasMarketingCategory(config?.consentBannerConfig as StoredBanner)
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
