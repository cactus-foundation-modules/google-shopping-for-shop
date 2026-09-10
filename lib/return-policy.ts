// The return policy label one feed item carries.
//
// Merchant Center holds the policies and matches them by name, so the feed's
// only job is to name the right one. The name is the shop's own non-returnable
// note - the sentence the customer already reads on the product page - which
// means an owner writes the reason once and creates one Merchant Center policy
// per reason, rather than keeping a second list of codes in step with the first.
//
// Nothing is invented. A returnable item carries no label at all and is judged
// by the account's default policy, which is exactly what should happen to it.
import { fitShippingLabel } from '@/modules/google-shopping-for-shop/lib/feed-xml'
import { nonReturnableNote, resolveReturnable } from '@/modules/shop/lib/returnable'

/** What a product row contributes: the stored flag and the owner's wording,
 *  both of which may be null for "nothing said here". */
export type ReturnsSource = {
  returnable: boolean | null | undefined
  nonReturnableNote: string | null | undefined
}

/**
 * The label for one item, or undefined where it should carry none.
 *
 * The variation answers for itself where it has an answer and inherits its
 * listing's where it has not - the shop's own rule (resolveReturnable), not a
 * second one invented here, because an owner who marked one listing bespoke
 * expects all three hundred of its combinations to follow. A standalone product
 * simply passes itself as both halves.
 *
 * The note falls back to the shop's stock sentence when an owner has marked
 * something non-returnable without saying why: an item with no label would be
 * judged returnable by Google, which is the one answer that is definitely
 * wrong. It follows the note wherever it came from, so the wording on the page
 * and the policy in Merchant Center stay one thing.
 */
export function returnPolicyLabelFor(
  child: ReturnsSource | undefined,
  parent: ReturnsSource | undefined,
): string | undefined {
  if (resolveReturnable(child?.returnable, parent?.returnable)) return undefined
  // Whichever row settled the answer is the one whose wording applies. A child
  // marked non-returnable in its own right carries its own note where it has
  // one; anything else takes the listing's.
  const stored = child?.returnable === false
    ? (child.nonReturnableNote ?? parent?.nonReturnableNote)
    : (parent?.nonReturnableNote ?? child?.nonReturnableNote)
  // Same 100-character ceiling Google puts on shipping_label, and the same
  // fingerprinted shortening: a policy name has to be reproducible, and a plain
  // truncation of two long notes sharing an opening clause would collide.
  return fitShippingLabel(nonReturnableNote(stored))
}
