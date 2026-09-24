// Turning this shop's delivery rules into Merchant Center shipping services.
//
// Pure. No database, no network, no settings lookup - everything it needs is in
// the argument, so the whole mapping can be tested on a laptop with no Google
// account anywhere near it. That matters more here than anywhere else in this
// module: nobody can try a push against a real account without a real account,
// so the arithmetic has to be provable on its own.
//
// The two models do not line up, and the interesting part of this file is what
// happens where they do not:
//
//   This site                          Merchant Center
//   --------------------------------   ---------------------------------------
//   a price per (service, group)       a rate group per price, listing labels
//   a transit time per (service,       ONE delivery time per service
//     group)
//   a charge on every unit             one figure per product
//   bank holidays and a shop           a weekly pattern of business days, and
//     calendar                           no holidays at all
//
// Where something cannot be carried across, it is SAID - in the notes below,
// in the owner's words, at a severity that decides whether a push may go ahead.
// Nothing is trimmed to fit in silence. A delivery charge that is quietly wrong
// is the one failure here nobody finds out about until a customer complains.
import {
  MAX_LABELS_PER_RATE_GROUP,
  MAX_RATE_GROUPS_PER_SERVICE,
  MAX_SERVICES_PER_COUNTRY,
  businessDays,
  splitCutoff,
  toAmountMicros,
  type MerchantRateGroup,
  type MerchantService,
} from '@/modules/google-shopping-for-shop/lib/delivery/merchant-types'
import type {
  DeliveryCatalogue,
  DeliveryScope,
  DeliveryScopeKind,
  DeliveryServiceEntry,
} from '@/modules/google-shopping-for-shop/lib/delivery/catalogue'
import type { DeliveryLabelMap } from '@/modules/google-shopping-for-shop/lib/delivery/labels'

export type MappingSeverity = 'info' | 'warning' | 'blocking'

/** One thing the owner needs to know about the translation.
 *
 *  'blocking' is the important one: it means this service CANNOT be sent
 *  faithfully, so it is left out of the payload entirely and the push refuses
 *  while any remain. Sending a service we know to be wrong is worse than
 *  sending nothing. */
export type MappingNote = {
  severity: MappingSeverity
  /** The delivery service this is about, or null where it is about the shop. */
  service: string | null
  message: string
}

export type MappedRateGroup = {
  /** Gross price the group charges, or null where it says "not delivered". */
  price: number | null
  labels: string[]
  /** True on the group with no labels: everything the others did not catch. */
  catchAll: boolean
}

export type MappedService = {
  serviceKey: string
  serviceName: string
  handlingDays: number
  transitDays: number
  groups: MappedRateGroup[]
  /** Ready to send. */
  payload: MerchantService
}

export type DeliveryMapping = {
  services: MappedService[]
  notes: MappingNote[]
  /** True while anything is 'blocking', which is what stops a push. */
  blocked: boolean
}

export type MappingInput = {
  catalogue: DeliveryCatalogue
  labels: DeliveryLabelMap
  /** CLDR territory code the services apply to. */
  country: string
  /** Currency of every price in the payload; must match the shop's. */
  currency: string
  /** Turns a NET figure into what a shopper actually pays, exactly as the feed
   *  grosses a product price. Identity on a shop that stores gross. */
  grossUp: (net: number) => number
  /** Whether the FEED labels its items with these same delivery groups.
   *
   *  The single most important input here, and it defaults to false on a fresh
   *  install. Everything below builds rate groups that Merchant Center matches
   *  by shipping label - so if the feed is labelling items some other way, or
   *  not at all, every label named below matches nothing and every product in
   *  the shop drops through to the catch-all. See the blocking note in
   *  mapDeliveryCatalogue. */
  labelsFromDeliveryScopes: boolean
  /** Whether the feed also sends each item its OWN shipping prices. Google lets
   *  the per-item figure win, so the two features quietly cancel out. */
  perItemShippingOn: boolean
}

/**
 * The two working-day counts for one priced service, worked out the way the
 * shop itself works them out.
 *
 * A service floored at a minimum lead (installation never sooner than ten
 * working days, say) has the floor folded into HANDLING, not transit: the
 * parcel really is on the road for its usual time, it simply is not picked up
 * for a while. Folding it the other way would tell a courier-time reader
 * something plainly untrue.
 *
 * Deliberately a copy of the same rule in the delivery module rather than a
 * call into it - the two modules do not import each other, and the catalogue
 * hands over every figure the rule needs.
 */
export function deliveryCounts(
  dispatchLeadDays: number,
  transitDays: number,
  minLeadDays: number | null,
): { handlingDays: number; transitDays: number } {
  const transit = Math.max(0, transitDays)
  let handling = Math.max(0, dispatchLeadDays)
  const floor = minLeadDays ?? 0
  if (floor > handling + transit) handling = floor - transit
  return { handlingDays: handling, transitDays: transit }
}

/** Groups of at most `size`, order preserved. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size))
  return out
}

function scopeLabelOf(catalogue: DeliveryCatalogue, scopeId: string): string {
  return catalogue.scopes.find((scope) => scope.id === scopeId)?.label ?? scopeId
}

type PricedScope = {
  scopeId: string
  /** Gross, or null where this site REFUSES the service to this group. Null is
   *  never a zero: see the noShipping branch below. */
  price: number | null
  /** False where the shop has a rule saying the service is not offered here. */
  available: boolean
  handlingDays: number
  transitDays: number
  isDefaultScope: boolean
}

// Every group with a rule for this service, refusals INCLUDED.
//
// Dropping the refusals - which is what this did at first - is a silent
// mispricing, and the worst kind. A group with no rate group of its own falls
// through to the service's catch-all, so Merchant Center would go on offering
// and CHARGING a service this site refuses that product. The delivery module
// means the opposite by an unavailable rule: it removes the service from the
// product entirely. Google's word for that is noShipping, and it is what a
// refusal has to become.
function priceService(
  service: DeliveryServiceEntry,
  input: MappingInput,
): PricedScope[] {
  const { catalogue } = input
  const priced: PricedScope[] = []
  for (const rate of service.rates) {
    const counts = deliveryCounts(catalogue.dispatch.dispatchLeadDays, rate.transitDays, rate.minLeadDays)
    priced.push({
      scopeId: rate.scopeId,
      price: rate.available ? input.grossUp(rate.price) : null,
      available: rate.available,
      handlingDays: counts.handlingDays,
      transitDays: counts.transitDays,
      isDefaultScope: catalogue.scopes.find((scope) => scope.id === rate.scopeId)?.kind === 'DEFAULT',
    })
  }
  return priced
}

/** Most specific first, as the delivery module resolves them. */
const KIND_RANK: Record<DeliveryScopeKind, number> = { RANGE: 0, CATEGORY: 1, SUPPLIER: 2, DEFAULT: 3 }

/**
 * The groups this service cannot be expressed for, and why it is a blocker.
 *
 * A product carries ONE shipping label - the most specific group it falls in
 * across every delivery rule the shop has. But the shop resolves a price PER
 * SERVICE, and a service with no rule at that group falls through to whatever
 * coarser rule of ITS OWN matches the product. Which coarser rule that is
 * depends on the product's category and supplier, and a label does not carry
 * either, so one label cannot stand for one price.
 *
 * Worked example. A product is in range X. Service A has no rule for range X,
 * but has one for category C - the product's category - and one for everything.
 * The shop charges the category C price. The label says X, service A has no X
 * group, so Google charges the "everything" price instead. Wrong, silently.
 *
 * So: where a service could fall through to a coarser rule of its own, the
 * service is not sent at all and the owner is told why. Never a silent price.
 *
 * Two pairings are deliberately NOT treated as ambiguous, because neither can
 * fall through:
 *   - one supplier rule against another: a product has one supplier, so only
 *     its own supplier rule can ever match it.
 *   - one range rule against another: likewise, UNLESS a listing is tagged with
 *     two ranges at once, which is a real hole rather than an impossibility.
 *     It is not answerable from the rules - whether any product carries two
 *     ranges is a fact about the CATALOGUE - so it is detected and reported
 *     where the product facts are, in lib/delivery/coverage.ts, and only when a
 *     product really is double-tagged.
 * Categories are not exempt: they nest, so two category rules in one chain can
 * both match and the nearer one wins.
 */
function unexpressibleGroups(
  service: DeliveryServiceEntry,
  catalogue: DeliveryCatalogue,
  labelledScopeIds: Set<string>,
): string[] {
  const ruleScopes = service.rates
    .map((rate) => catalogue.scopes.find((scope) => scope.id === rate.scopeId))
    .filter((scope): scope is DeliveryScope => scope !== undefined)

  const trouble: string[] = []
  for (const label of catalogue.scopes) {
    if (label.kind === 'DEFAULT' || !labelledScopeIds.has(label.id)) continue
    // A rule at the group itself settles it: that is what the shop charges and
    // that is what the rate group will say.
    if (ruleScopes.some((scope) => scope.id === label.id)) continue
    const canFallThrough = ruleScopes.some((scope) => {
      if (scope.kind === 'DEFAULT') return false
      const rank = KIND_RANK[scope.kind]
      const labelRank = KIND_RANK[label.kind]
      if (rank > labelRank) return true
      return rank === labelRank && scope.kind === 'CATEGORY'
    })
    if (canFallThrough) trouble.push(label.label)
  }
  return trouble
}

function mapOneService(service: DeliveryServiceEntry, input: MappingInput): {
  mapped: MappedService | null
  notes: MappingNote[]
} {
  const notes: MappingNote[] = []
  const { catalogue, labels } = input
  const priced = priceService(service, input)
  const offered = priced.filter((scope) => scope.available)

  if (offered.length === 0 && !service.isDefault) {
    notes.push({
      severity: 'info',
      service: service.label,
      message: `"${service.label}" is not offered to anything at the moment, so it has not been sent.`,
    })
    return { mapped: null, notes }
  }

  // ---- Groups this service cannot be expressed for --------------------------
  // Checked before anything is built: a service that would price some products
  // wrongly is not sent at all, and there is no point pricing it first.
  const unexpressible = unexpressibleGroups(service, catalogue, new Set(labels.byScopeId.keys()))
  if (unexpressible.length > 0) {
    notes.push({
      severity: 'blocking',
      service: service.label,
      message: `"${service.label}" is priced by a different sort of rule from the one that names your products - it has a rule for a `
        + 'category or a supplier, while these groups are named by something more specific. Google matches a product by its one '
        + 'label, so it cannot tell which of your rules applies and some of these would be charged the wrong amount: '
        + `${unexpressible.slice(0, 8).join(', ')}${unexpressible.length > 8 ? `, and ${unexpressible.length - 8} more` : ''}. `
        + 'Nothing has been sent for this service. Give it a rule of its own for those groups, or write all of its rules against the '
        + 'same sort of thing.',
    })
    return { mapped: null, notes }
  }

  // ---- Delivery time --------------------------------------------------------
  // Merchant Center holds ONE delivery time per service; this site can vary it
  // per group. The slowest is sent, because a promise the shop cannot keep is
  // the expensive kind of wrong, and the owner is told which groups are being
  // quoted more slowly than they really are.
  //
  // Only the groups the service is actually OFFERED to count. A refused group
  // has no delivery time to promise, and letting one drag the figure out would
  // slow down every product that can genuinely have the service.
  //
  // The service's OWN timing is used only where no group has a price - the
  // shop's default service, reaching everything for nothing. Where groups do
  // exist, every product gets one of them, so folding the service's own figure
  // into the maximum would quote a delay that nothing is actually subject to.
  const ownCounts = deliveryCounts(catalogue.dispatch.dispatchLeadDays, service.transitDays, service.minLeadDays)
  const handlingDays = offered.length > 0 ? Math.max(...offered.map((scope) => scope.handlingDays)) : ownCounts.handlingDays
  const transitDays = offered.length > 0 ? Math.max(...offered.map((scope) => scope.transitDays)) : ownCounts.transitDays
  const quicker = offered.filter((scope) => scope.handlingDays < handlingDays || scope.transitDays < transitDays)
  if (quicker.length > 0) {
    const names = quicker.map((scope) => scopeLabelOf(catalogue, scope.scopeId)).join(', ')
    notes.push({
      severity: 'warning',
      service: service.label,
      message: `Google holds one delivery time per service, and "${service.label}" takes different lengths of time for different `
        + `groups. The slowest has been used - ${handlingDays} working ${handlingDays === 1 ? 'day' : 'days'} to send and `
        + `${transitDays} on the way - so these will be quoted more slowly than they really are: ${names}.`,
    })
  }

  // ---- Rate groups ----------------------------------------------------------
  // One group per price, then one group listing everything the service is
  // refused to, then the catch-all. The catch-all is the "everything" rule
  // where the shop has one, and is always last, which is the only position
  // Google allows an empty label list in.
  const catchAllScope = priced.find((scope) => scope.isDefaultScope)
  const labelled = priced.filter((scope) => !scope.isDefaultScope)

  // A group with no name Google can match against is the SAME failure as the
  // fall-through above: its products would be charged whatever the last rule
  // says instead of the price the shop actually holds for them. It used to be
  // only a warning, which meant one of the two wrong prices stopped a send and
  // the other went through - so both block, and both say the same thing.
  const unlabelled = labelled.filter((scope) => !labels.byScopeId.has(scope.scopeId))
  if (unlabelled.length > 0) {
    const names = unlabelled.map((scope) => scopeLabelOf(catalogue, scope.scopeId)).join(', ')
    notes.push({
      severity: 'blocking',
      service: service.label,
      message: `"${service.label}" has a price for groups that have no name Google can match against, so those products would be `
        + `charged whatever the last rule says instead: ${names}. Nothing has been sent for this service. Give those groups a name `
        + 'on this site and it can go.',
    })
    return { mapped: null, notes }
  }

  const byPrice = new Map<number, string[]>()
  const refused: string[] = []
  for (const scope of labelled) {
    const label = labels.byScopeId.get(scope.scopeId)
    if (!label) continue
    if (!scope.available || scope.price === null) {
      refused.push(label)
      continue
    }
    const existing = byPrice.get(scope.price) ?? []
    existing.push(label)
    byPrice.set(scope.price, existing)
  }

  const groups: MappedRateGroup[] = []
  for (const [price, groupLabels] of [...byPrice.entries()].sort((a, b) => a[0] - b[0])) {
    // Google takes 30 labels in a group; a price shared by more than that
    // becomes several groups charging the same, which is an exact mapping
    // rather than a compromise.
    for (const part of chunk([...groupLabels].sort((a, b) => a.localeCompare(b, 'en-GB')), MAX_LABELS_PER_RATE_GROUP)) {
      groups.push({ price, labels: part, catchAll: false })
    }
  }

  // The refusals, as their own groups. Before the catch-all, because a group
  // reached by the catch-all is a group being charged for a service it cannot
  // have.
  for (const part of chunk(refused.sort((a, b) => a.localeCompare(b, 'en-GB')), MAX_LABELS_PER_RATE_GROUP)) {
    groups.push({ price: null, labels: part, catchAll: false })
  }
  if (refused.length > 0) {
    notes.push({
      severity: 'info',
      service: service.label,
      message: `"${service.label}" is not offered to ${refused.length === 1 ? 'one group' : `${refused.length} groups`}, and Google `
        + 'is told so outright rather than being left to charge them the price below: '
        + `${refused.slice(0, 8).join(', ')}${refused.length > 8 ? `, and ${refused.length - 8} more` : ''}.`,
    })
  }

  if (catchAllScope) {
    groups.push({ price: catchAllScope.available ? catchAllScope.price : null, labels: [], catchAll: true })
  } else if (service.isDefault) {
    // The shop's default service reaches everything, free, whether or not a
    // rule mentions it - so its catch-all is free too.
    groups.push({ price: 0, labels: [], catchAll: true })
  } else {
    notes.push({
      severity: 'info',
      service: service.label,
      message: `"${service.label}" has no rule covering everything, so any product outside the groups above is not offered it. `
        + 'Google will price such a product on your other services only.',
    })
  }

  if (groups.length === 0) {
    notes.push({
      severity: 'info',
      service: service.label,
      message: `"${service.label}" has no price that could be sent, so it has been left out.`,
    })
    return { mapped: null, notes }
  }

  if (groups.length > MAX_RATE_GROUPS_PER_SERVICE) {
    notes.push({
      severity: 'blocking',
      service: service.label,
      message: `"${service.label}" needs ${groups.length} different prices and Google allows ${MAX_RATE_GROUPS_PER_SERVICE} per `
        + 'service. Nothing has been sent for it, because dropping the extra prices would charge those products the wrong amount. '
        + 'Give some of these groups the same price, or split the service in two.',
    })
    return { mapped: null, notes }
  }

  const { hour, minute } = splitCutoff(catalogue.dispatch.cutoffTime)
  const week = businessDays(catalogue.dispatch.shipDays)

  const payload: MerchantService = {
    serviceName: service.label,
    active: true,
    deliveryCountries: [input.country],
    currencyCode: input.currency,
    deliveryTime: {
      minHandlingDays: handlingDays,
      maxHandlingDays: handlingDays,
      minTransitDays: transitDays,
      maxTransitDays: transitDays,
      cutoffTime: { hour, minute, timeZone: catalogue.dispatch.timezone },
      handlingBusinessDayConfig: { businessDays: week },
      transitBusinessDayConfig: { businessDays: week },
    },
    rateGroups: groups.map((group): MerchantRateGroup => ({
      applicableShippingLabels: group.labels,
      // A null price is a REFUSAL, never a free delivery. Sending
      // toAmountMicros(0) here would advertise the one thing this site will not
      // do as the cheapest thing it does.
      singleValue: group.price === null
        ? { noShipping: true }
        : { flatRate: { amountMicros: toAmountMicros(group.price), currencyCode: input.currency } },
    })),
  }

  return {
    mapped: { serviceKey: service.key, serviceName: service.label, handlingDays, transitDays, groups, payload },
    notes,
  }
}

/**
 * Every delivery service this site offers, as Merchant Center shipping
 * services, with everything that could not be carried across said out loud.
 */
export function mapDeliveryCatalogue(input: MappingInput): DeliveryMapping {
  const { catalogue, labels } = input
  const notes: MappingNote[] = []

  // ---- Things that are true of the whole shop -------------------------------
  //
  // FIRST, because nothing below it matters if this is wrong.
  //
  // Merchant Center matches a rate group to a product by the product's
  // `shipping_label`, and the whole payload below names the delivery groups as
  // those labels. That only works if the FEED is labelling its items with the
  // same groups - the "Your own delivery rules" setting. On a fresh install it
  // is not: the default is to label by a product attribute, or not at all.
  //
  // Sent in that state, every rate group below would name a label no item in
  // the feed carries, and every product in the shop would be charged whatever
  // the last rule says. Nothing at Google's end would complain, the comparison
  // afterwards would read "Matches" - because it compares our payload with
  // itself, not with the feed - and the first sign of trouble would be a
  // customer's delivery charge.
  //
  // So it blocks rather than warns. The fix is one setting away, the tab says
  // which, and the alternative is a silent wrong price on every product - the
  // one outcome this whole file exists to prevent.
  if (!input.labelsFromDeliveryScopes) {
    notes.push({
      severity: 'blocking',
      service: null,
      message: 'Your products are not being labelled with these delivery groups, so nothing can be sent yet: Google matches these '
        + 'prices to products by their delivery group, and the feed is currently labelling them some other way. Open the Google '
        + 'Shopping settings tab, find "Group your products for delivery rates", and set "Where the group comes from" to "Your own '
        + 'delivery rules". Sending without that would charge every product in the shop whatever the last rule below says.',
    })
  }

  // Both switched on is not an error, but it is very likely a surprise: Google
  // takes the per-item figure ahead of the account rate, so the settings sent
  // from here would be overruled for every item the feed covers - while the
  // comparison on this tab went on reading "Matches".
  if (input.perItemShippingOn) {
    notes.push({
      severity: 'warning',
      service: null,
      message: 'You are also sending each product its own delivery prices with the feed ("Send your delivery charges with each '
        + 'product" on the settings tab). Google uses the per-product figure ahead of these account-wide ones, so for anything in '
        + 'the feed these rates are a fallback rather than the price - and this screen would still show them as matching. Use one or '
        + 'the other unless you know why you want both.',
    })
  }

  if (catalogue.pricing === 'per-unit') {
    notes.push({
      severity: 'warning',
      service: null,
      message: 'This site charges delivery on every item, and Google holds one delivery figure per product. What Google is told is '
        + 'the charge for buying ONE, which is what a shopper sees on the listing. A basket with several of something will cost more '
        + 'to deliver at the checkout than Google quoted.',
    })
  }

  if (catalogue.holidays.length > 0) {
    notes.push({
      severity: 'info',
      service: null,
      message: `Google works in whole weekdays and has nowhere to put bank holidays, so the ${catalogue.holidays.length} `
        + `${catalogue.holidays.length === 1 ? 'holiday' : 'holidays'} in your calendar are not sent. Dates around a bank holiday `
        + 'will read a day or two early on Google, and correctly on your own pages.',
    })
  }

  for (const entry of labels.qualified) {
    notes.push({
      severity: 'info',
      service: null,
      message: `Two delivery groups are both called "${entry.wanted}", so one of them goes to Google as "${entry.used}" instead. `
        + 'Google will not have two groups under one name.',
    })
  }

  // ---- The services themselves ----------------------------------------------
  const services: MappedService[] = []
  for (const service of catalogue.services) {
    const { mapped, notes: serviceNotes } = mapOneService(service, input)
    notes.push(...serviceNotes)
    if (mapped) services.push(mapped)
  }

  if (services.length > MAX_SERVICES_PER_COUNTRY) {
    notes.push({
      severity: 'blocking',
      service: null,
      message: `You have ${services.length} delivery services and Google allows ${MAX_SERVICES_PER_COUNTRY} per country. Nothing `
        + 'can be sent until some of them are retired or combined.',
    })
  }

  // A shop with no service at all is not an error, but it must not read as one
  // either: pushing an empty list would take away whatever is in Merchant
  // Center, which is never what somebody with no delivery rules set up meant.
  if (services.length === 0) {
    notes.push({
      severity: 'blocking',
      service: null,
      message: 'There is nothing to send: no delivery service on this site has a price Google could be told about. Your Merchant '
        + 'Center delivery settings have been left exactly as they are.',
    })
  }

  // One last thing worth saying plainly, once, with a figure in it.
  const freeGroups = services.flatMap((service) => service.groups.filter((group) => group.price === 0))
  if (freeGroups.length > 0) {
    notes.push({
      severity: 'info',
      service: null,
      message: `${freeGroups.length} of your delivery prices ${freeGroups.length === 1 ? 'is' : 'are'} free, and Google shows `
        + 'free delivery on the products they cover.',
    })
  }

  return { services, notes, blocked: notes.some((note) => note.severity === 'blocking') }
}
