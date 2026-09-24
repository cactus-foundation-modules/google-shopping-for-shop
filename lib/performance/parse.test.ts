import { describe, it, expect } from 'vitest'
import {
  asCount,
  asMicros,
  asRate,
  mergeRows,
  parsePerformanceRow,
} from '@/modules/google-shopping-for-shop/lib/performance/parse'
import type { PerformanceRow } from '@/modules/google-shopping-for-shop/lib/performance/types'

describe('asCount', () => {
  it('reads an int64 Google sent as a string', () => {
    expect(asCount('0')).toBe(0)
    expect(asCount('1423')).toBe(1423)
    expect(asCount(12)).toBe(12)
  })

  it('is null rather than NaN for anything that is not a whole number', () => {
    expect(asCount('12.5')).toBeNull()
    expect(asCount('lots')).toBeNull()
    expect(asCount('')).toBeNull()
    expect(asCount(null)).toBeNull()
    expect(asCount(1.5)).toBeNull()
    // Beyond what a JS number holds exactly - a wrong count is worse than none.
    expect(asCount('9007199254740993')).toBeNull()
  })
})

describe('asRate', () => {
  it('reads a double', () => {
    expect(asRate(0.0321)).toBeCloseTo(0.0321)
    expect(asRate('0.5')).toBe(0.5)
    expect(asRate(0)).toBe(0)
  })

  it('refuses anything that would put a hole in a chart', () => {
    expect(asRate(Number.POSITIVE_INFINITY)).toBeNull()
    expect(asRate(Number.NaN)).toBeNull()
    expect(asRate('')).toBeNull()
    expect(asRate(undefined)).toBeNull()
  })
})

describe('asMicros', () => {
  it('keeps money as a bigint rather than dividing it into a float', () => {
    expect(asMicros('1000000')).toBe(1_000_000n)
    expect(asMicros('-250000')).toBe(-250_000n)
    // Past what a JS number holds exactly, and still exact.
    expect(asMicros('9007199254740993000')).toBe(9_007_199_254_740_993_000n)
  })

  it('is null for anything that is not a whole number of millionths', () => {
    expect(asMicros('1.5')).toBeNull()
    expect(asMicros(1_000_000)).toBeNull()
    expect(asMicros(null)).toBeNull()
  })
})

describe('parsePerformanceRow', () => {
  const view = {
    date: { year: 2026, month: 9, day: 3 },
    offerId: 'sku-1',
    marketingMethod: 'ORGANIC',
    clicks: '12',
    impressions: '400',
    clickThroughRate: 0.03,
    conversions: 1.5,
    conversionValue: { amountMicros: '249990000', currencyCode: 'GBP' },
  }

  it('reads a free-listing row whole', () => {
    expect(parsePerformanceRow({ productPerformanceView: view })).toEqual({
      day: '2026-09-03',
      itemId: 'sku-1',
      method: 'organic',
      clicks: 12,
      impressions: 400,
      clickThroughRate: 0.03,
      conversions: 1.5,
      conversionValueMicros: 249_990_000n,
      conversionCurrency: 'GBP',
    })
  })

  it('leaves conversions NULL on a paid row, which is where Google never sends them', () => {
    const row = parsePerformanceRow({
      productPerformanceView: { ...view, marketingMethod: 'ADS', conversions: undefined, conversionValue: undefined },
    })
    expect(row?.method).toBe('ads')
    expect(row?.conversions).toBeNull()
    expect(row?.conversionValueMicros).toBeNull()
    expect(row?.conversionCurrency).toBeNull()
    // Clicks still count. Zero would be a lie; null here would be too.
    expect(row?.clicks).toBe(12)
  })

  it('counts a row Google sent with no clicks as no clicks', () => {
    const row = parsePerformanceRow({ productPerformanceView: { ...view, clicks: undefined, impressions: '10' } })
    expect(row?.clicks).toBe(0)
    expect(row?.impressions).toBe(10)
  })

  it('drops a row with nowhere to go rather than filing it under a made-up key', () => {
    expect(parsePerformanceRow({ productPerformanceView: { ...view, offerId: '' } })).toBeNull()
    expect(parsePerformanceRow({ productPerformanceView: { ...view, offerId: undefined } })).toBeNull()
    expect(parsePerformanceRow({ productPerformanceView: { ...view, date: undefined } })).toBeNull()
    expect(parsePerformanceRow({})).toBeNull()
  })

  it('calls a marketing method it has never seen "unknown" rather than guessing', () => {
    const row = parsePerformanceRow({ productPerformanceView: { ...view, marketingMethod: 'DEMAND_GEN_ADS' } })
    expect(row?.method).toBe('unknown')
  })

  it('drops a currency with no amount behind it', () => {
    const row = parsePerformanceRow({
      productPerformanceView: { ...view, conversionValue: { currencyCode: 'GBP' } },
    })
    expect(row?.conversionValueMicros).toBeNull()
    expect(row?.conversionCurrency).toBeNull()
  })
})

describe('mergeRows', () => {
  const base: PerformanceRow = {
    day: '2026-09-03',
    itemId: 'sku-1',
    method: 'organic',
    clicks: 10,
    impressions: 100,
    clickThroughRate: 0.1,
    conversions: 1,
    conversionValueMicros: 1_000_000n,
    conversionCurrency: 'GBP',
  }

  it('adds two readings of the same key rather than keeping one', () => {
    const merged = mergeRows(base, { ...base, clicks: 5, impressions: 300, conversions: 2, conversionValueMicros: 500_000n })
    expect(merged.clicks).toBe(15)
    expect(merged.impressions).toBe(400)
    expect(merged.conversions).toBe(3)
    expect(merged.conversionValueMicros).toBe(1_500_000n)
  })

  it('works the rate out again rather than averaging two rates', () => {
    const merged = mergeRows(base, { ...base, clicks: 5, impressions: 300, clickThroughRate: 5 / 300 })
    expect(merged.clickThroughRate).toBeCloseTo(15 / 400)
  })

  it('keeps null meaning "not reported" when neither side reported', () => {
    const paid = { ...base, conversions: null, conversionValueMicros: null, conversionCurrency: null }
    const merged = mergeRows(paid, paid)
    expect(merged.conversions).toBeNull()
    expect(merged.conversionValueMicros).toBeNull()
  })

  it('has no rate at all when nothing was shown', () => {
    const empty = { ...base, clicks: 0, impressions: 0 }
    expect(mergeRows(empty, empty).clickThroughRate).toBeNull()
  })
})
