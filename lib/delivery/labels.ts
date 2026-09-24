// One name per delivery group, used in BOTH places or it is worth nothing.
//
// A product goes to Google carrying `shipping_label`, and the account's rate
// groups are matched against that label. If the feed and the rate groups
// disagree about what a group is called - by so much as a trailing space - the
// product falls through to whatever the last rate group says, silently, and
// the owner sees a delivery charge they never set anywhere.
//
// So the naming happens once, here, pure, and both sides call it. No other
// file may build one of these strings.
//
// Google's rules, which this exists to satisfy:
//   - 100 characters maximum (fitShippingLabel, shared with the feed).
//   - the labels within one rate group are a disjunction, and labels must not
//     overlap between groups - so two different groups may never end up with
//     the same name.
import { fitShippingLabel } from '@/modules/google-shopping-for-shop/lib/feed-xml'
import type { DeliveryScope, DeliveryScopeKind } from '@/modules/google-shopping-for-shop/lib/delivery/catalogue'

/** What each kind of group is called when two of them want the same name.
 *  Plain words: these end up in front of the owner in Merchant Center. */
const KIND_SUFFIX: Record<DeliveryScopeKind, string> = {
  RANGE: 'range',
  CATEGORY: 'category',
  SUPPLIER: 'supplier',
  DEFAULT: 'everything else',
}

/** A short, stable fingerprint of a scope id, for the rare case where even the
 *  kind-qualified name is taken. Deterministic, so the label does not move
 *  between one feed build and the next. */
function fingerprint(scopeId: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < scopeId.length; index++) {
    hash ^= scopeId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).slice(0, 6)
}

export type DeliveryLabelMap = {
  /** scope id -> the label that scope's products carry. */
  byScopeId: Map<string, string>
  /** The scopes whose plain name was already taken, so their label had to be
   *  qualified. Worth telling the owner: the label they see in Merchant Center
   *  is not the word they typed on the delivery rule. */
  qualified: Array<{ scopeId: string; wanted: string; used: string }>
}

/**
 * A unique, Google-legal label for every scope, assigned in the order given.
 *
 * Order matters and must be stable: the first scope to want a name keeps it,
 * and the rest are qualified. The catalogue arrives sorted by the publishing
 * module for exactly this reason.
 */
export function assignDeliveryLabels(scopes: DeliveryScope[]): DeliveryLabelMap {
  const byScopeId = new Map<string, string>()
  const qualified: DeliveryLabelMap['qualified'] = []
  const taken = new Set<string>()

  for (const scope of scopes) {
    const wanted = fitShippingLabel(scope.label)
    // A group with no name at all cannot be labelled, and an empty
    // shipping_label is not a value Google accepts. Its products simply go
    // unlabelled, which leaves them to whichever rate group carries no labels -
    // and to NO delivery price at all where no service has one. Not a happy
    // outcome, but an honest one, and the Delivery tab counts it; inventing a
    // name would put them on a price nobody chose for them.
    if (!wanted) continue

    if (!taken.has(wanted)) {
      taken.add(wanted)
      byScopeId.set(scope.id, wanted)
      continue
    }

    const byKind = fitShippingLabel(`${scope.label} (${KIND_SUFFIX[scope.kind]})`)
    if (byKind && !taken.has(byKind)) {
      taken.add(byKind)
      byScopeId.set(scope.id, byKind)
      qualified.push({ scopeId: scope.id, wanted, used: byKind })
      continue
    }

    const byId = fitShippingLabel(`${scope.label} (${KIND_SUFFIX[scope.kind]} ${fingerprint(scope.id)})`)
    // fitShippingLabel only returns nothing for an empty string, and this one
    // never is - but the type says it can, and a label is not worth a throw.
    const used = byId ?? fingerprint(scope.id)
    taken.add(used)
    byScopeId.set(scope.id, used)
    qualified.push({ scopeId: scope.id, wanted, used })
  }

  return { byScopeId, qualified }
}
