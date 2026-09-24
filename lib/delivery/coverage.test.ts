import { describe, it, expect, vi } from 'vitest'
import type { DeliveryCoverage } from '@/modules/google-shopping-for-shop/lib/delivery/coverage'
import type { DeliveryLabelMap } from '@/modules/google-shopping-for-shop/lib/delivery/labels'
import type { MappedService } from '@/modules/google-shopping-for-shop/lib/delivery/mapping'

// measureDeliveryCoverage reaches two things: the shop's product ids, and the
// delivery module across the extension-point seam. Both are stubbed, but the
// seam is stubbed at the REGISTRY rather than at our own reader - so these
// cases run through the real reader and prove the tie survives the crossing.
const productIds = vi.hoisted(() => ({ value: [] as string[] }))
const answers = vi.hoisted(() => ({ value: new Map<string, unknown>() }))

vi.mock('@/lib/db/prisma', () => ({
  prisma: { $queryRaw: async () => productIds.value.map((id) => ({ id })) },
}))
vi.mock('@/lib/modules/extension-points.server', () => ({
  moduleServerExtensionPointComponents: {
    'shop.delivery-services-catalogue': {
      'advanced-shipping': {
        catalogue: async () => null,
        scopesForProducts: async () => answers.value,
      },
    },
  },
}))

const { coverageNotes, measureDeliveryCoverage } =
  await import('@/modules/google-shopping-for-shop/lib/delivery/coverage')

function coverage(overrides: Partial<DeliveryCoverage> = {}): DeliveryCoverage {
  return {
    products: 23_038,
    unlabelled: 0,
    anyServiceWithoutCatchAll: false,
    services: [],
    doubleTagged: null,
    ...overrides,
  }
}

/** A mapped service that names these labels, and optionally sweeps up the rest. */
function service(serviceName: string, labels: string[], catchAll = false): MappedService {
  const groups = labels.map((label) => ({ price: 9.99, labels: [label], catchAll: false }))
  if (catchAll) groups.push({ price: 4.95, labels: [], catchAll: true })
  return { serviceKey: serviceName.toLowerCase(), serviceName, handlingDays: 1, transitDays: 2, groups, payload: {} }
}

function labelMap(entries: Array<[string, string]>): DeliveryLabelMap {
  return { byScopeId: new Map(entries), qualified: [] }
}

// ---------------------------------------------------------------------------
// The narrowing that makes the double-tag warning fire on the FACT
// ---------------------------------------------------------------------------

describe('measureDeliveryCoverage: products in two groups at once', () => {
  const labels = labelMap([['range:a', 'Orion'], ['range:b', 'Vega'], ['range:c', 'Lyra']])

  it('warns when a service prices the OTHER group the product also matched', async () => {
    productIds.value = ['p1']
    answers.value = new Map([['p1', { scopeId: 'range:a', tiedWith: ['range:b'] }]])
    // Standard prices BOTH, so it could settle on Vega while the label says Orion.
    const result = await measureDeliveryCoverage([service('Standard', ['Orion', 'Vega'], true)], labels, true)
    expect(result.doubleTagged).toEqual({
      products: 1,
      services: ['Standard'],
      exampleGroups: ['Orion', 'Vega'],
    })
  })

  // THE narrowing. A tie is only an exposure where some service prices the
  // other side of it; otherwise there is nothing for the shop to disagree with
  // Google about, and warning would be noise.
  it('stays silent when no service names the other group', async () => {
    productIds.value = ['p1']
    answers.value = new Map([['p1', { scopeId: 'range:a', tiedWith: ['range:b'] }]])
    // Standard prices Orion and Lyra - nothing prices Vega, so the tie is inert.
    const result = await measureDeliveryCoverage([service('Standard', ['Orion', 'Lyra'], true)], labels, true)
    expect(result.doubleTagged).toBeNull()
  })

  it('stays silent for the ordinary product with no tie at all', async () => {
    productIds.value = ['p1']
    answers.value = new Map([['p1', { scopeId: 'range:a', tiedWith: [] }]])
    expect((await measureDeliveryCoverage([service('Standard', ['Orion', 'Vega'], true)], labels, true)).doubleTagged).toBeNull()
  })

  it('ignores a tie whose other group has no name Google could match', async () => {
    productIds.value = ['p1']
    answers.value = new Map([['p1', { scopeId: 'range:a', tiedWith: ['range:unnamed'] }]])
    expect((await measureDeliveryCoverage([service('Standard', ['Orion'], true)], labels, true)).doubleTagged).toBeNull()
  })

  it('counts the products and gathers every service the tie could show up on', async () => {
    productIds.value = ['p1', 'p2', 'p3']
    answers.value = new Map([
      ['p1', { scopeId: 'range:a', tiedWith: ['range:b'] }],
      ['p2', { scopeId: 'range:a', tiedWith: ['range:b'] }],
      // No tie: must not be counted.
      ['p3', { scopeId: 'range:a', tiedWith: [] }],
    ])
    const result = await measureDeliveryCoverage(
      [service('Standard', ['Orion', 'Vega'], true), service('Express', ['Orion', 'Vega'], true), service('Pallet', ['Orion'], true)],
      labels,
      true,
    )
    expect(result.doubleTagged?.products).toBe(2)
    // Pallet prices only Orion, so it can never settle on Vega.
    expect(result.doubleTagged?.services).toEqual(['Express', 'Standard'])
  })
})

// ---------------------------------------------------------------------------
// What a push would leave without a delivery price
// ---------------------------------------------------------------------------

// The coverage figure was the other half of the same finding: it counted
// products against the delivery groups they FALL IN, which is only the same
// thing as the labels the feed SENDS when the owner has switched that on.
// Otherwise it reported a healthy catalogue that was about to be mispriced.
describe('measureDeliveryCoverage: when the feed is not labelling by delivery group', () => {
  const labels = labelMap([['range:a', 'Orion'], ['range:b', 'Vega']])

  it('counts every product as carrying none of these labels', async () => {
    productIds.value = ['p1', 'p2']
    answers.value = new Map([
      ['p1', { scopeId: 'range:a', tiedWith: [] }],
      ['p2', { scopeId: 'range:b', tiedWith: [] }],
    ])
    // Same shop, same groups, same services - only the feed's labelling differs.
    const labelled = await measureDeliveryCoverage([service('Standard', ['Orion', 'Vega'])], labels, true)
    expect(labelled.unlabelled).toBe(0)
    expect(labelled.services).toEqual([{ serviceName: 'Standard', uncovered: 0 }])

    const notLabelled = await measureDeliveryCoverage([service('Standard', ['Orion', 'Vega'])], labels, false)
    expect(notLabelled.unlabelled).toBe(2)
    expect(notLabelled.services).toEqual([{ serviceName: 'Standard', uncovered: 2 }])
  })

  it('says nothing about double-tagging, which cannot matter when no label is sent', async () => {
    productIds.value = ['p1']
    answers.value = new Map([['p1', { scopeId: 'range:a', tiedWith: ['range:b'] }]])
    const result = await measureDeliveryCoverage([service('Standard', ['Orion', 'Vega'], true)], labels, false)
    expect(result.doubleTagged).toBeNull()
  })
})

describe('measureDeliveryCoverage: who gets no price', () => {
  const labels = labelMap([['range:a', 'Orion'], ['range:b', 'Vega']])

  it('counts a product whose group a service does not name and cannot sweep up', async () => {
    productIds.value = ['p1', 'p2']
    answers.value = new Map([
      ['p1', { scopeId: 'range:a', tiedWith: [] }],
      ['p2', { scopeId: 'range:b', tiedWith: [] }],
    ])
    const result = await measureDeliveryCoverage([service('Standard', ['Orion'])], labels, true)
    expect(result.products).toBe(2)
    expect(result.services).toEqual([{ serviceName: 'Standard', uncovered: 1 }])
    expect(result.anyServiceWithoutCatchAll).toBe(true)
  })

  it('counts nobody as uncovered once a service sweeps up the rest', async () => {
    productIds.value = ['p1', 'p2']
    answers.value = new Map([
      ['p1', { scopeId: 'range:a', tiedWith: [] }],
      ['p2', { scopeId: 'range:b', tiedWith: [] }],
    ])
    const result = await measureDeliveryCoverage([service('Standard', ['Orion'], true)], labels, true)
    expect(result.services).toEqual([{ serviceName: 'Standard', uncovered: 0 }])
    expect(result.anyServiceWithoutCatchAll).toBe(false)
  })

  it('counts a product in no delivery group at all as unlabelled', async () => {
    productIds.value = ['p1', 'p2']
    answers.value = new Map([['p1', { scopeId: 'range:a', tiedWith: [] }]])
    const result = await measureDeliveryCoverage([service('Standard', ['Orion'])], labels, true)
    expect(result.unlabelled).toBe(1)
    expect(result.services).toEqual([{ serviceName: 'Standard', uncovered: 1 }])
  })
})

describe('coverageNotes', () => {
  it('says nothing when everything is covered', () => {
    expect(coverageNotes(coverage({ services: [{ serviceName: 'Standard', uncovered: 0 }] }))).toEqual([])
  })

  // The number is the whole point. "Some products may not be covered" is a
  // shrug; "1,900 of your 23,038" is something an owner can act on.
  it('puts a real figure on what would get no delivery price', () => {
    const notes = coverageNotes(coverage({
      anyServiceWithoutCatchAll: true,
      services: [{ serviceName: 'Standard', uncovered: 1_900 }, { serviceName: 'Express', uncovered: 12 }],
    }))
    expect(notes[0]?.severity).toBe('warning')
    expect(notes[0]?.message).toContain('1,900')
    expect(notes[0]?.message).toContain('23,038')
    expect(notes[0]?.message).toContain('Standard')
  })

  it('leads with the service that leaves most products out', () => {
    const notes = coverageNotes(coverage({
      anyServiceWithoutCatchAll: true,
      services: [{ serviceName: 'Express', uncovered: 12 }, { serviceName: 'Standard', uncovered: 1_900 }],
    }))
    expect(notes[0]?.message).toContain('"Standard"')
  })

  // Products in no delivery group are only a problem where no service has a
  // rule covering everything. With one, they are priced by it, which is what
  // it is for - so the same fact is a warning in one shop and a footnote in
  // another.
  it('treats unlabelled products as a warning only where nothing sweeps them up', () => {
    const bad = coverageNotes(coverage({ unlabelled: 1_900, anyServiceWithoutCatchAll: true }))
    expect(bad[0]?.severity).toBe('warning')
    expect(bad[0]?.message).toContain('no delivery price')

    const fine = coverageNotes(coverage({ unlabelled: 1_900, anyServiceWithoutCatchAll: false }))
    expect(fine[0]?.severity).toBe('info')
    expect(fine[0]?.message).toContain('which is what it is for')
  })

  // "Slightly fewer" was true of this shop and wrong of a variation-heavy one,
  // where the feed sends one row per variation and so sends MORE rows than
  // there are products. Different, not smaller.
  // Moved here from the mapping, and re-aimed. It used to fire on the
  // PRECONDITION - "this service prices two ranges" - which on a shop that
  // prices delivery by range is permanently true, so every owner got a
  // permanent caveat about a situation that did not exist. A permanent note is
  // wallpaper, and wallpaper is how the real warnings stop being read.
  it('says nothing about double-tagging when no product is double-tagged', () => {
    const notes = coverageNotes(coverage({ services: [{ serviceName: 'Standard', uncovered: 0 }] }))
    expect(notes.some((note) => note.message.includes('more than one delivery group'))).toBe(false)
  })

  it('warns, with a figure, when products really are in two groups at once', () => {
    const notes = coverageNotes(coverage({
      doubleTagged: { products: 3, services: ['Express', 'Standard'], exampleGroups: ['Orion', 'Vega'] },
    }))
    const warning = notes.find((note) => note.message.includes('more than one delivery group'))
    expect(warning?.severity).toBe('warning')
    expect(warning?.message).toContain('3 of your products')
    expect(warning?.message).toContain('Orion, Vega')
    expect(warning?.message).toContain('Express, Standard')
  })

  it('says the count is a different set from the feed, not a smaller one', () => {
    const notes = coverageNotes(coverage({ unlabelled: 5, anyServiceWithoutCatchAll: true }))
    const caveat = notes.at(-1)?.message ?? ''
    expect(caveat).toContain('a different set')
    expect(caveat).toContain('one row per variation')
    expect(caveat).not.toContain('slightly fewer')
  })
})
