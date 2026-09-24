// Which shipping services a push actually sends: ours, replaced; theirs, left
// exactly as they are; ours-but-retired, taken away.
//
// Pure, and in a file of its own, because it is the single most dangerous
// function in the delivery sync and the one most worth testing on its own.
// Merchant Center's insert REPLACES the whole resource: anything left out of
// the payload is deleted, without a warning, without an audit trail and
// without anybody noticing until a customer is quoted the wrong delivery
// charge. The rule below is the only thing standing between a push and
// somebody else's hand-made shipping service.
import type { MappedService } from '@/modules/google-shopping-for-shop/lib/delivery/mapping'
import type { MerchantService, MerchantShippingSettings } from '@/modules/google-shopping-for-shop/lib/delivery/merchant-types'

/**
 * The settings to send: everything Merchant Center holds, with this site's own
 * services replaced and its retired ones removed.
 *
 * Pure, so the merge rule can be tested without an account - and it is the rule
 * most worth testing, because the failure it guards against (quietly deleting a
 * service somebody set up by hand) leaves no trace at all.
 */
export function mergeShippingSettings(
  current: MerchantShippingSettings,
  mapped: MappedService[],
  previouslyManaged: string[],
): MerchantShippingSettings {
  const ours = new Map(mapped.map((service) => [service.serviceName, service.payload]))
  const retired = new Set(previouslyManaged)
  const services: MerchantService[] = []
  const placed = new Set<string>()

  for (const existing of current.services ?? []) {
    const name = typeof existing.serviceName === 'string' ? existing.serviceName : ''
    const mine = name ? ours.get(name) : undefined
    if (mine) {
      // Ours: our fields win, everything else Google holds on it is carried
      // across. An owner who set a minimum order value on one of our services
      // by hand keeps it.
      services.push({ ...existing, ...mine })
      placed.add(name)
      continue
    }
    // Ours once, and not any more. It goes, which is the only way a retired
    // delivery service ever stops being charged at Google.
    if (name && retired.has(name)) continue
    // Somebody else's. Untouched, in the position it was in.
    services.push(existing)
  }

  for (const service of mapped) {
    if (placed.has(service.serviceName)) continue
    services.push(service.payload)
  }

  return { ...current, services }
}
