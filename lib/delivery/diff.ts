// What Merchant Center holds, lined up against what this site would send.
//
// Pure: it takes the mapping and the settings Google returned and works out
// where they disagree. No calls, no database, so every comparison in it can be
// tested without an account.
//
// The comparison is deliberately field by field and in the owner's words. "The
// delivery settings are different" is not a useful thing to tell somebody who
// has to decide whether to overwrite them; "Next Day charges 9.99 here and
// 7.99 at Google" is.
import {
  fromAmountMicros,
  type MerchantRateGroup,
  type MerchantService,
} from '@/modules/google-shopping-for-shop/lib/delivery/merchant-types'
import type { MappedService } from '@/modules/google-shopping-for-shop/lib/delivery/mapping'

export type ServiceDiffStatus =
  /** Google has it and it says the same thing. */
  | 'match'
  /** Google has it and something about it is different. */
  | 'different'
  /** We would send it and Google has not got it. */
  | 'missing'
  /** Google has it and we would not send it. */
  | 'only-in-google'

export type FieldDifference = {
  /** In the owner's words - "What it charges", not "rateGroups". */
  field: string
  here: string
  atGoogle: string
}

export type ServiceComparison = {
  serviceName: string
  status: ServiceDiffStatus
  /** Only meaningful on 'only-in-google': true where this site put it there
   *  and a push would now take it away, false where somebody else made it and
   *  a push leaves it exactly as it is. */
  managed: boolean
  differences: FieldDifference[]
}

export type DeliveryDiff = {
  comparedAt: string
  /** Services that do not agree: different, missing, or ours and retired.
   *  A service somebody else made is NOT counted - it is not a disagreement,
   *  it is somebody else's business. */
  differences: number
  services: ServiceComparison[]
}

function days(min: number | undefined, max: number | undefined): string {
  if (min === undefined && max === undefined) return 'not set'
  if (min === max || max === undefined) return `${min} working ${min === 1 ? 'day' : 'days'}`
  if (min === undefined) return `up to ${max} working days`
  return `${min} to ${max} working days`
}

function cutoff(service: MerchantService): string {
  const time = service.deliveryTime?.cutoffTime
  if (!time) return 'not set'
  const hour = String(time.hour ?? 0).padStart(2, '0')
  const minute = String(time.minute ?? 0).padStart(2, '0')
  return `${hour}:${minute} ${time.timeZone ?? ''}`.trim()
}

function weekdays(list: string[] | undefined): string {
  if (!list || list.length === 0) return 'not set'
  return list.map((day) => day.charAt(0) + day.slice(1).toLowerCase()).join(', ')
}

/** One rate group as a single comparable, readable line. */
function groupLine(group: MerchantRateGroup): string {
  const labels = [...(group.applicableShippingLabels ?? [])].sort((a, b) => a.localeCompare(b, 'en-GB'))
  const who = labels.length === 0 ? 'everything else' : labels.join(' / ')
  if (group.singleValue?.noShipping) return `${who}: not delivered`
  const flat = fromAmountMicros(group.singleValue?.flatRate?.amountMicros)
  if (flat !== null) return `${who}: ${flat.toFixed(2)}`
  // A rate table, a carrier rate, a percentage - something this module does not
  // write and cannot summarise. Named rather than skipped, so a service that
  // looks equal is never one we simply could not read.
  return `${who}: a rate this site cannot read`
}

/** Every rate group, in a stable order, as one string. Sorted rather than
 *  positional: two settings that charge the same thing are the same settings,
 *  whatever order Google happens to list them in.
 *
 *  Sorting hides ONE thing that matters, though, which is why `catchAllOrder`
 *  exists beside it: where the group with no labels sits. Google reads an empty
 *  label list as "everything else" and allows it only on the LAST group, so a
 *  service whose catch-all sits in the middle charges half its products the
 *  catch-all price whatever the groups below it say. Sorted into the same
 *  string, that reads as a perfect match. */
function pricesOf(groups: MerchantRateGroup[] | undefined): string {
  return (groups ?? []).map(groupLine).sort((a, b) => a.localeCompare(b, 'en-GB')).join(' | ') || 'nothing set'
}

/** Where the "everything else" group sits, which is the one thing about the
 *  ORDER of rate groups that changes what a shopper is charged. */
function catchAllOrder(groups: MerchantRateGroup[] | undefined): string {
  const list = groups ?? []
  const positions = list
    .map((group, index) => ({ index, empty: (group.applicableShippingLabels ?? []).length === 0 }))
    .filter((entry) => entry.empty)
  if (positions.length === 0) return 'no catch-all rule'
  if (positions.length > 1) return `${positions.length} catch-all rules, which Google allows only one of`
  return positions[0]?.index === list.length - 1 ? 'catch-all rule last' : 'catch-all rule NOT last'
}

function compareService(ours: MappedService, theirs: MerchantService): FieldDifference[] {
  const differences: FieldDifference[] = []
  const mine = ours.payload

  const push = (field: string, here: string, atGoogle: string): void => {
    if (here !== atGoogle) differences.push({ field, here, atGoogle })
  }

  push('Countries', (mine.deliveryCountries ?? []).join(', '), (theirs.deliveryCountries ?? []).join(', ') || 'not set')
  push('Currency', mine.currencyCode ?? '', theirs.currencyCode ?? 'not set')
  push('Switched on', mine.active === false ? 'no' : 'yes', theirs.active === false ? 'no' : 'yes')
  push(
    'Time to send it',
    days(mine.deliveryTime?.minHandlingDays, mine.deliveryTime?.maxHandlingDays),
    days(theirs.deliveryTime?.minHandlingDays, theirs.deliveryTime?.maxHandlingDays),
  )
  push(
    'Time on the way',
    days(mine.deliveryTime?.minTransitDays, mine.deliveryTime?.maxTransitDays),
    days(theirs.deliveryTime?.minTransitDays, theirs.deliveryTime?.maxTransitDays),
  )
  push('Order-by time', cutoff(mine), cutoff(theirs))
  push(
    'Days you send on',
    weekdays(mine.deliveryTime?.handlingBusinessDayConfig?.businessDays),
    weekdays(theirs.deliveryTime?.handlingBusinessDayConfig?.businessDays),
  )
  push(
    'Days it travels on',
    weekdays(mine.deliveryTime?.transitBusinessDayConfig?.businessDays),
    weekdays(theirs.deliveryTime?.transitBusinessDayConfig?.businessDays),
  )
  push('What it charges', pricesOf(mine.rateGroups), pricesOf(theirs.rateGroups))
  push('Order of the rules', catchAllOrder(mine.rateGroups), catchAllOrder(theirs.rateGroups))

  return differences
}

export type DiffInput = {
  /** What this site would send. */
  ours: MappedService[]
  /** What Merchant Center holds now. */
  theirs: MerchantService[]
  /** Service names this site put there on a previous push. */
  managedNames: string[]
  comparedAt?: Date
}

/**
 * The comparison, service by service.
 *
 * Matching is by `serviceName`, because Merchant Center gives a shipping
 * service no id of its own - the name IS its identity, and it is unique within
 * an account. A renamed delivery service therefore reads as one gone and one
 * arrived, which is exactly what a push would do to it.
 */
export function diffShippingSettings(input: DiffInput): DeliveryDiff {
  const managed = new Set(input.managedNames)
  const theirsByName = new Map<string, MerchantService>()
  for (const service of input.theirs) {
    if (typeof service.serviceName === 'string') theirsByName.set(service.serviceName, service)
  }

  const services: ServiceComparison[] = []
  const seen = new Set<string>()

  for (const ours of input.ours) {
    seen.add(ours.serviceName)
    const theirs = theirsByName.get(ours.serviceName)
    if (!theirs) {
      services.push({ serviceName: ours.serviceName, status: 'missing', managed: true, differences: [] })
      continue
    }
    const differences = compareService(ours, theirs)
    services.push({
      serviceName: ours.serviceName,
      status: differences.length === 0 ? 'match' : 'different',
      managed: true,
      differences,
    })
  }

  for (const [name, service] of theirsByName) {
    if (seen.has(name)) continue
    services.push({
      serviceName: name,
      status: 'only-in-google',
      managed: managed.has(name),
      // Worth showing what it charges even for one nobody here manages: it is
      // the thing an owner needs in order to decide whether it ought to stay.
      differences: [{ field: 'What it charges', here: 'nothing - this site does not manage it', atGoogle: pricesOf(service.rateGroups) }],
    })
  }

  services.sort((a, b) => a.serviceName.localeCompare(b.serviceName, 'en-GB'))

  const differences = services.filter((service) => (
    service.status === 'different'
    || service.status === 'missing'
    || (service.status === 'only-in-google' && service.managed)
  )).length

  return {
    comparedAt: (input.comparedAt ?? new Date()).toISOString(),
    differences,
    services,
  }
}
