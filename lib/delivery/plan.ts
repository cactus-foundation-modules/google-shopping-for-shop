// What this site would send Merchant Center, worked out end to end.
//
// One place, because the Delivery tab, the push and the daily check must all
// be looking at the same payload. Three separate assemblies of "what we would
// send" is three chances for the thing compared, the thing previewed and the
// thing actually sent to differ.
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import {
  getDeliveryCatalogue,
  hasDeliveryCatalogue,
  type DeliveryCatalogue,
} from '@/modules/google-shopping-for-shop/lib/delivery/catalogue'
import { assignDeliveryLabels, type DeliveryLabelMap } from '@/modules/google-shopping-for-shop/lib/delivery/labels'
import {
  resolveDeliveryLabelAgreement,
  type DeliveryLabelRoute,
} from '@/modules/google-shopping-for-shop/lib/delivery/label-agreement'
import { mapDeliveryCatalogue, type DeliveryMapping } from '@/modules/google-shopping-for-shop/lib/delivery/mapping'
import { resolveDeliveryPricing } from '@/modules/google-shopping-for-shop/lib/delivery/pricing'
import { coverageNotes, measureDeliveryCoverage, type DeliveryCoverage } from '@/modules/google-shopping-for-shop/lib/delivery/coverage'

export type DeliveryPlan = {
  /** False where no installed module publishes delivery services at all. */
  available: boolean
  /** True where one does but what it sent back could not be understood. A
   *  state of its own, because "nothing publishes delivery" and "the delivery
   *  module answered with something we cannot read" call for different
   *  sentences and very different actions. */
  unreadable: boolean
  catalogue: DeliveryCatalogue | null
  labels: DeliveryLabelMap | null
  mapping: DeliveryMapping | null
  /** The Merchant Center account number, or null where it has not been set. */
  merchantId: string | null
  currency: string
  /** The tax rate the delivery charges were grossed up at, and whether the
   *  shop has more than one - which makes that figure an approximation. */
  taxRate: number
  taxRatesDiffer: boolean
  /** How many products a push would leave without a delivery price. Null when
   *  it was not asked for - it costs a pass over the catalogue, so the push
   *  and the daily check skip it and only the preview pays. */
  coverage: DeliveryCoverage | null
  /** Whether the labels the feed sends are the labels these rate groups name.
   *  False means nothing here can reach a product, which is why the mapping
   *  blocks on it. */
  labelsFromDeliveryScopes: boolean
  /** Which route got there, null where it did not. 'range-attribute' is the
   *  one the screen has to explain: nothing in the settings says "delivery
   *  rules", and the owner is owed a sentence saying why that is fine. */
  labelsVia: DeliveryLabelRoute | null
}

export type PlanOptions = {
  /** Count what would be left uncovered. The preview wants this; nothing else
   *  does, and it is the only expensive thing in here. */
  withCoverage?: boolean
}

export async function buildDeliveryPlan(options: PlanOptions = {}): Promise<DeliveryPlan> {
  const [settings, pricing] = await Promise.all([getGsfSettings(), resolveDeliveryPricing()])
  const base = {
    merchantId: settings.merchantId,
    currency: pricing.currency,
    taxRate: pricing.rateUsed,
    taxRatesDiffer: pricing.ratesDiffer,
  }

  if (!hasDeliveryCatalogue()) {
    return { available: false, unreadable: false, catalogue: null, labels: null, mapping: null, coverage: null, labelsFromDeliveryScopes: false, labelsVia: null, ...base }
  }

  const catalogue = await getDeliveryCatalogue()
  if (!catalogue) {
    return { available: true, unreadable: true, catalogue: null, labels: null, mapping: null, coverage: null, labelsFromDeliveryScopes: false, labelsVia: null, ...base }
  }

  const labels = assignDeliveryLabels(catalogue.scopes)
  // The two things that decide whether ANY of this reaches a product: whether
  // the labels the feed sends are the labels these rate groups name, and
  // whether it is also sending each item its own prices. Both come off the same
  // settings row the rest of this reads, so neither costs a query - and leaving
  // them out was how the preview came to report a healthy send that would have
  // mispriced the whole catalogue.
  //
  // The first is a question, not a setting: labelling by the delivery rules is
  // one way to agree, and labelling by the very attribute those rules write
  // their ranges against is another. label-agreement.ts holds the reasoning.
  const agreement = resolveDeliveryLabelAgreement({
    labelSource: settings.shippingLabelSource,
    labelAttributeId: settings.shippingLabelAttributeId,
    catalogue,
    labels,
  })
  const labelsFromDeliveryScopes = agreement.agreed
  const mapping = mapDeliveryCatalogue({
    catalogue,
    labels,
    country: settings.shippingCountry,
    currency: pricing.currency,
    grossUp: pricing.grossUp,
    labelsFromDeliveryScopes,
    perItemShippingOn: settings.sendDeliveryOptions,
  })

  // Counting what would be left uncovered needs a pass over the catalogue's
  // products, so it happens only where somebody is about to make a decision on
  // it. Its findings become ordinary notes, never blocking ones: an uncovered
  // product is a real problem with the shop's delivery rules, not a reason to
  // refuse to send the rules that ARE right.
  let coverage: DeliveryCoverage | null = null
  if (options.withCoverage && mapping.services.length > 0) {
    coverage = await measureDeliveryCoverage(mapping.services, labels, labelsFromDeliveryScopes)
    for (const note of coverageNotes(coverage)) mapping.notes.push({ severity: note.severity, service: null, message: note.message })
  }

  return { available: true, unreadable: false, catalogue, labels, mapping, coverage, labelsFromDeliveryScopes, labelsVia: agreement.via, ...base }
}
