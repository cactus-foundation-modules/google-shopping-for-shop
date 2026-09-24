// Whether the labels the FEED puts on products and the labels these rate
// groups name are the same words.
//
// Pure. The whole question is a comparison of two settings against the shape of
// the delivery catalogue, so it can be answered - and argued with - on a laptop
// with no database and no Merchant Center account anywhere near it.
//
// Why it is not simply one setting. Merchant Center matches a rate group to a
// product by the product's `shipping_label`, so a push is only safe while every
// label the feed sends is a label the payload names. There are two ways for
// that to be true, not one:
//
//   'delivery-services'  the feed asks the delivery module which group each
//                        product falls in and names it with the same function
//                        this module names its rate groups with. True by
//                        construction.
//
//   'attribute'          the feed labels each product with a value of a product
//                        attribute. Usually a different list, kept in step by
//                        hand, and the reason this used to block outright.
//                        BUT the delivery module's RANGE scopes are values of
//                        an attribute too - `rangeAttributeId` says which one -
//                        so where the feed is labelling by THAT SAME attribute
//                        and every delivery rule is written against a range,
//                        the two lists are not two lists at all. They are the
//                        attribute's values, read twice, through the same
//                        `fitShippingLabel`. The labels agree because they
//                        cannot do anything else.
//
// The conditions below are each load-bearing, and none of them is a nicety:
//
//   - a DIFFERENT attribute is the hand-kept pair of lists the block is for.
//   - a CATEGORY, SUPPLIER or catch-all scope cannot be expressed as a value of
//     one attribute, so the moment the shop has one the two label sets really
//     do diverge and the block must stand.
//   - NO scopes at all is not agreement, it is nothing to agree about: no rate
//     group would name any label, and saying the labels match would be a
//     vacuous truth sold as a reassurance.
//   - a QUALIFIED label means two groups wanted the same name and one was
//     renamed to keep them apart (see labels.ts). The feed, labelling from the
//     attribute, knows nothing of that renaming and would send the plain name
//     for both - which is the silent mispricing this whole file exists to stop.
//   - an ABSENT rangeAttributeId is an older advanced-shipping that does not
//     publish one. Unknown, never equal, never an agreement.
import type { GsfLabelSource } from '@/modules/google-shopping-for-shop/lib/types'
import type { DeliveryCatalogue } from '@/modules/google-shopping-for-shop/lib/delivery/catalogue'
import type { DeliveryLabelMap } from '@/modules/google-shopping-for-shop/lib/delivery/labels'

/** Which of the two routes to agreement was taken. */
export type DeliveryLabelRoute = 'delivery-services' | 'range-attribute'

export type DeliveryLabelAgreement = {
  /** True where every label the feed sends is one the rate groups name, which
   *  is what a push needs and what the coverage count is honest about. */
  agreed: boolean
  /** How it was reached, or null where it was not. 'range-attribute' is the
   *  one worth saying out loud: the owner changed no setting, so the screen has
   *  to explain why it is no longer being told off. */
  via: DeliveryLabelRoute | null
}

const NO_AGREEMENT: DeliveryLabelAgreement = { agreed: false, via: null }

export function resolveDeliveryLabelAgreement(input: {
  /** Where the feed takes each product's shipping label from. */
  labelSource: GsfLabelSource
  /** The attribute it takes it from, on 'attribute'. */
  labelAttributeId: string | null
  catalogue: DeliveryCatalogue
  /** The names this module would give the catalogue's groups - the same map the
   *  payload is built from, so the qualification check below is about the
   *  labels that would really be sent. */
  labels: DeliveryLabelMap
}): DeliveryLabelAgreement {
  if (input.labelSource === 'delivery-services') return { agreed: true, via: 'delivery-services' }

  // 'attribute' is the only other source, and the interesting one.
  const labelAttributeId = input.labelAttributeId?.trim() || null
  const rangeAttributeId = input.catalogue.rangeAttributeId?.trim() || null
  if (!labelAttributeId || !rangeAttributeId || labelAttributeId !== rangeAttributeId) return NO_AGREEMENT

  const { scopes } = input.catalogue
  if (scopes.length === 0) return NO_AGREEMENT
  if (scopes.some((scope) => scope.kind !== 'RANGE')) return NO_AGREEMENT
  if (input.labels.qualified.length > 0) return NO_AGREEMENT

  return { agreed: true, via: 'range-attribute' }
}
