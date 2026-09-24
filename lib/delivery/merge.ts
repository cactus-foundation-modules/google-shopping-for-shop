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
 * How many shipping services in a payload count towards one country's cap.
 *
 * Google allows twenty per country and refuses the WHOLE insert above it, so
 * this is counted before anything is sent rather than discovered afterwards -
 * a rejection loses every service in the push, including the ones that were
 * perfectly fine.
 *
 * A service with no countries on it is COUNTED. Google requires the field, so
 * one without it is something this site does not understand, and the safe
 * reading of a thing we do not understand is the one that might refuse a push
 * rather than the one that might lose it. Undercounting here is what a wrongly
 * accepted payload is made of.
 */
export function countServicesForCountry(settings: MerchantShippingSettings, country: string): number {
  return (settings.services ?? []).filter((service) => {
    const countries = service.deliveryCountries
    if (!Array.isArray(countries) || countries.length === 0) return true
    return countries.includes(country)
  }).length
}

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
