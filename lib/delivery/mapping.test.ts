import { describe, it, expect } from 'vitest'
import { deliveryCounts, mapDeliveryCatalogue, type MappingInput } from '@/modules/google-shopping-for-shop/lib/delivery/mapping'
import { assignDeliveryLabels } from '@/modules/google-shopping-for-shop/lib/delivery/labels'
import { MAX_LABELS_PER_RATE_GROUP } from '@/modules/google-shopping-for-shop/lib/delivery/merchant-types'
import type {
  DeliveryCatalogue,
  DeliveryScope,
  DeliveryScopeRate,
  DeliveryServiceEntry,
} from '@/modules/google-shopping-for-shop/lib/delivery/catalogue'

function scope(id: string, label: string, kind: DeliveryScope['kind'] = 'RANGE'): DeliveryScope {
  return { id, kind, ref: kind === 'DEFAULT' ? null : id, label }
}

function rate(scopeId: string, price: number, extra: Partial<DeliveryScopeRate> = {}): DeliveryScopeRate {
  return { scopeId, available: true, price, transitDays: 2, minLeadDays: null, ...extra }
}

function service(label: string, rates: DeliveryScopeRate[], extra: Partial<DeliveryServiceEntry> = {}): DeliveryServiceEntry {
  return {
    key: label.toLowerCase().replace(/\s+/g, '-'),
    label,
    description: null,
    position: 0,
    transitDays: 2,
    minLeadDays: null,
    rates,
    isDefault: false,
    ...extra,
  }
}

function catalogue(scopes: DeliveryScope[], services: DeliveryServiceEntry[], extra: Partial<DeliveryCatalogue> = {}): DeliveryCatalogue {
  return {
    scopeOrder: ['RANGE', 'CATEGORY', 'SUPPLIER', 'DEFAULT'],
    pricing: 'per-unit',
    scopes,
    services,
    dispatch: { cutoffTime: '14:30', timezone: 'Europe/London', shipDays: [1, 2, 3, 4, 5], dispatchLeadDays: 1 },
    holidays: [],
    ...extra,
  }
}

function map(cat: DeliveryCatalogue, overrides: Partial<MappingInput> = {}) {
  return mapDeliveryCatalogue({
    catalogue: cat,
    labels: assignDeliveryLabels(cat.scopes),
    country: 'GB',
    currency: 'GBP',
    grossUp: (net) => net,
    // The cases below are about the mapping itself, so they assume the feed IS
    // labelling by delivery group. The cases that assume otherwise say so.
    labelsFromDeliveryScopes: true,
    perItemShippingOn: false,
    ...overrides,
  })
}

describe('deliveryCounts', () => {
  it('is dispatch lead plus the service transit', () => {
    expect(deliveryCounts(1, 3, null)).toEqual({ handlingDays: 1, transitDays: 3 })
  })

  // The floor goes into HANDLING, not transit: the parcel is on the road for
  // its usual time, it is simply not picked up for a while.
  it('folds a minimum lead into the handling side', () => {
    expect(deliveryCounts(1, 2, 10)).toEqual({ handlingDays: 8, transitDays: 2 })
  })

  it('leaves a floor shorter than the journey alone', () => {
    expect(deliveryCounts(2, 3, 4)).toEqual({ handlingDays: 2, transitDays: 3 })
  })

  it('never returns a negative count', () => {
    expect(deliveryCounts(-1, -2, null)).toEqual({ handlingDays: 0, transitDays: 0 })
  })
})

describe('mapDeliveryCatalogue', () => {
  it('makes one rate group per price and lists the labels that share it', () => {
    const cat = catalogue(
      [scope('range:a', 'Orion'), scope('range:b', 'Vega'), scope('range:c', 'Lyra')],
      [service('Standard', [rate('range:a', 9.99), rate('range:b', 9.99), rate('range:c', 24.5)])],
    )
    const { services } = map(cat)
    expect(services).toHaveLength(1)
    expect(services[0]?.groups).toEqual([
      { price: 9.99, labels: ['Orion', 'Vega'], catchAll: false },
      { price: 24.5, labels: ['Lyra'], catchAll: false },
    ])
    expect(services[0]?.payload.rateGroups?.[0]?.singleValue?.flatRate)
      .toEqual({ amountMicros: '9990000', currencyCode: 'GBP' })
  })

  it('sends the "everything" rule as the last group, with no labels', () => {
    const cat = catalogue(
      [scope('range:a', 'Orion'), scope('default', 'Everything', 'DEFAULT')],
      [service('Standard', [rate('range:a', 9.99), rate('default', 4.95)])],
    )
    const groups = map(cat).services[0]?.groups ?? []
    expect(groups.at(-1)).toEqual({ price: 4.95, labels: [], catchAll: true })
    // Google allows an empty label list ONLY on the last group of a service.
    expect(groups.slice(0, -1).every((group) => group.labels.length > 0)).toBe(true)
  })

  it('gives the shop\'s default service a free catch-all even with no rule for it', () => {
    const cat = catalogue(
      [scope('range:a', 'Orion')],
      [service('Included delivery', [], { isDefault: true })],
    )
    expect(map(cat).services[0]?.groups).toEqual([{ price: 0, labels: [], catchAll: true }])
  })

  it('leaves out a service nothing is offered, and says so', () => {
    const { services, notes } = map(catalogue([scope('range:a', 'Orion')], [service('Installation', [])]))
    expect(services).toHaveLength(0)
    expect(notes.some((note) => note.severity === 'info' && note.message.includes('not offered to anything'))).toBe(true)
  })

  // THE one that matters. Dropping a refused group used to leave its label
  // matching no rate group, so the product fell into the catch-all and Google
  // went on charging for a service this site refuses it.
  it('tells Google outright that a refused group cannot be delivered', () => {
    const cat = catalogue(
      [scope('range:a', 'Orion'), scope('range:b', 'Vega')],
      [service('Next day', [rate('range:a', 12), rate('range:b', 12, { available: false })])],
    )
    const { services } = map(cat)
    expect(services[0]?.groups).toEqual([
      { price: 12, labels: ['Orion'], catchAll: false },
      { price: null, labels: ['Vega'], catchAll: false },
    ])
    expect(services[0]?.payload.rateGroups?.[1]).toEqual({
      applicableShippingLabels: ['Vega'],
      singleValue: { noShipping: true },
    })
  })

  // The dangerous combination: a refusal AND a catch-all in the same service.
  // The refusal must come FIRST, or the catch-all sweeps it up and charges it.
  it('puts the refusal before the catch-all, never after it', () => {
    const cat = catalogue(
      [scope('range:a', 'Orion'), scope('range:b', 'Vega'), scope('default', 'Everything', 'DEFAULT')],
      [service('Next day', [
        rate('range:a', 12),
        rate('range:b', 12, { available: false }),
        rate('default', 4.95),
      ])],
    )
    const groups = map(cat).services[0]?.groups ?? []
    expect(groups).toEqual([
      { price: 12, labels: ['Orion'], catchAll: false },
      { price: null, labels: ['Vega'], catchAll: false },
      { price: 4.95, labels: [], catchAll: true },
    ])
    const refusalAt = groups.findIndex((group) => group.price === null)
    const catchAllAt = groups.findIndex((group) => group.catchAll)
    expect(refusalAt).toBeLessThan(catchAllAt)
  })

  it('never renders a refusal as a free delivery', () => {
    const cat = catalogue(
      [scope('range:a', 'Orion')],
      [service('Next day', [rate('range:a', 12, { available: false })], { isDefault: true })],
    )
    const rateGroups = map(cat).services[0]?.payload.rateGroups ?? []
    const refusal = rateGroups.find((group) => group.applicableShippingLabels.includes('Orion'))
    expect(refusal?.singleValue).toEqual({ noShipping: true })
    expect(refusal?.singleValue?.flatRate).toBeUndefined()
  })

  // "Orion can have it, nothing else can." The catch-all has to carry the
  // refusal, or everything outside Orion is quoted the service anyway.
  it('carries a refused "everything" rule into the catch-all as a refusal', () => {
    const cat = catalogue(
      [scope('range:a', 'Orion'), scope('default', 'Everything', 'DEFAULT')],
      [service('Next day', [rate('range:a', 12), rate('default', 0, { available: false })])],
    )
    const groups = map(cat).services[0]?.groups ?? []
    expect(groups).toEqual([
      { price: 12, labels: ['Orion'], catchAll: false },
      { price: null, labels: [], catchAll: true },
    ])
    expect(map(cat).services[0]?.payload.rateGroups?.at(-1)).toEqual({
      applicableShippingLabels: [],
      singleValue: { noShipping: true },
    })
  })

  it('leaves out a service refused to everything', () => {
    const cat = catalogue(
      [scope('range:a', 'Orion')],
      [service('Next day', [rate('range:a', 12, { available: false })])],
    )
    expect(map(cat).services).toHaveLength(0)
  })

  it('does not let a refused group slow the delivery time down', () => {
    const cat = catalogue(
      [scope('range:a', 'Orion'), scope('range:b', 'Vega')],
      [service('Standard', [
        rate('range:a', 10, { transitDays: 2 }),
        rate('range:b', 10, { transitDays: 40, available: false }),
      ])],
    )
    expect(map(cat).services[0]?.transitDays).toBe(2)
  })

  // ---- One label per product cannot carry per-service resolution ------------
  // The shop resolves a price per service; the feed gives a product one label.
  // Where a service could fall through to a coarser rule of its own, the label
  // cannot say which price applies, so the service is not sent at all.
  it('blocks a service that could fall through to a rule of a different sort', () => {
    const cat = catalogue(
      [scope('range:a', 'Orion'), scope('category:c', 'Office chairs', 'CATEGORY'), scope('default', 'Everything', 'DEFAULT')],
      [
        service('Standard', [rate('range:a', 9.99), rate('default', 4.95)]),
        // Nothing for range:a - a product in Orion would take the category
        // price here, while its label says Orion.
        service('Next day', [rate('category:c', 19.99), rate('default', 14.95)]),
      ],
    )
    const { services, notes, blocked } = map(cat)
    expect(blocked).toBe(true)
    expect(services.map((service) => service.serviceName)).toEqual(['Standard'])
    const blocker = notes.find((note) => note.severity === 'blocking')
    expect(blocker?.service).toBe('Next day')
    expect(blocker?.message).toContain('Orion')
  })

  it('does not block where every rule of a service is written against the same sort of thing', () => {
    const cat = catalogue(
      [scope('range:a', 'Orion'), scope('range:b', 'Vega')],
      [service('Standard', [rate('range:a', 9.99)]), service('Next day', [rate('range:b', 14.99)])],
    )
    expect(map(cat).blocked).toBe(false)
  })

  // The commonest correct shape there is, and it must not be blocked: a rule
  // per range plus one covering everything. The catch-all IS the fall-through,
  // and it charges exactly what the shop charges.
  it('does not block ranges plus a rule covering everything', () => {
    const cat = catalogue(
      [scope('range:a', 'Orion'), scope('range:b', 'Vega'), scope('default', 'Everything', 'DEFAULT')],
      [service('Standard', [rate('range:a', 9.99), rate('default', 4.95)])],
    )
    expect(map(cat).blocked).toBe(false)
  })

  it('blocks two category rules that could both match one product', () => {
    const cat = catalogue(
      [scope('category:child', 'Office chairs', 'CATEGORY'), scope('category:parent', 'Seating', 'CATEGORY')],
      [service('Standard', [rate('category:parent', 9.99)])],
    )
    expect(map(cat).blocked).toBe(true)
  })

  // Both wrong-price cases now stop a send. Before, one blocked and the other
  // warned, so half of the same failure went through.
  it('blocks a group with a price but no name Google can match, like the other wrong price', () => {
    const cat = catalogue(
      [scope('range:a', 'Orion'), scope('range:b', '   ')],
      [service('Standard', [rate('range:a', 9.99), rate('range:b', 24.99)])],
    )
    const { services, notes, blocked } = map(cat)
    expect(blocked).toBe(true)
    expect(services).toHaveLength(0)
    const blocker = notes.find((note) => note.severity === 'blocking')
    expect(blocker?.service).toBe('Standard')
    expect(blocker?.message).toContain('no name Google can match against')
    expect(blocker?.message).toContain('Nothing has been sent for this service')
  })

  it('does not block one supplier rule against another - a product has one supplier', () => {
    const cat = catalogue(
      [scope('supplier:A', 'Furdeco', 'SUPPLIER'), scope('supplier:B', 'Multidrop', 'SUPPLIER')],
      [service('Standard', [rate('supplier:A', 9.99)])],
    )
    expect(map(cat).blocked).toBe(false)
  })

  // Merchant Center holds one delivery time per service, and this site can vary
  // it per group. Sending the slowest - which is what this did until a shop
  // with twenty-five groups at five days and one at fourteen found every
  // product quoted at fourteen - is now the fallback rather than the rule.
  it('sends a service per distinct delivery time rather than the slowest of them', () => {
    const cat = catalogue(
      [scope('range:a', 'Orion'), scope('range:b', 'Vega')],
      [service('Standard', [
        rate('range:a', 10, { transitDays: 2 }),
        rate('range:b', 10, { transitDays: 9 }),
      ])],
    )
    const { services, blocked } = map(cat)
    expect(blocked).toBe(false)
    expect(services.map((entry) => entry.transitDays).sort((a, b) => a - b)).toEqual([2, 9])
    for (const entry of services) {
      expect(entry.payload.deliveryTime?.minTransitDays).toBe(entry.transitDays)
      expect(entry.payload.deliveryTime?.maxTransitDays).toBe(entry.transitDays)
    }
    // Neither is quoted at the other's speed any more, so nothing warns.
    expect(services.some((entry) => entry.transitDays === 9 && entry.groups.some((group) => group.labels.includes('Orion')
      && group.price !== null))).toBe(false)
  })

  it('does not let a service\'s own timing slow down groups that all override it', () => {
    const cat = catalogue(
      [scope('range:a', 'Orion')],
      [service('Standard', [rate('range:a', 10, { transitDays: 1 })], { transitDays: 14 })],
    )
    expect(map(cat).services[0]?.transitDays).toBe(1)
  })

  it('carries the cut-off and the shop\'s working week across', () => {
    const cat = catalogue([scope('default', 'Everything', 'DEFAULT')], [service('Standard', [rate('default', 5)])])
    const time = map(cat).services[0]?.payload.deliveryTime
    expect(time?.cutoffTime).toEqual({ hour: 14, minute: 30, timeZone: 'Europe/London' })
    expect(time?.handlingBusinessDayConfig?.businessDays).toEqual(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'])
    expect(time?.transitBusinessDayConfig?.businessDays).toEqual(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'])
  })

  it('grosses the prices up exactly as the caller says', () => {
    const cat = catalogue([scope('range:a', 'Orion')], [service('Standard', [rate('range:a', 10)])])
    const { services } = map(cat, { grossUp: (net) => Math.round(net * 1.2 * 100) / 100 })
    expect(services[0]?.groups[0]?.price).toBe(12)
    expect(services[0]?.payload.rateGroups?.[0]?.singleValue?.flatRate?.amountMicros).toBe('12000000')
  })

  it('splits a price shared by more groups than Google allows in one, rather than dropping any', () => {
    const many = Array.from({ length: MAX_LABELS_PER_RATE_GROUP + 5 }, (_, index) => scope(`range:${index}`, `Range ${index}`))
    const cat = catalogue(many, [service('Standard', many.map((one) => rate(one.id, 7.5)))])
    const groups = map(cat).services[0]?.groups ?? []
    expect(groups).toHaveLength(2)
    expect(groups.every((group) => group.labels.length <= MAX_LABELS_PER_RATE_GROUP)).toBe(true)
    expect(groups.flatMap((group) => group.labels)).toHaveLength(many.length)
    expect(groups.every((group) => group.price === 7.5)).toBe(true)
  })

  // Trimming to fit would charge those products a price nobody set. Better to
  // send nothing for that service and say why.
  it('blocks a service needing more prices than Google allows', () => {
    const many = Array.from({ length: 25 }, (_, index) => scope(`range:${index}`, `Range ${index}`))
    const cat = catalogue(many, [service('Standard', many.map((one, index) => rate(one.id, index + 1)))])
    const { services, notes, blocked } = map(cat)
    expect(services).toHaveLength(0)
    expect(blocked).toBe(true)
    expect(notes.some((note) => note.severity === 'blocking' && note.message.includes('25 different prices'))).toBe(true)
  })

  it('blocks rather than sending an empty list that would wipe Merchant Center', () => {
    const { blocked, notes } = map(catalogue([], []))
    expect(blocked).toBe(true)
    expect(notes.some((note) => note.message.includes('left exactly as they are'))).toBe(true)
  })

  // The finding that would have mispriced a whole catalogue on a DEFAULT
  // install: the rate groups are matched to products by the label the FEED
  // sends, and the feed only sends these group names when the owner has asked
  // it to. Sending them otherwise names labels nothing carries.
  it('blocks entirely when the feed is not labelling items by delivery group', () => {
    const cat = catalogue(
      [scope('range:a', 'Orion'), scope('default', 'Everything', 'DEFAULT')],
      [service('Standard', [rate('range:a', 9.99), rate('default', 4.95)])],
    )
    const { blocked, notes, services } = map(cat, { labelsFromDeliveryScopes: false })
    expect(blocked).toBe(true)
    const blocker = notes.find((note) => note.severity === 'blocking')
    expect(blocker?.service).toBeNull()
    expect(blocker?.message).toContain('Where the group comes from')
    expect(blocker?.message).toContain('Your own delivery rules')
    // The preview still SHOWS what would be sent - the owner needs to see it to
    // judge the setting - it simply cannot be sent.
    expect(services.length).toBeGreaterThan(0)
  })

  it('does not block when the feed is labelling by delivery group', () => {
    const cat = catalogue([scope('default', 'Everything', 'DEFAULT')], [service('Standard', [rate('default', 5)])])
    expect(map(cat, { labelsFromDeliveryScopes: true }).blocked).toBe(false)
  })

  // Both on is legal and quietly self-cancelling: Google prefers the per-item
  // figure, so these account rates would be overruled for everything in the
  // feed while the comparison went on reading "Matches".
  it('warns when each item is also being sent its own delivery prices', () => {
    const cat = catalogue([scope('default', 'Everything', 'DEFAULT')], [service('Standard', [rate('default', 5)])])
    const { notes, blocked } = map(cat, { perItemShippingOn: true })
    expect(blocked).toBe(false)
    const warning = notes.find((note) => note.message.includes('per-product figure ahead'))
    expect(warning?.severity).toBe('warning')
  })

  it('says nothing about per-item prices when that switch is off', () => {
    const cat = catalogue([scope('default', 'Everything', 'DEFAULT')], [service('Standard', [rate('default', 5)])])
    expect(map(cat).notes.some((note) => note.message.includes('per-product figure ahead'))).toBe(false)
  })

  it('says out loud that a per-unit charge does not fit one figure per product', () => {
    const cat = catalogue([scope('default', 'Everything', 'DEFAULT')], [service('Standard', [rate('default', 5)])])
    const note = map(cat).notes.find((entry) => entry.service === null && entry.message.includes('every item'))
    expect(note?.severity).toBe('warning')
    expect(note?.message).toContain('cost more')
  })

  it('says the holidays cannot be carried across', () => {
    const cat = catalogue(
      [scope('default', 'Everything', 'DEFAULT')],
      [service('Standard', [rate('default', 5)])],
      { holidays: [{ date: '2026-12-25', name: 'Christmas Day' }] },
    )
    expect(map(cat).notes.some((note) => note.message.includes('bank holidays'))).toBe(true)
  })

  it('warns when a group outside every rule gets no price on a service', () => {
    const cat = catalogue([scope('range:a', 'Orion')], [service('Standard', [rate('range:a', 9)])])
    expect(map(cat).notes.some((note) => note.message.includes('no rule covering everything'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// One service per delivery time
// ---------------------------------------------------------------------------
//
// Google holds one delivery time per service and this site varies it per group.
// Sending the slowest quoted a whole catalogue at its worst case - twenty-five
// groups at five days and one at fourteen meant everything read fourteen - so a
// service that delivers at several speeds now goes as several services.
describe('mapDeliveryCatalogue, splitting by delivery time', () => {
  it('splits one service into one per distinct timing, with the right prices in each', () => {
    const cat = catalogue(
      [scope('range:a', 'Orion'), scope('range:b', 'Vega'), scope('default', 'Everything', 'DEFAULT')],
      [service('Flat-Pack', [
        rate('range:a', 10, { transitDays: 5 }),
        rate('range:b', 20, { transitDays: 14 }),
        rate('default', 30, { transitDays: 5 }),
      ])],
    )
    const { services, blocked } = map(cat)
    expect(blocked).toBe(false)
    expect(services.map((entry) => entry.serviceName)).toEqual(['Flat-Pack', 'Flat-Pack - 14 days'])

    const quick = services[0]
    expect(quick?.transitDays).toBe(5)
    expect(quick?.groups).toEqual([
      { price: 10, labels: ['Orion'], catchAll: false },
      // Vega delivers at the other speed, so it is refused HERE rather than
      // left to fall through to the catch-all below at the wrong price and the
      // wrong time. That fall-through is the whole hazard of splitting.
      { price: null, labels: ['Vega'], catchAll: false },
      { price: 30, labels: [], catchAll: true },
    ])

    const slow = services[1]
    expect(slow?.transitDays).toBe(14)
    expect(slow?.groups).toEqual([{ price: 20, labels: ['Vega'], catchAll: false }])
    // No catch-all on the second one: a product outside its group is not
    // delivered at fourteen days, it is delivered at five by the first.
    expect(slow?.groups.some((group) => group.catchAll)).toBe(false)
  })

  it('gives the plain name to the timing that covers the most groups, not the quickest', () => {
    const cat = catalogue(
      [scope('range:a', 'Orion'), scope('range:b', 'Vega'), scope('range:c', 'Lyra')],
      [service('Installation', [
        rate('range:a', 10, { transitDays: 10 }),
        rate('range:b', 10, { transitDays: 10 }),
        rate('range:c', 10, { transitDays: 24 }),
      ])],
    )
    const { services } = map(cat)
    expect(services.map((entry) => entry.serviceName)).toEqual(['Installation', 'Installation - 24 days'])
    expect(services[0]?.transitDays).toBe(10)
    expect(services[1]?.transitDays).toBe(24)
  })

  it('leaves a service that delivers at one speed exactly as it was', () => {
    const cat = catalogue(
      [scope('range:a', 'Orion'), scope('default', 'Everything', 'DEFAULT')],
      [service('Standard', [rate('range:a', 10), rate('default', 5)])],
    )
    const { services, notes } = map(cat)
    expect(services).toHaveLength(1)
    expect(services[0]?.serviceName).toBe('Standard')
    expect(services[0]?.groups).toEqual([
      { price: 10, labels: ['Orion'], catchAll: false },
      { price: 5, labels: [], catchAll: true },
    ])
    expect(notes.some((note) => note.message.includes('one per length of time'))).toBe(false)
  })

  it('keeps every name inside Google\'s 50 characters and unique', () => {
    // The shop's longest service name is 34 characters, so it is the timing
    // suffix that takes one past the limit rather than the name itself.
    const label = 'Made To Order and Delivered on Wooden Pallets'
    const cat = catalogue(
      [scope('range:a', 'Orion'), scope('range:b', 'Vega')],
      [service(label, [
        rate('range:a', 10, { transitDays: 5 }),
        rate('range:b', 20, { transitDays: 14 }),
      ])],
    )
    const { services, blocked } = map(cat)
    expect(blocked).toBe(false)
    expect(services).toHaveLength(2)
    const names = services.map((entry) => entry.serviceName)
    expect(names[0]).toBe(label)
    for (const name of names) expect(name.length).toBeLessThanOrEqual(50)
    expect(new Set(names).size).toBe(2)
  })

  it('names the same catalogue the same way twice running', () => {
    const build = (): DeliveryCatalogue => catalogue(
      [scope('range:a', 'Orion'), scope('range:b', 'Vega'), scope('range:c', 'Lyra')],
      [
        service('Flat-Pack', [rate('range:a', 10, { transitDays: 5 }), rate('range:b', 20, { transitDays: 14 })]),
        service('Installation', [rate('range:c', 30, { transitDays: 10 })]),
      ],
    )
    const first = map(build()).services.map((entry) => entry.serviceName)
    const second = map(build()).services.map((entry) => entry.serviceName)
    expect(first).toEqual(second)
  })

  // Two site services under one name is a state Merchant Center cannot hold -
  // it has no id for a service, the name IS the identity - so it refuses
  // rather than truncate into a duplicate.
  it('refuses a service it cannot give a name that fits and is unique', () => {
    const scopes = ['a', 'b', 'c', 'd', 'e'].map((suffix) => scope(`range:${suffix}`, `Range ${suffix.toUpperCase()}`))
    const cat = catalogue(
      scopes,
      ['a', 'b', 'c', 'd', 'e'].map((suffix) => service('Standard', [rate(`range:${suffix}`, 10)])),
    )
    const { blocked, notes } = map(cat)
    expect(blocked).toBe(true)
    expect(notes.some((note) => note.severity === 'blocking'
      && note.message.includes('could not be given a name Google would accept'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Google's cap of twenty services per country
// ---------------------------------------------------------------------------
//
// Splitting makes more services, and Google refuses the WHOLE payload above
// twenty - counting services this site does not manage, which every push copies
// back untouched. So the count is taken first, and where it will not fit the
// least costly splits are given up before the worst ones.
describe('mapDeliveryCatalogue, the cap on services per country', () => {
  function threeServices(): DeliveryCatalogue {
    return catalogue(
      [
        scope('range:a1', 'Alpha'), scope('range:a2', 'Beta'),
        scope('range:b1', 'Gamma'), scope('range:b2', 'Delta'),
        scope('range:c1', 'Epsilon'),
      ],
      [
        // Two speeds a day apart: giving this up costs almost nothing.
        service('Kerbside', [rate('range:a1', 10, { transitDays: 5 }), rate('range:a2', 10, { transitDays: 6 })]),
        // Two speeds nine days apart: this is where the lie is worst, so it is
        // the last thing collapsed.
        service('Installation', [rate('range:b1', 20, { transitDays: 5 }), rate('range:b2', 20, { transitDays: 14 })]),
        service('Standard', [rate('range:c1', 5, { transitDays: 3 })]),
      ],
    )
  }

  it('splits everything when there is room', () => {
    const { services, blocked } = map(threeServices(), { unmanagedServiceCount: 0 })
    expect(blocked).toBe(false)
    expect(services).toHaveLength(5)
  })

  it('collapses the service whose timings differ least first', () => {
    // Five of ours plus sixteen of somebody else's is twenty-one, one over.
    const { services, notes, blocked } = map(threeServices(), { unmanagedServiceCount: 16 })
    expect(blocked).toBe(false)
    expect(services).toHaveLength(4)

    const names = services.map((entry) => entry.serviceName)
    // Kerbside gave up its split - its two speeds are a day apart.
    expect(names.filter((name) => name.startsWith('Kerbside'))).toEqual(['Kerbside'])
    // Installation kept it - five days against fourteen is the one worth having.
    expect(names.filter((name) => name.startsWith('Installation'))).toHaveLength(2)

    const collapse = notes.find((note) => note.severity === 'warning' && note.message.includes('slowest speed'))
    expect(collapse?.message).toContain('Kerbside')
    expect(collapse?.message).not.toContain('Installation')

    // The collapsed one is quoted at its slowest and says so.
    const kerbside = services.find((entry) => entry.serviceName === 'Kerbside')
    expect(kerbside?.transitDays).toBe(6)
    const warned = notes.find((note) => note.service === 'Kerbside' && note.severity === 'warning')
    expect(warned?.message).toContain('Alpha')
  })

  it('refuses outright when even collapsing everything will not fit', () => {
    const { blocked, notes } = map(threeServices(), { unmanagedServiceCount: 20 })
    expect(blocked).toBe(true)
    const refusal = notes.find((note) => note.severity === 'blocking' && note.message.includes('This would leave'))
    expect(refusal?.message).toContain('23')
    expect(refusal?.message).toContain('20')
    expect(refusal?.message).toContain('Merchant Center')
  })
})
