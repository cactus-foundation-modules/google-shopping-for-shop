import { describe, it, expect, vi } from 'vitest'

// The seam's own reader. What matters here is that it is TOLERANT: the answer
// comes from another module through a registry with no shared types, so a shape
// written by an older build of that module has to keep working rather than
// costing the Delivery tab its contents.
const registry = vi.hoisted(() => ({ value: {} as Record<string, Record<string, unknown>> }))
vi.mock('@/lib/modules/extension-points.server', () => ({
  moduleServerExtensionPointComponents: registry.value,
}))

const { getProductDeliveryScopes, hasDeliveryCatalogue } =
  await import('@/modules/google-shopping-for-shop/lib/delivery/catalogue')

function publish(scopesForProducts: (ids: string[]) => Promise<unknown>) {
  registry.value['shop.delivery-services-catalogue'] = {
    'advanced-shipping': { catalogue: async () => null, scopesForProducts },
  }
}

describe('getProductDeliveryScopes', () => {
  it('answers nothing at all where no module publishes delivery', async () => {
    registry.value['shop.delivery-services-catalogue'] = {}
    expect(hasDeliveryCatalogue()).toBe(false)
    expect((await getProductDeliveryScopes(['p1'])).size).toBe(0)
  })

  it('reads the group and the groups the product also matched', async () => {
    publish(async () => new Map([['p1', { scopeId: 'range:a', tiedWith: ['range:b'] }]]))
    expect((await getProductDeliveryScopes(['p1'])).get('p1')).toEqual({ scopeId: 'range:a', tiedWith: ['range:b'] })
  })

  // The shape the first version of this seam published. A module that has not
  // been updated alongside this one still means exactly what it meant then.
  it('still understands a provider that answers with a bare group id', async () => {
    publish(async () => new Map([['p1', 'range:a']]))
    expect((await getProductDeliveryScopes(['p1'])).get('p1')).toEqual({ scopeId: 'range:a', tiedWith: [] })
  })

  it('drops an answer it cannot read rather than guessing at it', async () => {
    publish(async () => new Map<string, unknown>([
      ['p1', { scopeId: '' }],
      ['p2', { nothing: 'useful' }],
      ['p3', 42],
      ['p4', { scopeId: 'range:a', tiedWith: 'not a list' }],
    ]))
    const answers = await getProductDeliveryScopes(['p1', 'p2', 'p3', 'p4'])
    expect(answers.has('p1')).toBe(false)
    expect(answers.has('p2')).toBe(false)
    expect(answers.has('p3')).toBe(false)
    // A readable group with an unreadable tie keeps the group: the group is
    // the thing the feed needs, and a missing tie costs only an advisory.
    expect(answers.get('p4')).toEqual({ scopeId: 'range:a', tiedWith: [] })
  })

  it('copes with a provider that answers with something other than a map', async () => {
    publish(async () => ({ not: 'a map' }))
    expect((await getProductDeliveryScopes(['p1'])).size).toBe(0)
  })
})
