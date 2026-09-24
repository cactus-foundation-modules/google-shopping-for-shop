import { describe, it, expect } from 'vitest'
import { mergeShippingSettings } from '@/modules/google-shopping-for-shop/lib/delivery/merge'
import type { MappedService } from '@/modules/google-shopping-for-shop/lib/delivery/mapping'
import type { MerchantShippingSettings } from '@/modules/google-shopping-for-shop/lib/delivery/merchant-types'

function mapped(name: string, price: string): MappedService {
  return {
    serviceKey: name.toLowerCase(),
    serviceName: name,
    handlingDays: 1,
    transitDays: 2,
    groups: [{ price: Number(price), labels: [], catchAll: true }],
    payload: {
      serviceName: name,
      active: true,
      deliveryCountries: ['GB'],
      currencyCode: 'GBP',
      rateGroups: [{ applicableShippingLabels: [], singleValue: { flatRate: { amountMicros: price, currencyCode: 'GBP' } } }],
    },
  }
}

// Every case in this file is about the same failure: Merchant Center's insert
// replaces the WHOLE resource, so anything the merge leaves out is deleted
// silently and for good.
describe('mergeShippingSettings', () => {
  it('leaves a service this site never touched exactly as it is', () => {
    const current: MerchantShippingSettings = {
      etag: 'abc',
      services: [{ serviceName: 'Pallet delivery', active: true, minimumOrderValue: { amountMicros: '50000000', currencyCode: 'GBP' } }],
    }
    const merged = mergeShippingSettings(current, [mapped('Standard', '9990000')], [])
    expect(merged.services).toHaveLength(2)
    expect(merged.services?.[0]).toEqual(current.services?.[0])
    expect(merged.services?.[1]?.serviceName).toBe('Standard')
  })

  it('replaces one of ours in the position it was in', () => {
    const current: MerchantShippingSettings = {
      services: [
        { serviceName: 'Standard', currencyCode: 'GBP', rateGroups: [] },
        { serviceName: 'Pallet delivery' },
      ],
    }
    const merged = mergeShippingSettings(current, [mapped('Standard', '9990000')], ['Standard'])
    expect(merged.services?.map((service) => service.serviceName)).toEqual(['Standard', 'Pallet delivery'])
    expect(merged.services?.[0]?.rateGroups?.[0]?.singleValue?.flatRate?.amountMicros).toBe('9990000')
  })

  // Somebody typed that minimum into Merchant Center by hand. Rebuilding the
  // service from scratch would throw it away without a word.
  it('keeps a field somebody set by hand on one of our services', () => {
    const current: MerchantShippingSettings = {
      services: [{
        serviceName: 'Standard',
        minimumOrderValue: { amountMicros: '25000000', currencyCode: 'GBP' },
        shipmentType: 'DELIVERY',
      }],
    }
    const merged = mergeShippingSettings(current, [mapped('Standard', '9990000')], ['Standard'])
    expect(merged.services?.[0]?.minimumOrderValue).toEqual({ amountMicros: '25000000', currencyCode: 'GBP' })
    expect(merged.services?.[0]?.shipmentType).toBe('DELIVERY')
    expect(merged.services?.[0]?.rateGroups?.[0]?.singleValue?.flatRate?.amountMicros).toBe('9990000')
  })

  it('takes away one this site used to manage and no longer offers', () => {
    const current: MerchantShippingSettings = {
      services: [{ serviceName: 'Retired service' }, { serviceName: 'Somebody else\'s' }],
    }
    const merged = mergeShippingSettings(current, [], ['Retired service'])
    expect(merged.services?.map((service) => service.serviceName)).toEqual(['Somebody else\'s'])
  })

  it('keeps everything else on the resource, warehouses included', () => {
    const current: MerchantShippingSettings = {
      name: 'accounts/123/shippingSettings',
      etag: 'abc',
      warehouses: [{ name: 'Main' }],
      services: [],
    }
    const merged = mergeShippingSettings(current, [mapped('Standard', '0')], [])
    expect(merged.name).toBe('accounts/123/shippingSettings')
    expect(merged.warehouses).toEqual([{ name: 'Main' }])
  })

  it('copes with an account that has no services at all yet', () => {
    const merged = mergeShippingSettings({}, [mapped('Standard', '0')], [])
    expect(merged.services?.map((service) => service.serviceName)).toEqual(['Standard'])
  })

  it('leaves a nameless service Google sent alone rather than dropping it', () => {
    const current: MerchantShippingSettings = { services: [{ active: true }] }
    const merged = mergeShippingSettings(current, [], ['Something'])
    expect(merged.services).toEqual([{ active: true }])
  })
})
