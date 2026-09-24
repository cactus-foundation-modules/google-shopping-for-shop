// Whose hand choice an item follows. Pure, and in a file of its own so it can
// be exercised without a database: it is the one link in the precedence chain
// that lives outside the evaluator, and it decides whether a variation goes to
// Google at all.
import type { ManualChoice } from '@/modules/google-shopping-for-shop/lib/feed-rules/evaluate'
import type { GsfProductData } from '@/modules/google-shopping-for-shop/lib/types'

/**
 * The choice that applies to one feed item.
 *
 * The variation's own say comes first. "Follow the rules" on a variation is
 * not an answer - it defers to its listing's, which is how an owner who set
 * "never send" on the product expects every variation of it to behave. A
 * product with no variations passes its own row as `own` and nothing as
 * `listing`, and answers for itself.
 */
export function manualChoiceOf(own: GsfProductData | undefined, listing: GsfProductData | undefined): ManualChoice {
  if (own && own.feedChoice !== 'rules') return own.feedChoice
  return listing?.feedChoice ?? 'rules'
}
