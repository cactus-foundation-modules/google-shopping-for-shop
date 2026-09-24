import { describe, it, expect } from 'vitest'
import { diffShippingSettings } from '@/modules/google-shopping-for-shop/lib/delivery/diff'
import type { MappedService } from '@/modules/google-shopping-for-shop/lib/delivery/mapping'
import type { MerchantService } from '@/modules/google-shopping-for-shop/lib/delivery/merchant-types'

function ours(name: string, price: number, labels: string[] = ['Orion']): MappedService {
  return {
    serviceKey: name.toLowerCase(),
    serviceName: name,
    handlingDays: 1,
    transitDays: 2,
    groups: [{ price, labels, catchAll: labels.length === 0 }],
    payload: {
      serviceName: name,
      active: true,
      deliveryCountries: ['GB'],
      currencyCode: 'GBP',
      deliveryTime: {
        minHandlingDays: 1,
        maxHandlingDays: 1,
        minTransitDays: 2,
        maxTransitDays: 2,
        cutoffTime: { hour: 14, minute: 30, timeZone: 'Europe/London' },
        handlingBusinessDayConfig: { businessDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] },
        transitBusinessDayConfig: { businessDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] },
      },
      rateGroups: [{
        applicableShippingLabels: labels,
        singleValue: { flatRate: { amountMicros: String(Math.round(price * 100) * 10_000), currencyCode: 'GBP' } },
      }],
    },
  }
}

/** The same service as Google would hand it back. */
function theirs(service: MappedService, overrides: Partial<MerchantService> = {}): MerchantService {
  return { ...JSON.parse(JSON.stringify(service.payload)) as MerchantService, ...overrides }
}

describe('diffShippingSettings', () => {
  it('calls an identical service a match', () => {
    const mine = ours('Standard', 9.99)
    const diff = diffShippingSettings({ ours: [mine], theirs: [theirs(mine)], managedNames: ['Standard'] })
    expect(diff.services).toEqual([{ serviceName: 'Standard', status: 'match', managed: true, differences: [] }])
    expect(diff.differences).toBe(0)
  })

  it('does not mind Google listing the rate groups in another order', () => {
    const mine = ours('Standard', 9.99, ['Orion', 'Vega'])
    const shuffled = theirs(mine)
    shuffled.rateGroups = [{
      applicableShippingLabels: ['Vega', 'Orion'],
      singleValue: { flatRate: { amountMicros: '9990000', currencyCode: 'GBP' } },
    }]
    const diff = diffShippingSettings({ ours: [mine], theirs: [shuffled], managedNames: [] })
    expect(diff.services[0]?.status).toBe('match')
  })

  it('names the price as the field that differs, both sides', () => {
    const mine = ours('Standard', 9.99)
    const other = theirs(mine)
    other.rateGroups = [{
      applicableShippingLabels: ['Orion'],
      singleValue: { flatRate: { amountMicros: '7990000', currencyCode: 'GBP' } },
    }]
    const diff = diffShippingSettings({ ours: [mine], theirs: [other], managedNames: [] })
    expect(diff.services[0]?.status).toBe('different')
    expect(diff.services[0]?.differences).toEqual([
      { field: 'What it charges', here: 'Orion: 9.99', atGoogle: 'Orion: 7.99' },
    ])
    expect(diff.differences).toBe(1)
  })

  it('spots a different delivery time and a different cut-off', () => {
    const mine = ours('Standard', 9.99)
    const other = theirs(mine)
    other.deliveryTime = { ...other.deliveryTime, maxTransitDays: 5, cutoffTime: { hour: 9, minute: 0, timeZone: 'Europe/London' } }
    const fields = diffShippingSettings({ ours: [mine], theirs: [other], managedNames: [] }).services[0]?.differences ?? []
    expect(fields.map((field) => field.field)).toEqual(['Time on the way', 'Order-by time'])
    expect(fields[0]).toEqual({ field: 'Time on the way', here: '2 working days', atGoogle: '2 to 5 working days' })
  })

  it('calls one Google has not got "missing"', () => {
    const diff = diffShippingSettings({ ours: [ours('Next day', 14.99)], theirs: [], managedNames: [] })
    expect(diff.services[0]?.status).toBe('missing')
    expect(diff.differences).toBe(1)
  })

  // The whole point of the managed list: a service somebody else made is not a
  // disagreement, it is somebody else's business, and a push leaves it alone.
  it('leaves a service nobody here manages out of the count', () => {
    const diff = diffShippingSettings({
      ours: [],
      theirs: [{ serviceName: 'Pallet delivery', rateGroups: [] }],
      managedNames: [],
    })
    expect(diff.services[0]).toMatchObject({ serviceName: 'Pallet delivery', status: 'only-in-google', managed: false })
    expect(diff.differences).toBe(0)
  })

  it('counts one this site put there and no longer offers', () => {
    const diff = diffShippingSettings({
      ours: [],
      theirs: [{ serviceName: 'Old service', rateGroups: [] }],
      managedNames: ['Old service'],
    })
    expect(diff.services[0]).toMatchObject({ status: 'only-in-google', managed: true })
    expect(diff.differences).toBe(1)
  })

  // A rate table or carrier rate is something this module never writes. Reading
  // it as "nothing" would call a service equal that we simply could not read.
  it('says plainly when Google holds a rate it cannot read', () => {
    const mine = ours('Standard', 9.99)
    const other = theirs(mine)
    other.rateGroups = [{ applicableShippingLabels: ['Orion'], mainTable: { rows: [] } }]
    const difference = diffShippingSettings({ ours: [mine], theirs: [other], managedNames: [] }).services[0]?.differences[0]
    expect(difference?.atGoogle).toBe('Orion: a rate this site cannot read')
  })

  it('spots a different set of travelling days, not just sending days', () => {
    const mine = ours('Standard', 9.99)
    const other = theirs(mine)
    other.deliveryTime = {
      ...other.deliveryTime,
      transitBusinessDayConfig: { businessDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] },
    }
    const fields = diffShippingSettings({ ours: [mine], theirs: [other], managedNames: [] }).services[0]?.differences ?? []
    expect(fields.map((field) => field.field)).toEqual(['Days it travels on'])
    expect(fields[0]?.atGoogle).toContain('Saturday')
  })

  // Sorting the rate groups makes the price comparison order-independent, which
  // is right - but it would also hide a catch-all sitting in the middle, and
  // Google reads a group with no labels as "everything else" wherever it is.
  it('does not let sorting hide a catch-all that is not last', () => {
    const mine = ours('Standard', 9.99, ['Orion'])
    mine.payload.rateGroups = [
      { applicableShippingLabels: ['Orion'], singleValue: { flatRate: { amountMicros: '9990000', currencyCode: 'GBP' } } },
      { applicableShippingLabels: [], singleValue: { flatRate: { amountMicros: '4950000', currencyCode: 'GBP' } } },
    ]
    const other = theirs(mine)
    // Same two rules, same two prices - the wrong way round.
    other.rateGroups = [...(mine.payload.rateGroups ?? [])].reverse()

    const fields = diffShippingSettings({ ours: [mine], theirs: [other], managedNames: [] }).services[0]?.differences ?? []
    expect(fields.map((field) => field.field)).toEqual(['Order of the rules'])
    expect(fields[0]).toEqual({
      field: 'Order of the rules',
      here: 'catch-all rule last',
      atGoogle: 'catch-all rule NOT last',
    })
  })

  it('names more than one catch-all, which Google does not allow', () => {
    const mine = ours('Standard', 9.99, ['Orion'])
    const other = theirs(mine)
    other.rateGroups = [
      { applicableShippingLabels: [], singleValue: { flatRate: { amountMicros: '1', currencyCode: 'GBP' } } },
      { applicableShippingLabels: [], singleValue: { flatRate: { amountMicros: '2', currencyCode: 'GBP' } } },
    ]
    const fields = diffShippingSettings({ ours: [mine], theirs: [other], managedNames: [] }).services[0]?.differences ?? []
    expect(fields.find((field) => field.field === 'Order of the rules')?.atGoogle).toContain('2 catch-all rules')
  })

  it('reads a refusal as a refusal, never as a missing price', () => {
    const mine = ours('Standard', 9.99, ['Orion'])
    mine.payload.rateGroups = [{ applicableShippingLabels: ['Orion'], singleValue: { noShipping: true } }]
    const other = theirs(mine)
    const diff = diffShippingSettings({ ours: [mine], theirs: [other], managedNames: [] })
    expect(diff.services[0]?.status).toBe('match')

    other.rateGroups = [{
      applicableShippingLabels: ['Orion'],
      singleValue: { flatRate: { amountMicros: '9990000', currencyCode: 'GBP' } },
    }]
    const changed = diffShippingSettings({ ours: [mine], theirs: [other], managedNames: [] })
    expect(changed.services[0]?.differences[0]).toEqual({
      field: 'What it charges',
      here: 'Orion: not delivered',
      atGoogle: 'Orion: 9.99',
    })
  })

  it('sorts the comparison by name so it does not jump about between runs', () => {
    const diff = diffShippingSettings({
      ours: [ours('Standard', 1), ours('Express', 2), ours('Assembly', 3)],
      theirs: [],
      managedNames: [],
    })
    expect(diff.services.map((service) => service.serviceName)).toEqual(['Assembly', 'Express', 'Standard'])
  })
})
