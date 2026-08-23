import { describe, it, expect, vi, beforeEach } from 'vitest'

// The registry is generated at build time from the manifests of the modules
// actually installed, so the test stands one in - the seam being checked here is
// what happens to a provider's answer, not how it was found.
const registry: Record<string, Record<string, unknown>> = {}
vi.mock('@/lib/modules/extension-points', () => ({ moduleExtensionPointComponents: registry }))

const POINT = 'shop.product-delivery-timing'

function provide(answer: Map<string, unknown>) {
  registry[POINT] = { 'test-provider': async () => answer }
}

describe('getDeliveryTiming', () => {
  beforeEach(() => {
    for (const key of Object.keys(registry)) delete registry[key]
  })

  it('is empty when nothing publishes delivery timing', async () => {
    const { getDeliveryTiming, hasDeliveryTimingProvider } = await import('@/modules/google-shopping-for-shop/lib/delivery-timing')
    expect(hasDeliveryTimingProvider()).toBe(false)
    expect((await getDeliveryTiming(['p1'])).size).toBe(0)
  })

  it('reads the service menu alongside the headline counts', async () => {
    provide(new Map([['p1', {
      handlingDays: 1,
      transitDays: 5,
      availabilityDate: null,
      options: [
        { label: 'Flat-Pack', price: 0, handlingDays: 1, transitDays: 5 },
        { label: 'Installation', price: 51.9, handlingDays: 1, transitDays: 10 },
      ],
    }]]))
    const { getDeliveryTiming, hasDeliveryTimingProvider } = await import('@/modules/google-shopping-for-shop/lib/delivery-timing')
    expect(hasDeliveryTimingProvider()).toBe(true)
    const timing = await getDeliveryTiming(['p1'])
    expect(timing.get('p1')?.options).toEqual([
      { label: 'Flat-Pack', price: 0, handlingDays: 1, transitDays: 5 },
      { label: 'Installation', price: 51.9, handlingDays: 1, transitDays: 10 },
    ])
  })

  it('drops only the unusable options, keeping the rest of the menu', async () => {
    provide(new Map([['p1', {
      handlingDays: 1,
      transitDays: 5,
      availabilityDate: null,
      options: [
        // A price the provider could not put a number on - no honest figure.
        { label: 'Unpriceable', price: null, handlingDays: 1, transitDays: 5 },
        { label: '  ', price: 10, handlingDays: 1, transitDays: 5 },
        { label: 'Half a range', price: 10, handlingDays: 1.5, transitDays: 5 },
        // A second service under a name already used.
        { label: 'Installation', price: 51.9, handlingDays: 1, transitDays: 10 },
        { label: 'Installation', price: 99, handlingDays: 1, transitDays: 10 },
      ],
    }]]))
    const { getDeliveryTiming } = await import('@/modules/google-shopping-for-shop/lib/delivery-timing')
    const timing = await getDeliveryTiming(['p1'])
    expect(timing.get('p1')?.options).toEqual([{ label: 'Installation', price: 51.9, handlingDays: 1, transitDays: 10 }])
    expect(timing.get('p1')?.handlingDays).toBe(1)
  })

  it('treats a provider too old to publish a menu as having none', async () => {
    provide(new Map([['p1', { handlingDays: 2, transitDays: 3, availabilityDate: null }]]))
    const { getDeliveryTiming } = await import('@/modules/google-shopping-for-shop/lib/delivery-timing')
    const timing = await getDeliveryTiming(['p1'])
    expect(timing.get('p1')).toEqual({ handlingDays: 2, transitDays: 3, availabilityDate: null, options: [] })
  })

  it('drops a product whose headline counts make no sense', async () => {
    provide(new Map([['p1', { handlingDays: -1, transitDays: 3, options: [] }]]))
    const { getDeliveryTiming } = await import('@/modules/google-shopping-for-shop/lib/delivery-timing')
    expect((await getDeliveryTiming(['p1'])).size).toBe(0)
  })
})
