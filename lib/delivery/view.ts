// What the Delivery tab is given, shaped for drawing rather than for working
// with. Pure, so the shape is testable and the route stays a route.
//
// Everything here crosses the wire, so dates are ISO strings and nothing is a
// class. Nothing here is a decision either: the tab draws what it is told and
// the arithmetic has already happened.
import type { DeliveryPlan } from '@/modules/google-shopping-for-shop/lib/delivery/plan'
import type { DeliverySyncState } from '@/modules/google-shopping-for-shop/lib/delivery/state'
import type { DeliveryDiff } from '@/modules/google-shopping-for-shop/lib/delivery/diff'
import type { MappingNote } from '@/modules/google-shopping-for-shop/lib/delivery/mapping'
import type { DeliveryCoverage } from '@/modules/google-shopping-for-shop/lib/delivery/coverage'
import { planFingerprint } from '@/modules/google-shopping-for-shop/lib/delivery/fingerprint'
import type { GsfSettings } from '@/modules/google-shopping-for-shop/lib/types'

/** One delivery service as the preview table draws it. */
export type DeliveryServiceView = {
  serviceName: string
  handlingDays: number
  transitDays: number
  groups: Array<{
    /** Gross, in the shop's currency. */
    price: number | null
    labels: string[]
    catchAll: boolean
  }>
}

export type DeliveryTabView = {
  /** False where nothing on this site publishes delivery services. */
  available: boolean
  /** True where something does and its answer could not be understood. */
  unreadable: boolean
  /** False where the Merchant Center account number has not been filled in;
   *  the preview still works, only the comparing and sending do not. */
  linked: boolean
  currency: string
  /** What the delivery charges were grossed up at, and whether that figure is
   *  an approximation because the shop taxes its products at several rates. */
  taxRate: number
  taxRatesDiffer: boolean
  /** Whether the daily check is switched on. */
  syncEnabled: boolean
  /** What we would send. */
  services: DeliveryServiceView[]
  /** Everything about the translation the owner needs to know. */
  notes: MappingNote[]
  /** True while any note is blocking, which is what stops the send. */
  blocked: boolean
  /** Whether the feed labels its items with these delivery groups. False is
   *  the default on a fresh install, and it is what the first blocking note is
   *  about - drawn apart from the rest because it is a setting the owner can
   *  change, not an awkward delivery rule they have to rework. */
  labelsFromDeliveryScopes: boolean
  /** The last comparison, or null where none has been made. Stale by
   *  definition, hence comparedAt sitting on it. */
  lastDiff: DeliveryDiff | null
  /** When anything was last sent, ISO, or null for never. */
  pushedAt: string | null
  /** Merchant Center services this site owns. Anything else over there is
   *  left alone by every push. */
  managedServices: string[]
  /** How many products would be left without a delivery price. Null where it
   *  was not measured. */
  coverage: DeliveryCoverage | null
  /** What a send must echo back, so it cannot send something other than what
   *  was read. Empty where there is nothing to send. */
  fingerprint: string
}

export function toTabView(plan: DeliveryPlan, state: DeliverySyncState, settings: GsfSettings): DeliveryTabView {
  return {
    available: plan.available,
    unreadable: plan.unreadable,
    linked: plan.merchantId !== null,
    currency: plan.currency,
    taxRate: plan.taxRate,
    taxRatesDiffer: plan.taxRatesDiffer,
    syncEnabled: settings.deliverySyncEnabled,
    services: (plan.mapping?.services ?? []).map((service) => ({
      serviceName: service.serviceName,
      handlingDays: service.handlingDays,
      transitDays: service.transitDays,
      groups: service.groups.map((group) => ({ price: group.price, labels: group.labels, catchAll: group.catchAll })),
    })),
    notes: plan.mapping?.notes ?? [],
    blocked: plan.mapping?.blocked ?? false,
    labelsFromDeliveryScopes: plan.labelsFromDeliveryScopes,
    lastDiff: state.lastDiff,
    pushedAt: state.pushedAt ? state.pushedAt.toISOString() : null,
    managedServices: state.managedServices,
    coverage: plan.coverage,
    fingerprint: plan.mapping ? planFingerprint(plan.mapping.services, state.managedServices) : '',
  }
}
