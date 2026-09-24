import { describe, it, expect } from 'vitest'
import type { FeedItem } from '@/modules/google-shopping-for-shop/lib/feed-xml'
import { listingIdentifiers, pruneIdentifiers } from '@/modules/google-shopping-for-shop/lib/review-listing-ids'

const offer = (over: Partial<FeedItem> & { id: string }): FeedItem => ({
  title: 'Oslo Desk',
  description: 'A desk.',
  link: 'https://example.test/shop/products/oslo-desk',
  imageLinks: ['https://example.test/oslo.jpg'],
  availability: 'in_stock',
  price: 399,
  currency: 'GBP',
  identifierExists: true,
  condition: 'new',
  ...over,
})

describe('listingIdentifiers', () => {
  it('keys a variation listing by its parent, not by each child offer', () => {
    const map = listingIdentifiers([
      offer({ id: 'child_black', itemGroupId: 'oslo', gtin: '5012345678900', brand: 'Nordic' }),
      offer({ id: 'child_oak', itemGroupId: 'oslo', gtin: '5012345678917', brand: 'Nordic' }),
    ])
    expect([...map.keys()]).toEqual(['oslo'])
    expect(map.get('oslo')).toEqual({
      gtins: ['5012345678900', '5012345678917'],
      mpns: [],
      skus: ['child_black', 'child_oak'],
      brands: ['Nordic'],
    })
  })

  it('gathers every child GTIN and MPN, which the parent row does not carry', () => {
    const map = listingIdentifiers([
      offer({ id: 'c1', itemGroupId: 'oslo', mpn: 'OSL-1600-BLK', brand: 'Nordic' }),
      offer({ id: 'c2', itemGroupId: 'oslo', mpn: 'OSL-1600-OAK', brand: 'Nordic' }),
    ])
    expect(map.get('oslo')?.mpns).toEqual(['OSL-1600-BLK', 'OSL-1600-OAK'])
    expect(map.get('oslo')?.brands).toEqual(['Nordic'])
  })

  it('keys a standalone listing by its own id', () => {
    const map = listingIdentifiers([offer({ id: 'lamp', gtin: '5012345678924', brand: 'Nordic' })])
    expect(map.get('lamp')).toEqual({
      gtins: ['5012345678924'],
      mpns: [],
      skus: ['lamp'],
      brands: ['Nordic'],
    })
  })

  it('publishes the offer id as the sku, never a supplier code', () => {
    const map = listingIdentifiers([offer({ id: 'prod_abc123' })])
    expect(map.get('prod_abc123')?.skus).toEqual(['prod_abc123'])
  })

  it('says one brand once however many variations repeat it', () => {
    const map = listingIdentifiers([
      offer({ id: 'c1', itemGroupId: 'oslo', brand: 'Nordic' }),
      offer({ id: 'c2', itemGroupId: 'oslo', brand: 'Nordic' }),
      offer({ id: 'c3', itemGroupId: 'oslo', brand: ' Nordic ' }),
    ])
    expect(map.get('oslo')?.brands).toEqual(['Nordic'])
  })

  it('carries nothing for a listing whose rules stripped its identifiers', () => {
    const map = listingIdentifiers([offer({ id: 'bespoke', identifierExists: false, brand: 'Deskwell' })])
    expect(pruneIdentifiers(map.get('bespoke')!)).toEqual({ skus: ['bespoke'], brands: ['Deskwell'] })
  })
})

describe('pruneIdentifiers', () => {
  it('leaves empty lists off rather than writing empty containers', () => {
    expect(pruneIdentifiers({ gtins: [], mpns: [], skus: ['a'], brands: [] })).toEqual({ skus: ['a'] })
  })

  it('keeps every list the listing actually filled', () => {
    expect(pruneIdentifiers({ gtins: ['5012345678900'], mpns: ['M'], skus: ['a'], brands: ['B'] }))
      .toEqual({ gtins: ['5012345678900'], mpns: ['M'], skus: ['a'], brands: ['B'] })
  })
})
