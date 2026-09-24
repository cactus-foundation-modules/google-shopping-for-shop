import { describe, it, expect } from 'vitest'
import type { FeedItem } from '@/modules/google-shopping-for-shop/lib/feed-xml'
import {
  buildProductInput,
  fromMicros,
  googleAvailability,
  sameSnapshot,
  snapshotFromProduct,
  snapshotOf,
  toMicros,
} from '@/modules/google-shopping-for-shop/lib/push/payload'

// The mapping between the feed's own words and Merchant API's. Every case here
// is a difference between the two that would be silently wrong rather than
// loudly wrong: an availability Google ignores, a price it rounds, a sale price
// it disapproves the item for.

const item = (over: Partial<FeedItem> = {}): FeedItem => ({
  id: 'p1',
  title: 'Aeron Chair',
  description: 'A chair',
  link: 'https://example.test/chair',
  imageLinks: ['https://example.test/chair.jpg'],
  availability: 'in_stock',
  price: 900,
  currency: 'GBP',
  identifierExists: true,
  condition: 'new',
  ...over,
} as FeedItem)

describe('googleAvailability', () => {
  it('sends Google’s enum, not the feed’s lower-case word', () => {
    expect(googleAvailability('in_stock')).toBe('IN_STOCK')
    expect(googleAvailability('out_of_stock')).toBe('OUT_OF_STOCK')
    expect(googleAvailability('preorder')).toBe('PREORDER')
    expect(googleAvailability('backorder')).toBe('BACKORDER')
  })
})

describe('toMicros', () => {
  it('turns major units into Google’s micros, as a string', () => {
    expect(toMicros(900)).toBe('900000000')
    expect(toMicros(900.5)).toBe('900500000')
    expect(toMicros(0)).toBe('0')
  })

  it('rounds before stringifying, so binary floating point cannot leak out', () => {
    // 1.1 * 1e6 is 1100000.0000000002 in IEEE 754, and String() of that is a
    // figure Google rejects.
    expect(toMicros(1.1)).toBe('1100000')
    expect(toMicros(29.99)).toBe('29990000')
    expect(toMicros(0.07)).toBe('70000')
  })

  it('refuses a price that is not a number rather than sending one', () => {
    expect(() => toMicros(Number.NaN)).toThrow()
    expect(() => toMicros(Number.POSITIVE_INFINITY)).toThrow()
  })
})

describe('fromMicros', () => {
  it('reads Google’s string back to two decimal places', () => {
    expect(fromMicros('900500000')).toBe(900.5)
    expect(fromMicros('29990000')).toBe(29.99)
    expect(fromMicros(0)).toBe(0)
  })

  it('is null for anything that is not a figure', () => {
    expect(fromMicros(undefined)).toBeNull()
    expect(fromMicros(null)).toBeNull()
    expect(fromMicros('')).toBeNull()
    expect(fromMicros('lots')).toBeNull()
  })
})

describe('snapshotOf', () => {
  it('carries the sale price when there is a real offer running', () => {
    expect(snapshotOf(item({ price: 900, salePrice: 750 }))).toEqual({ price: 900, salePrice: 750, currency: 'GBP', availability: 'IN_STOCK' })
  })

  it('drops a sale price that is not below the regular one', () => {
    // Google disapproves the item for it, and the feed XML already declines to
    // render one - so sending it here would put a problem on a product the feed
    // itself considers fine.
    expect(snapshotOf(item({ price: 900, salePrice: 900 })).salePrice).toBeUndefined()
    expect(snapshotOf(item({ price: 900, salePrice: 950 })).salePrice).toBeUndefined()
    expect(snapshotOf(item({ price: 900, salePrice: 0 })).salePrice).toBeUndefined()
  })
})

describe('sameSnapshot', () => {
  it('is true only when every figure matches', () => {
    const base = snapshotOf(item({ price: 900, salePrice: 750 }))
    expect(sameSnapshot(base, { price: 900, salePrice: 750, currency: 'GBP', availability: 'IN_STOCK' })).toBe(true)
    expect(sameSnapshot(base, { price: 900, salePrice: 749, currency: 'GBP', availability: 'IN_STOCK' })).toBe(false)
    expect(sameSnapshot(base, { price: 900, salePrice: 750, currency: 'EUR', availability: 'IN_STOCK' })).toBe(false)
    expect(sameSnapshot(base, { price: 900, salePrice: 750, currency: 'GBP', availability: 'OUT_OF_STOCK' })).toBe(false)
  })

  it('treats "no sale price" and "no sale price" as the same thing', () => {
    expect(sameSnapshot(
      { price: 900, currency: 'GBP', availability: 'IN_STOCK' },
      { price: 900, currency: 'GBP', availability: 'IN_STOCK' },
    )).toBe(true)
    expect(sameSnapshot(
      { price: 900, currency: 'GBP', availability: 'IN_STOCK' },
      { price: 900, salePrice: 750, currency: 'GBP', availability: 'IN_STOCK' },
    )).toBe(false)
  })
})

describe('buildProductInput', () => {
  it('carries the three attributes and the three required identity fields', () => {
    const body = buildProductInput(item({ id: 'sku-1', price: 900, salePrice: 750 }), { contentLanguage: 'en', feedLabel: 'GB' })
    expect(body).toEqual({
      offerId: 'sku-1',
      contentLanguage: 'en',
      feedLabel: 'GB',
      productAttributes: {
        price: { amountMicros: '900000000', currencyCode: 'GBP' },
        salePrice: { amountMicros: '750000000', currencyCode: 'GBP' },
        availability: 'IN_STOCK',
      },
    })
  })

  it('leaves the sale price out entirely when there is no offer', () => {
    const body = buildProductInput(item({ price: 900 }), { contentLanguage: 'en', feedLabel: 'GB' })
    expect('salePrice' in body.productAttributes).toBe(false)
  })

  it('never sends versionNumber', () => {
    // Google's own field documentation: "Do not set this field for insertions
    // into supplemental data sources." It is the obvious guard against an
    // out-of-order write and it is not available to us.
    const body = buildProductInput(item(), { contentLanguage: 'en', feedLabel: 'GB' })
    expect(Object.keys(body)).not.toContain('versionNumber')
  })

  it('sends nothing but price, sale price and availability', () => {
    // A supplemental data source merges over the primary feed. Anything else
    // put here would override the feed's own title, images or category.
    const body = buildProductInput(item({ title: 'Something else', salePrice: 750 }), { contentLanguage: 'en', feedLabel: 'GB' })
    expect(Object.keys(body.productAttributes).sort()).toEqual(['availability', 'price', 'salePrice'])
    expect(Object.keys(body).sort()).toEqual(['contentLanguage', 'feedLabel', 'offerId', 'productAttributes'])
  })
})

describe('snapshotFromProduct', () => {
  it('reads what Google says it holds', () => {
    expect(snapshotFromProduct({
      productAttributes: {
        price: { amountMicros: '900000000', currencyCode: 'GBP' },
        salePrice: { amountMicros: '750000000', currencyCode: 'GBP' },
        availability: 'IN_STOCK',
      },
    })).toEqual({ price: 900, salePrice: 750, currency: 'GBP', availability: 'IN_STOCK' })
  })

  it('accepts a lower-case availability from Google without complaint', () => {
    expect(snapshotFromProduct({
      productAttributes: { price: { amountMicros: '1000000', currencyCode: 'GBP' }, availability: 'in_stock' },
    })?.availability).toBe('IN_STOCK')
  })

  it('is null rather than half-read', () => {
    // "We could not read Google's answer" and "Google's answer was wrong" are
    // different things, and only one of them is worth raising an alarm about.
    expect(snapshotFromProduct(null)).toBeNull()
    expect(snapshotFromProduct({})).toBeNull()
    expect(snapshotFromProduct({ productAttributes: {} })).toBeNull()
    expect(snapshotFromProduct({ productAttributes: { availability: 'IN_STOCK' } })).toBeNull()
    expect(snapshotFromProduct({ productAttributes: { price: { amountMicros: '1000000', currencyCode: 'GBP' } } })).toBeNull()
    expect(snapshotFromProduct({
      productAttributes: { price: { amountMicros: '1000000', currencyCode: 'GBP' }, availability: 'WHO_KNOWS' },
    })).toBeNull()
  })
})
