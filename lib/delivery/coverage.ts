// How many of your products a push would actually cover - and, more to the
// point, how many it would NOT.
//
// This exists because "a product in no delivery group falls into Merchant
// Center's everything-else rate group" is only true when there IS an
// everything-else rate group, and on a shop whose delivery rules are all
// written against product ranges there is not one. Such a product then gets no
// delivery price from any service at all, which Google does not treat as a
// fallback: it treats it as a product it cannot show.
//
// So the preview has to put a number on it before anybody presses Send. A
// warning that says "some products may not be covered" is not a warning, it is
// a shrug. "1,900 of your 23,000 products would go to Google with no delivery
// price" is something an owner can act on.
//
// The population counted is every ACTIVE, PHYSICAL product the shop holds,
// which is the set the delivery module can answer for. That is a DIFFERENT set
// from the feed's rather than a larger one, and the tab says so: a feed rule or
// a missing photograph keeps some products back, while a listing with
// variations sends one row per variation and so contributes more rows than the
// one product counted here. Which way the two differ depends on the shop. The
// figures are a measure of the shop's delivery rules, not a tally of the feed.
import { prisma } from '@/lib/db/prisma'
import { getProductDeliveryScopes } from '@/modules/google-shopping-for-shop/lib/delivery/catalogue'
import type { DeliveryLabelMap } from '@/modules/google-shopping-for-shop/lib/delivery/labels'
import type { MappedService } from '@/modules/google-shopping-for-shop/lib/delivery/mapping'

export type ServiceCoverage = {
  serviceName: string
  /** Products whose label this service names no rate group for, and which it
   *  has no catch-all to fall back on. They get no price from this service. */
  uncovered: number
}

/** Products whose delivery group was a coin toss, and the services it could
 *  show up on. */
export type DoubleTaggedCoverage = {
  /** Products that matched more than one group of the same specificity - in
   *  practice, a listing tagged with two product ranges. */
  products: number
  /** Services that price one of the OTHER groups such a product matched, so
   *  the shop could charge one and Google the other. */
  services: string[]
  /** One of them, by name, so the owner has somewhere to start looking. */
  exampleGroups: string[]
}

export type DeliveryCoverage = {
  /** Products considered. */
  products: number
  /** Products in no delivery group at all, so they carry no shipping label. */
  unlabelled: number
  /** True when at least one service has no catch-all rate group, which is what
   *  makes `unlabelled` and `uncovered` matter rather than being a footnote. */
  anyServiceWithoutCatchAll: boolean
  services: ServiceCoverage[]
  /** Null where no product is double-tagged at all, which is the ordinary
   *  case and the one that should say nothing. */
  doubleTagged: DoubleTaggedCoverage | null
}

/** How many products go to the delivery module at a time. It binds one
 *  parameter per id, against Postgres's ceiling of 65,535 per statement, and a
 *  variant child drags its parent in beside it. */
const CHUNK = 10_000

async function activeProductIds(): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "shp_products"
    WHERE "status" = 'ACTIVE' AND "type" = 'PHYSICAL'
  `
  return rows.map((row) => row.id)
}

/**
 * Counts what a push would leave without a delivery price.
 *
 * One pass over the catalogue's products, resolving each to its delivery group
 * exactly as the feed labels it, then asking each mapped service whether it has
 * anything to say about that group.
 */
export async function measureDeliveryCoverage(
  services: MappedService[],
  labels: DeliveryLabelMap,
  /** Whether the FEED actually labels its items with these delivery groups.
   *
   *  False is not a detail - it is the whole answer. The rate groups are
   *  matched to products by the label the FEED sends, so when the feed is
   *  labelling by something else (or not at all) no product carries any of
   *  these names, and counting them against the groups they would fall in if
   *  it did would report a healthy catalogue that is about to be mispriced
   *  from top to bottom. */
  labelsFromDeliveryScopes: boolean,
): Promise<DeliveryCoverage> {
  const ids = await activeProductIds()

  // What each service can actually price: the labels it names, and whether it
  // has a catch-all to sweep up everything else.
  const reach = services.map((service) => ({
    serviceName: service.serviceName,
    named: new Set(service.groups.flatMap((group) => group.labels)),
    hasCatchAll: service.groups.some((group) => group.catchAll),
    uncovered: 0,
  }))

  let unlabelled = 0
  // The double-tagged tally. A product that matched two groups of the same
  // specificity is labelled with one of them, while a service resolves its own
  // price by a different tie-break and can land on the other - so the shop
  // charges one and Google the other. It is only a real exposure where some
  // service actually prices one of the OTHER groups, which is what is counted
  // here rather than the mere possibility of it.
  let doubleTaggedProducts = 0
  const doubleTaggedServices = new Set<string>()
  const doubleTaggedGroups = new Set<string>()

  for (let start = 0; start < ids.length; start += CHUNK) {
    const slice = ids.slice(start, start + CHUNK)
    const scopes = await getProductDeliveryScopes(slice)
    for (const id of slice) {
      const answer = scopes.get(id)
      // The label the FEED will send, not the group the product falls in. With
      // the feed labelling some other way the two are not the same thing, and
      // the only honest answer is that this product carries none of these
      // names.
      const label = labelsFromDeliveryScopes && answer ? labels.byScopeId.get(answer.scopeId) : undefined
      if (!label) {
        unlabelled += 1
        // No label at all: only a catch-all can price it.
        for (const service of reach) if (!service.hasCatchAll) service.uncovered += 1
        continue
      }
      for (const service of reach) {
        if (service.named.has(label)) continue
        if (!service.hasCatchAll) service.uncovered += 1
      }

      if (!labelsFromDeliveryScopes || !answer || answer.tiedWith.length === 0) continue
      const tiedLabels = answer.tiedWith
        .map((scopeId) => labels.byScopeId.get(scopeId))
        .filter((tied): tied is string => tied !== undefined && tied !== label)
      if (tiedLabels.length === 0) continue
      const atRisk = reach.filter((service) => tiedLabels.some((tied) => service.named.has(tied)))
      if (atRisk.length === 0) continue
      doubleTaggedProducts += 1
      for (const service of atRisk) doubleTaggedServices.add(service.serviceName)
      if (doubleTaggedGroups.size < 4) {
        doubleTaggedGroups.add(label)
        for (const tied of tiedLabels) if (doubleTaggedGroups.size < 4) doubleTaggedGroups.add(tied)
      }
    }
  }

  return {
    products: ids.length,
    unlabelled,
    anyServiceWithoutCatchAll: reach.some((service) => !service.hasCatchAll),
    services: reach.map((service) => ({ serviceName: service.serviceName, uncovered: service.uncovered })),
    doubleTagged: doubleTaggedProducts === 0 ? null : {
      products: doubleTaggedProducts,
      services: [...doubleTaggedServices].sort((a, b) => a.localeCompare(b, 'en-GB')),
      exampleGroups: [...doubleTaggedGroups],
    },
  }
}

/** The sentences the preview shows. Separate from the measuring so the wording
 *  can be read without a database anywhere near it. */
export function coverageNotes(coverage: DeliveryCoverage): Array<{ severity: 'info' | 'warning'; message: string }> {
  const notes: Array<{ severity: 'info' | 'warning'; message: string }> = []
  const count = (value: number) => value.toLocaleString('en-GB')

  const worst = [...coverage.services].sort((a, b) => b.uncovered - a.uncovered)[0]
  if (worst && worst.uncovered > 0) {
    notes.push({
      severity: 'warning',
      message: `Not every product would get a delivery price. "${worst.serviceName}" would leave ${count(worst.uncovered)} of your `
        + `${count(coverage.products)} active products without one, because it has no rule covering everything and their group is not `
        + 'among its prices. Google does not quietly fall back for those - a product with no delivery price at all is one it will '
        + 'stop showing. Give the service a rule covering everything, or a price for those groups.',
    })
  }

  if (coverage.unlabelled > 0) {
    notes.push({
      severity: coverage.anyServiceWithoutCatchAll ? 'warning' : 'info',
      message: `${count(coverage.unlabelled)} of your ${count(coverage.products)} active products are in no delivery group at all, so `
        + 'they go to Google with no delivery label.'
        + (coverage.anyServiceWithoutCatchAll
          ? ' With no rule covering everything, they get no delivery price from those services.'
          : ' Your rule covering everything prices them, which is what it is for.'),
    })
  }

  // Only where a product REALLY is in two groups at once and some service
  // prices the other one. Firing on the mere possibility - "this service
  // prices two ranges" - put a permanent caveat in front of every owner whose
  // shop prices delivery by range, which is all of them, and a permanent note
  // is wallpaper.
  if (coverage.doubleTagged) {
    const { products, services, exampleGroups } = coverage.doubleTagged
    notes.push({
      severity: 'warning',
      message: `${count(products)} of your products are in more than one delivery group at once, and could be charged one group's `
        + 'delivery price here and another\'s on Google. Put each of them in a single group and it goes away. '
        + `Groups involved: ${exampleGroups.join(', ')}. Services it could show up on: ${services.join(', ')}.`,
    })
  }

  if (notes.length > 0) {
    notes.push({
      severity: 'info',
      message: 'These counts are of every active product on the site, which is a different set from what the feed sends rather than '
        + 'a bigger or a smaller one: a feed rule or a missing photograph keeps some products back, while a listing with variations '
        + 'goes to Google as one row per variation. Read them as a measure of your delivery rules rather than an exact tally of the '
        + 'feed.',
    })
  }

  return notes
}
