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

  // Merchant Center holds one delivery time per service. Quoting the fastest
  // would have the shop promising dates it cannot keep.
  it('sends the slowest timing when groups differ, and names the ones affected', () => {
    const cat = catalogue(
      [scope('range:a', 'Orion'), scope('range:b', 'Vega')],
      [service('Standard', [
        rate('range:a', 10, { transitDays: 2 }),
        rate('range:b', 10, { transitDays: 9 }),
      ])],
    )
    const { services, notes } = map(cat)
    expect(services[0]?.transitDays).toBe(9)
    expect(services[0]?.payload.deliveryTime?.minTransitDays).toBe(9)
    expect(services[0]?.payload.deliveryTime?.maxTransitDays).toBe(9)
    const warning = notes.find((note) => note.severity === 'warning' && note.service === 'Standard')
    expect(warning?.message).toContain('Orion')
    expect(warning?.message).not.toContain('Vega')
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
