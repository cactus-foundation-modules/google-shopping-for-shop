import { describe, expect, it } from 'vitest'
import {
  float,
  int64,
  parseAdsAccount,
  parseAdsConversionAction,
  parseAdsSpendRow,
  parseMutateResourceName,
} from '@/modules/google-shopping-for-shop/lib/google-ads/parse'

// The shapes below are Google's own JSON encoding for v25: protobuf field names
// in lowerCamelCase, int64 as a string, double as a number.

describe('int64', () => {
  it('reads the string Google actually sends', () => {
    expect(int64('41')).toBe(41n)
    expect(int64('123456789012345')).toBe(123456789012345n)
    expect(int64('-5')).toBe(-5n)
  })

  it('takes a number too, and refuses anything it cannot read', () => {
    expect(int64(41)).toBe(41n)
    // Null rather than 0: a figure we could not read and a figure of nothing
    // must not look the same.
    expect(int64('4.1')).toBeNull()
    expect(int64('')).toBeNull()
    expect(int64(null)).toBeNull()
    expect(int64({})).toBeNull()
  })
})

describe('float', () => {
  it('reads a double, and refuses what is not one', () => {
    expect(float(2.5)).toBe(2.5)
    expect(float('2.5')).toBe(2.5)
    expect(float(0)).toBe(0)
    expect(float(Number.NaN)).toBeNull()
    expect(float(undefined)).toBeNull()
  })
})

describe('parseAdsSpendRow', () => {
  const row = {
    segments: { date: '2026-09-20', productItemId: 'dw-0099-black' },
    metrics: { costMicros: '4230000', clicks: '12', impressions: '980', conversions: 1.5, conversionsValue: 412.5 },
  }

  it('reads a documented row, keeping the int64s out of string arithmetic', () => {
    expect(parseAdsSpendRow(row)).toEqual({
      day: '2026-09-20',
      itemId: 'dw-0099-black',
      costMicros: 4230000n,
      clicks: 12n,
      impressions: 980n,
      conversions: 1.5,
      conversionsValue: 412.5,
    })
  })

  it('keeps the item id exactly as Google sent it, lower case and all', () => {
    // Google returns segments.product_item_id lower-cased whatever the id is in
    // Merchant Center. Storing it verbatim is what makes the lower() joins in
    // store.ts the only correct way to match it.
    const parsed = parseAdsSpendRow({ ...row, segments: { date: '2026-09-20', productItemId: 'dw-0099-black' } })
    expect(parsed?.itemId).toBe('dw-0099-black')
  })

  it('treats a missing metric as nothing, and a missing conversion as no answer', () => {
    const parsed = parseAdsSpendRow({ segments: { date: '2026-09-20', productItemId: 'x' }, metrics: {} })
    expect(parsed).toEqual({
      day: '2026-09-20', itemId: 'x', costMicros: 0n, clicks: 0n, impressions: 0n,
      conversions: null, conversionsValue: null,
    })
  })

  it('drops a row with no date or no item id rather than guessing at half a key', () => {
    expect(parseAdsSpendRow({ segments: { productItemId: 'x' }, metrics: {} })).toBeNull()
    expect(parseAdsSpendRow({ segments: { date: '2026-09-20' }, metrics: {} })).toBeNull()
    expect(parseAdsSpendRow({ segments: { date: 'yesterday', productItemId: 'x' } })).toBeNull()
    expect(parseAdsSpendRow({})).toBeNull()
  })
})

describe('parseAdsAccount', () => {
  it('reads what Google sent', () => {
    expect(parseAdsAccount({
      customer: { id: '1234567890', descriptiveName: 'Example Shop', currencyCode: 'gbp', timeZone: 'Europe/London' },
    })).toEqual({ id: '1234567890', name: 'Example Shop', currency: 'GBP', timeZone: 'Europe/London' })
  })

  it('answers nulls rather than inventing a currency', () => {
    expect(parseAdsAccount(undefined)).toEqual({ id: null, name: null, currency: null, timeZone: null })
    expect(parseAdsAccount({ customer: {} })).toEqual({ id: null, name: null, currency: null, timeZone: null })
  })
})

describe('parseAdsConversionAction', () => {
  it('reads one, upper-casing the enums', () => {
    expect(parseAdsConversionAction({
      conversionAction: {
        resourceName: 'customers/1/conversionActions/2',
        id: '2',
        name: 'Website sales',
        type: 'UPLOAD_CLICKS',
        status: 'ENABLED',
        category: 'PURCHASE',
        primaryForGoal: false,
      },
    })).toEqual({
      resourceName: 'customers/1/conversionActions/2',
      id: '2',
      name: 'Website sales',
      type: 'UPLOAD_CLICKS',
      status: 'ENABLED',
      category: 'PURCHASE',
      primaryForGoal: false,
    })
  })

  it('reads a MISSING primary flag as not known, never as secondary', () => {
    // The whole protection against counting a sale twice rests on this being a
    // positive false from Google. An absent field read as false would be
    // exactly the accident it exists to prevent.
    const parsed = parseAdsConversionAction({
      conversionAction: { resourceName: 'customers/1/conversionActions/2', type: 'UPLOAD_CLICKS' },
    })
    expect(parsed?.primaryForGoal).toBeNull()
  })

  it('drops a row with no resource name', () => {
    expect(parseAdsConversionAction({ conversionAction: { name: 'x' } })).toBeNull()
    expect(parseAdsConversionAction({})).toBeNull()
  })
})

describe('parseMutateResourceName', () => {
  it('reads the name out of a mutate reply', () => {
    expect(parseMutateResourceName({ results: [{ resourceName: 'customers/1/conversionActions/2' }] }))
      .toBe('customers/1/conversionActions/2')
  })

  it('answers null when there is nothing to read, so nothing is claimed', () => {
    expect(parseMutateResourceName({ results: [] })).toBeNull()
    expect(parseMutateResourceName({})).toBeNull()
    expect(parseMutateResourceName(null)).toBeNull()
  })
})
