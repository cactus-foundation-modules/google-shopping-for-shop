// How the owner's feed choices read, in the change log and on screen. Pure, so
// the product editor and the workbench label them in the same words.
import type { FeedChoice } from '@/modules/google-shopping-for-shop/lib/types'

export const FEED_CHOICE_LABELS: Record<FeedChoice, string> = {
  rules: 'Follow the feed rules',
  include: 'Always send to Google',
  exclude: 'Never send to Google',
}

/** For a variation, whose "follow the rules" means "do as the listing does". */
export const VARIATION_CHOICE_LABELS: Record<FeedChoice, string> = {
  rules: 'As the product',
  include: 'Always send',
  exclude: 'Never send',
}

export function feedChoiceSummary(productName: string, choice: FeedChoice): string {
  const name = `"${productName}"`
  if (choice === 'include') return `Set ${name} to always go to Google`
  if (choice === 'exclude') return `Kept ${name} out of Google`
  return `Set ${name} to follow the feed rules`
}

export function variationChoicesSummary(productName: string): string {
  return `Changed which variations of "${productName}" go to Google`
}
