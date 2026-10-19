import { describe, it, expect, vi, beforeEach } from 'vitest'

// The registry is core's generated one; here it is a plain object we control, so
// the provider can be present, absent or misshapen.
const registry: { current: Record<string, Record<string, unknown>> } = { current: {} }
vi.mock('@/lib/modules/extension-points.public', () => ({
  get modulePublicExtensionPointComponents() { return registry.current },
}))

import { getSpecAxisPairs } from '@/modules/google-shopping-for-shop/lib/product-labels'

const attributes = [
  { id: 'a-weight', name: 'Weight' },
  { id: 'a-size', name: 'Size (mm)' },
  { id: 'a-colour', name: 'Colour' },
]
const valuesByAttribute: Record<string, Map<string, string[]>> = {
  'a-size': new Map([['v1', ['1462mm W x 890mm D x 1125mm H']], ['v2', ['900mm']]]),
  'a-colour': new Map([['v1', ['Beech & White', 'Oak']]]),
  'a-weight': new Map([['v1', ['40kg']]]),
}

function installProvider() {
  const valuesFor = vi.fn(async (attributeId: string, _ids: string[]) => valuesByAttribute[attributeId] ?? new Map())
  registry.current = {
    'shop.product-attribute-values': { pat: { listAttributes: async () => attributes, valuesFor } },
  }
  return valuesFor
}

describe('getSpecAxisPairs', () => {
  beforeEach(() => { registry.current = {} })

  it('returns nothing, and asks nothing, when no module publishes attributes', async () => {
    expect(await getSpecAxisPairs(['v1'])).toEqual(new Map())
  })

  it('reads only colour and size attributes, once each for the whole run', async () => {
    const valuesFor = installProvider()
    const pairs = await getSpecAxisPairs(['v1', 'v2', 'v1'])
    expect(valuesFor).toHaveBeenCalledTimes(2)
    expect(valuesFor.mock.calls.map((c) => c[0]).sort()).toEqual(['a-colour', 'a-size'])
    expect(valuesFor.mock.calls[0]?.[1]).toEqual(['v1', 'v2'])
    expect(pairs.get('v1')).toEqual([
      { name: 'Size (mm)', value: '1462mm W x 890mm D x 1125mm H' },
      { name: 'Colour', value: 'Beech & White' },
    ])
    expect(pairs.get('v2')).toEqual([{ name: 'Size (mm)', value: '900mm' }])
  })

  it('prefers the plain Colour/Size attribute over part-specs, and falls back to them alone', async () => {
    registry.current = {
      'shop.product-attribute-values': {
        pat: {
          listAttributes: async () => [{ id: 'f', name: 'Frame Colour (spec)' }, { id: 'c', name: 'Colour' }],
          valuesFor: async (id: string) => id === 'f'
            ? new Map([['v1', ['White']], ['v2', ['Black']]])
            : new Map([['v1', ['Beech & White']]]),
        },
      },
    }
    const pairs = await getSpecAxisPairs(['v1', 'v2'])
    expect(pairs.get('v1')).toEqual([{ name: 'Colour', value: 'Beech & White' }])
    expect(pairs.get('v2')).toEqual([{ name: 'Frame Colour (spec)', value: 'Black' }])
  })

  it('survives a provider that answers in the wrong shape', async () => {
    registry.current = {
      'shop.product-attribute-values': { pat: { listAttributes: async () => attributes, valuesFor: async () => 'nope' } },
    }
    expect(await getSpecAxisPairs(['v1'])).toEqual(new Map())
  })
})
