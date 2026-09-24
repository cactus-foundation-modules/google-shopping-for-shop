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
import { readDeliveryState } from '@/modules/google-shopping-for-shop/lib/delivery/state'
import { coverageNotes, measureDeliveryCoverage, type DeliveryCoverage } from '@/modules/google-shopping-for-shop/lib/delivery/coverage'
import type { DeliveryDiff } from '@/modules/google-shopping-for-shop/lib/delivery/diff'

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
  /** The CLDR territory the services are sent for. Google's cap on shipping
   *  services is per country, so the send has to count within this one. */
  country: string
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

/**
 * Shipping services Merchant Center holds that this site does not manage,
 * as of the last comparison.
 *
 * Zero where no comparison has ever been made, which is honestly "not known"
 * rather than "none": a shop that has never compared cannot know what is over
 * there. The send counts the real payload against a fresh read before it goes,
 * so the worst this costs is a split that has to be refused at the last moment
 * with the real figures in the sentence.
 */
function unmanagedAtGoogle(diff: DeliveryDiff | null): number {
  if (!diff) return 0
  return diff.services.filter((service) => service.status === 'only-in-google' && !service.managed).length
}

export async function buildDeliveryPlan(options: PlanOptions = {}): Promise<DeliveryPlan> {
  // The saved comparison comes along for one number: how many shipping
  // services Merchant Center already holds that this site does not manage.
  // They count towards Google's cap of twenty per country, because every send
  // copies them back untouched - so the mapping needs them before it decides
  // how many services to split into.
  //
  // Read HERE rather than passed in by each caller, and that is the whole
  // point: the preview and the send both build their plan through this
  // function, so they read the same number from the same row and cannot
  // disagree about what would be sent. A caller-supplied figure would make the
  // send's payload differ from the previewed one and every push would be
  // refused as stale.
  const [settings, pricing, state] = await Promise.all([
    getGsfSettings(),
    resolveDeliveryPricing(),
    readDeliveryState(),
  ])
  const base = {
    merchantId: settings.merchantId,
    country: settings.shippingCountry,
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
    unmanagedServiceCount: unmanagedAtGoogle(state.lastDiff),
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
