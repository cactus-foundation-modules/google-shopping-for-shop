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
  MAX_SERVICE_NAME_LENGTH,
  MAX_SERVICES_PER_COUNTRY,
  businessDays,
  splitCutoff,
  toAmountMicros,
  type MerchantRateGroup,
  type MerchantService,
} from '@/modules/google-shopping-for-shop/lib/delivery/merchant-types'
import {
  assignServiceNames,
  type ServiceNameRequest,
} from '@/modules/google-shopping-for-shop/lib/delivery/service-names'
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
  /** The site delivery service this came from. NOT unique across the list: a
   *  service that delivers at several speeds becomes several of these, all
   *  carrying the same key under different names. */
  serviceKey: string
  /** What Merchant Center calls it. Unique across the payload, within Google's
   *  50 characters, and built in exactly one place - see
   *  lib/delivery/service-names.ts. */
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
  /** Whether the labels the FEED puts on its items are the labels named below.
   *
   *  The single most important input here, and it defaults to false on a fresh
   *  install. Everything below builds rate groups that Merchant Center matches
   *  by shipping label - so if the feed is labelling items some other way, or
   *  not at all, every label named below matches nothing and every product in
   *  the shop drops through to the catch-all. See the blocking note in
   *  mapDeliveryCatalogue, and lib/delivery/label-agreement.ts for the two ways
   *  this comes to be true. */
  labelsFromDeliveryScopes: boolean
  /** Whether the feed also sends each item its OWN shipping prices. Google lets
   *  the per-item figure win, so the two features quietly cancel out. */
  perItemShippingOn: boolean
  /** How many shipping services Merchant Center already holds for this country
   *  that this site does NOT manage. Every push copies them back untouched, so
   *  they count towards Google's cap of twenty per country just as ours do.
   *
   *  Optional, and zero where it has never been asked: a shop that has not
   *  compared yet genuinely does not know. That is why the send counts the real
   *  payload again against a fresh read before it goes - the number here decides
   *  how much splitting to attempt, and the send decides whether it may go at
   *  all. Both read it from the same saved comparison, so the preview and the
   *  send never disagree about what would be sent. */
  unmanagedServiceCount?: number
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


// ---------------------------------------------------------------------------
// One site service, at however many speeds it delivers at
// ---------------------------------------------------------------------------
//
// Merchant Center holds ONE delivery time per service, and this site can vary
// it per group. That used to be settled by sending the slowest and warning
// about it - which meant a service with twenty-five groups at five days and
// one at fourteen quoted the whole lot at fourteen. The outliers were not a
// mistake to be fixed by the owner; they were honest variety, flattened into
// its worst case and then reported as fine.
//
// So a service that delivers at several speeds goes as several services, one
// per speed, each carrying only the rate groups that really deliver at it.
// Google's own limit on services per country is the one thing that can force
// the old behaviour back, and mapDeliveryCatalogue below says so out loud when
// it does.

/** One speed a service delivers at, with the groups delivered at it. */
type ServiceTiming = {
  handlingDays: number
  transitDays: number
  /** The labelled groups delivered at this speed. */
  scopes: PricedScope[]
  /** True where the service's "everything else" rule belongs at this speed. */
  carriesCatchAll: boolean
  /** Gross price of that catch-all, or null for "not delivered". Only read
   *  where carriesCatchAll. */
  catchAllPrice: number | null
  /** How many of the shop's groups this speed covers, the catch-all counted as
   *  one. Decides which speed keeps the plain service name. */
  weight: number
}

/** One service as it will be sent, before it has a name. */
export type TimingDraft = {
  handlingDays: number
  transitDays: number
  groups: MappedRateGroup[]
  /** True on the one speed that keeps the plain name. */
  plain: boolean
}

type ServiceDraft = {
  serviceKey: string
  /** What this site calls the delivery service all of these came from. */
  sourceLabel: string
  /** Plain-named speed first, then the rest quickest first. */
  timings: TimingDraft[]
  /** Working days between the quickest and the slowest of them, 0 where there
   *  is only one. How much honesty a collapse back to one service would cost,
   *  which is what decides the order things are collapsed in. */
  spread: number
}

/** Identifies one emitted service for naming. Never shown to anybody. */
function nameKey(serviceKey: string, sourceLabel: string, timing: { handlingDays: number; transitDays: number }): string {
  return `${serviceKey}\u0000${sourceLabel}\u0000${timing.handlingDays}:${timing.transitDays}`
}

/** Quickest first, and deterministic. */
function bySpeed(a: { handlingDays: number; transitDays: number }, b: { handlingDays: number; transitDays: number }): number {
  return a.transitDays - b.transitDays || a.handlingDays - b.handlingDays
}

/**
 * The rate groups for one speed.
 *
 * Order is not cosmetic. The catch-all is the only group Google allows an
 * empty label list on and only in last place, and everything refused has to sit
 * BEFORE it - a group reached by the catch-all is a group being charged for a
 * service it cannot have.
 *
 * `elsewhere` is the labels this service delivers at some OTHER speed, and it
 * is only ever non-empty on the speed carrying the catch-all. Without it a
 * product in the fourteen-day group would match no rate group in the five-day
 * service, fall through to that service's catch-all, and be quoted the wrong
 * price at the wrong speed - which is the same silent mispricing the split
 * exists to end. Speeds with no catch-all need nothing: a label matching no
 * group there simply means the service is not offered, which is true.
 */
function rateGroupsFor(
  timing: ServiceTiming,
  labels: DeliveryLabelMap,
  refused: string[],
  elsewhere: string[],
): MappedRateGroup[] {
  const groups: MappedRateGroup[] = []

  const byPrice = new Map<number, string[]>()
  for (const scope of timing.scopes) {
    const label = labels.byScopeId.get(scope.scopeId)
    if (!label || scope.price === null) continue
    const existing = byPrice.get(scope.price) ?? []
    existing.push(label)
    byPrice.set(scope.price, existing)
  }

  for (const [price, groupLabels] of [...byPrice.entries()].sort((a, b) => a[0] - b[0])) {
    // Google takes 30 labels in a group; a price shared by more than that
    // becomes several groups charging the same, which is an exact mapping
    // rather than a compromise.
    for (const part of chunk([...groupLabels].sort((a, b) => a.localeCompare(b, 'en-GB')), MAX_LABELS_PER_RATE_GROUP)) {
      groups.push({ price, labels: part, catchAll: false })
    }
  }

  for (const part of chunk([...refused].sort((a, b) => a.localeCompare(b, 'en-GB')), MAX_LABELS_PER_RATE_GROUP)) {
    groups.push({ price: null, labels: part, catchAll: false })
  }

  for (const part of chunk([...elsewhere].sort((a, b) => a.localeCompare(b, 'en-GB')), MAX_LABELS_PER_RATE_GROUP)) {
    groups.push({ price: null, labels: part, catchAll: false })
  }

  if (timing.carriesCatchAll) {
    groups.push({ price: timing.catchAllPrice, labels: [], catchAll: true })
  }

  return groups
}

type MapServiceOptions = {
  /** Send it as ONE service at its slowest speed, the way this worked before
   *  the split. Only ever set by the cap fallback below - a service that
   *  genuinely delivers at one speed takes the ordinary path and comes out
   *  byte for byte as it always did. */
  collapseForCap: boolean
}

function mapOneService(service: DeliveryServiceEntry, input: MappingInput, options: MapServiceOptions): {
  draft: ServiceDraft | null
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
    return { draft: null, notes }
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
    return { draft: null, notes }
  }

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
    return { draft: null, notes }
  }

  // The groups this site REFUSES the service to, which become noShipping rather
  // than being left out. Dropping them - which is what this did at first - is a
  // silent mispricing: a group with no rate group of its own falls through to
  // the catch-all, so Merchant Center would go on offering and CHARGING a
  // service this site refuses that product.
  const refused: string[] = []
  const offeredLabelled: PricedScope[] = []
  for (const scope of labelled) {
    const label = labels.byScopeId.get(scope.scopeId)
    if (!label) continue
    if (!scope.available || scope.price === null) refused.push(label)
    else offeredLabelled.push(scope)
  }

  // The service's OWN timing is used only where no group has a price - the
  // shop's default service, reaching everything for nothing. Where groups do
  // exist, every product gets one of them.
  const ownCounts = deliveryCounts(catalogue.dispatch.dispatchLeadDays, service.transitDays, service.minLeadDays)

  // ---- The speeds it delivers at --------------------------------------------
  const timings = new Map<string, ServiceTiming>()
  const at = (handlingDays: number, transitDays: number): ServiceTiming => {
    const key = `${handlingDays}:${transitDays}`
    const found = timings.get(key)
    if (found) return found
    const made: ServiceTiming = { handlingDays, transitDays, scopes: [], carriesCatchAll: false, catchAllPrice: null, weight: 0 }
    timings.set(key, made)
    return made
  }

  // Only the groups the service is actually OFFERED to count towards the
  // slowest. A refused group has no delivery time to promise, and letting one
  // drag the figure out would slow down every product that can genuinely have
  // the service.
  const slowest = options.collapseForCap
    ? at(
      offered.length > 0 ? Math.max(...offered.map((scope) => scope.handlingDays)) : ownCounts.handlingDays,
      offered.length > 0 ? Math.max(...offered.map((scope) => scope.transitDays)) : ownCounts.transitDays,
    )
    : null

  for (const scope of offeredLabelled) {
    const timing = slowest ?? at(scope.handlingDays, scope.transitDays)
    timing.scopes.push(scope)
    timing.weight++
  }

  if (catchAllScope?.available) {
    const timing = slowest ?? at(catchAllScope.handlingDays, catchAllScope.transitDays)
    timing.carriesCatchAll = true
    timing.catchAllPrice = catchAllScope.price
    timing.weight++
  } else if (!catchAllScope && service.isDefault) {
    // The shop's default service reaches everything, free, whether or not a
    // rule mentions it - so its catch-all is free too, at the service's own
    // speed.
    const timing = slowest ?? at(ownCounts.handlingDays, ownCounts.transitDays)
    timing.carriesCatchAll = true
    timing.catchAllPrice = 0
    timing.weight++
  }

  if (timings.size === 0) {
    notes.push({
      severity: 'info',
      service: service.label,
      message: `"${service.label}" has no price that could be sent, so it has been left out.`,
    })
    return { draft: null, notes }
  }

  // Which speed keeps the plain name: the one covering the most groups, and
  // where two cover the same number, the quicker. Never the insertion order -
  // a name that moved between runs would make every push read as a change.
  const ranked = [...timings.values()].sort((a, b) => (
    b.weight - a.weight
    || (a.handlingDays + a.transitDays) - (b.handlingDays + b.transitDays)
    || bySpeed(a, b)
  ))
  const plain = ranked[0]
  if (!plain) {
    notes.push({
      severity: 'info',
      service: service.label,
      message: `"${service.label}" has no price that could be sent, so it has been left out.`,
    })
    return { draft: null, notes }
  }

  // A refusal has no speed to promise, so the "everything else: not delivered"
  // rule rides with whatever speed most of the service delivers at rather than
  // inventing a timing of its own.
  if (catchAllScope && !catchAllScope.available) {
    plain.carriesCatchAll = true
    plain.catchAllPrice = null
  }

  if (!catchAllScope && !service.isDefault) {
    notes.push({
      severity: 'info',
      service: service.label,
      message: `"${service.label}" has no rule covering everything, so any product outside the groups above is not offered it. `
        + 'Google will price such a product on your other services only.',
    })
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

  // ---- What each speed carries ----------------------------------------------
  const ordered = [plain, ...[...timings.values()].filter((timing) => timing !== plain).sort(bySpeed)]
  const drafts: TimingDraft[] = ordered.map((timing) => {
    const elsewhere = timing.carriesCatchAll
      ? ordered
        .filter((other) => other !== timing)
        .flatMap((other) => other.scopes.flatMap((scope) => {
          const label = labels.byScopeId.get(scope.scopeId)
          return label ? [label] : []
        }))
      : []
    return {
      handlingDays: timing.handlingDays,
      transitDays: timing.transitDays,
      groups: rateGroupsFor(timing, labels, refused, elsewhere),
      plain: timing === plain,
    }
  })

  // Nothing priced at any speed. Only reachable on the collapse path, which
  // makes its one speed before it knows whether anything hangs off it - but it
  // is the same "left out, and told why" the split path gives, rather than a
  // service sent to Google with no rate group in it at all.
  if (drafts.every((draft) => draft.groups.length === 0)) {
    notes.push({
      severity: 'info',
      service: service.label,
      message: `"${service.label}" has no price that could be sent, so it has been left out.`,
    })
    return { draft: null, notes }
  }

  const totals = drafts.map((draft) => draft.handlingDays + draft.transitDays)
  const spread = totals.length > 1 ? Math.max(...totals) - Math.min(...totals) : 0

  if (options.collapseForCap) {
    // Said in full, because the owner is being given a worse answer than the
    // one this site would rather give and is owed the reason.
    const quicker = offered.filter((scope) => scope.handlingDays < plain.handlingDays || scope.transitDays < plain.transitDays)
    const names = quicker.map((scope) => scopeLabelOf(catalogue, scope.scopeId)).join(', ')
    notes.push({
      severity: 'warning',
      service: service.label,
      message: `"${service.label}" takes different lengths of time for different groups, and Google holds one delivery time per `
        + `service. Normally each speed would go as a service of its own, but that would take you past Google's limit of `
        + `${MAX_SERVICES_PER_COUNTRY} delivery services per country - so the slowest has been used for all of them: `
        + `${plain.handlingDays} working ${plain.handlingDays === 1 ? 'day' : 'days'} to send and ${plain.transitDays} on the way. `
        + `These will be quoted more slowly than they really are: ${names}.`,
    })
  } else if (drafts.length > 1) {
    notes.push({
      severity: 'info',
      service: service.label,
      message: `"${service.label}" takes different lengths of time for different groups, and Google holds one delivery time per `
        + `service - so it goes to Merchant Center as ${drafts.length} services, one per length of time, each covering only the `
        + 'groups that really take that long. You will see all of them in Merchant Center under slightly different names.',
    })
  }

  return {
    draft: { serviceKey: service.key, sourceLabel: service.label, timings: drafts, spread },
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
  //
  // "The same groups" is a question, not a setting, and the caller has already
  // answered it: labelling by the delivery rules agrees by construction, and so
  // does labelling by the very product attribute those rules write their ranges
  // against, which is the same words read twice. lib/delivery/label-agreement.ts
  // holds the reasoning and the conditions. Everything below only needs the
  // answer.
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
  const drafted = catalogue.services.map((service) => {
    const mapped = mapOneService(service, input, { collapseForCap: false })
    return { service, draft: mapped.draft, notes: mapped.notes }
  })

  // ---- Google's cap on services per country ---------------------------------
  //
  // Splitting by speed makes more services, and Google refuses the WHOLE
  // payload above twenty per country - counting services this site does not
  // manage, which are copied back untouched by every push. So the count is
  // taken first, and where it would not fit, services are collapsed back to one
  // apiece until it does.
  //
  // Least costly first, which means the ones whose speeds differ LEAST. A
  // service whose slowest group is fourteen days against five is where the lie
  // is worst, so it is the last thing collapsed, not the first.
  //
  // `unmanagedServiceCount` comes from the last comparison, so the preview and
  // the send work from the same number and agree on what would go. The send
  // counts the real payload again afterwards against a fresh read and refuses
  // outright if it still does not fit - see lib/delivery/push.ts.
  const unmanaged = Math.max(0, Math.trunc(input.unmanagedServiceCount ?? 0))
  let wanted = drafted.reduce((total, entry) => total + (entry.draft?.timings.length ?? 0), 0) + unmanaged
  const collapsed: string[] = []
  if (wanted > MAX_SERVICES_PER_COUNTRY) {
    const splitters = drafted
      .flatMap((entry) => (entry.draft && entry.draft.timings.length > 1 ? [{ entry, draft: entry.draft }] : []))
      .sort((a, b) => (
        a.draft.spread - b.draft.spread
        || a.draft.timings.length - b.draft.timings.length
        || a.draft.sourceLabel.localeCompare(b.draft.sourceLabel, 'en-GB')
      ))
    for (const { entry, draft } of splitters) {
      if (wanted <= MAX_SERVICES_PER_COUNTRY) break
      const again = mapOneService(entry.service, input, { collapseForCap: true })
      // What the collapse actually saved, not what it was assumed to save. A
      // collapse that came back with nothing at all has cost the service every
      // one of its entries, and guessing "one fewer" there would leave the
      // count believing a slot was still in use.
      wanted -= draft.timings.length - (again.draft?.timings.length ?? 0)
      entry.draft = again.draft
      entry.notes = again.notes
      collapsed.push(draft.sourceLabel)
    }
  }

  if (collapsed.length > 0) {
    notes.push({
      severity: 'warning',
      service: null,
      message: `Google allows ${MAX_SERVICES_PER_COUNTRY} delivery services per country, and sending one for every different `
        + `length of time would have gone past it. ${collapsed.length === 1 ? 'This one has' : `These ${collapsed.length} have`} `
        + 'been sent at their slowest speed instead, starting with the ones whose times differ least: '
        + `${collapsed.join(', ')}. Anything not listed here still goes at its own speed.`,
    })
  }

  if (wanted > MAX_SERVICES_PER_COUNTRY) {
    notes.push({
      severity: 'blocking',
      service: null,
      message: `This would leave ${wanted} delivery services in your Merchant Center account and Google allows `
        + `${MAX_SERVICES_PER_COUNTRY} per country, so nothing has been sent. `
        + (unmanaged > 0
          ? `${unmanaged} of them ${unmanaged === 1 ? 'is one' : 'are ones'} this site does not manage, which every send copies `
            + 'back untouched. Remove some of those in Merchant Center, or retire or combine some delivery services here.'
          : 'Retire or combine some of your delivery services here.'),
    })
  }

  // ---- Naming ---------------------------------------------------------------
  //
  // All of them at once, because the names have to be unique across the whole
  // payload and not merely within one service. Order is catalogue order with
  // each service's plain-named speed first, so the ordinary services keep their
  // ordinary names and it is the unusual speeds that get qualified.
  const requests: ServiceNameRequest[] = []
  for (const entry of drafted) {
    const draft = entry.draft
    if (!draft) continue
    for (const timing of draft.timings) {
      requests.push({
        key: nameKey(draft.serviceKey, draft.sourceLabel, timing),
        label: draft.sourceLabel,
        handlingDays: timing.handlingDays,
        transitDays: timing.transitDays,
        plain: timing.plain,
      })
    }
  }
  // Positional, and taken back positionally below. Two site services that share
  // a name would share a key, and anything looked up BY that key would hand
  // them both the same Merchant Center name - which is the one thing a service
  // name may never be, since Merchant Center has no other way to tell two
  // services apart.
  const names = assignServiceNames(requests)

  // ---- Assembling the payload -----------------------------------------------
  //
  // Every limit Google enforces on a thing this file BUILDS is checked here,
  // at the moment it becomes a payload, and a service that fails one is left
  // out entirely rather than sent and hoped for. Google refuses the whole
  // request over one bad service, so sending a name we have counted as too
  // long would lose the services that were perfectly fine along with it.
  const { hour, minute } = splitCutoff(catalogue.dispatch.cutoffTime)
  const week = businessDays(catalogue.dispatch.shipDays)
  const services: MappedService[] = []
  let cursor = 0

  for (const entry of drafted) {
    notes.push(...entry.notes)
    const draft = entry.draft
    if (!draft) continue

    const mine = names.slice(cursor, cursor + draft.timings.length)
    cursor += draft.timings.length

    const built: MappedService[] = []
    let refusal: string | null = null
    for (const [index, timing] of draft.timings.entries()) {
      const name = mine[index] ?? null
      if (name === null) {
        refusal = `"${draft.sourceLabel}" could not be given a name Google would accept: it needs a different name for each `
          + 'length of time it takes, they have to fit inside 50 characters, and no two services may share one. Nothing has been '
          + 'sent for it. Give it a shorter name on this site and it can go.'
        break
      }
      if (name.length > MAX_SERVICE_NAME_LENGTH) {
        // Belt and braces on assignServiceNames' own promise. If this ever
        // fires it is a bug here, not a fact about the shop - but it fires as a
        // refusal rather than as a payload Google throws out wholesale.
        refusal = `"${draft.sourceLabel}" would be sent to Google as "${name}", which is ${name.length} characters, and Google `
          + `allows ${MAX_SERVICE_NAME_LENGTH}. Nothing has been sent for it. Give it a shorter name on this site.`
        break
      }
      if (timing.groups.length > MAX_RATE_GROUPS_PER_SERVICE) {
        refusal = `"${name}" needs ${timing.groups.length} different prices and Google allows ${MAX_RATE_GROUPS_PER_SERVICE} per `
          + 'service. Nothing has been sent for it, because dropping the extra prices would charge those products the wrong '
          + 'amount. Give some of these groups the same price, or split the service in two.'
        break
      }

      built.push({
        serviceKey: draft.serviceKey,
        serviceName: name,
        handlingDays: timing.handlingDays,
        transitDays: timing.transitDays,
        groups: timing.groups,
        payload: {
          serviceName: name,
          active: true,
          deliveryCountries: [input.country],
          currencyCode: input.currency,
          deliveryTime: {
            minHandlingDays: timing.handlingDays,
            maxHandlingDays: timing.handlingDays,
            minTransitDays: timing.transitDays,
            maxTransitDays: timing.transitDays,
            cutoffTime: { hour, minute, timeZone: catalogue.dispatch.timezone },
            handlingBusinessDayConfig: { businessDays: week },
            transitBusinessDayConfig: { businessDays: week },
          },
          rateGroups: timing.groups.map((group): MerchantRateGroup => ({
            applicableShippingLabels: group.labels,
            // A null price is a REFUSAL, never a free delivery. Sending
            // toAmountMicros(0) here would advertise the one thing this site
            // will not do as the cheapest thing it does.
            singleValue: group.price === null
              ? { noShipping: true }
              : { flatRate: { amountMicros: toAmountMicros(group.price), currencyCode: input.currency } },
          })),
        },
      })
    }

    // One bad speed takes the whole service with it. Sending the rest would
    // leave the groups it covered falling through to another speed's catch-all
    // or off Google altogether, which is a wrong price rather than a missing
    // one.
    if (refusal !== null) {
      notes.push({ severity: 'blocking', service: draft.sourceLabel, message: refusal })
      continue
    }
    services.push(...built)
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
