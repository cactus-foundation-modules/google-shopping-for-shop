import { describe, it, expect } from 'vitest'
import { axisTop, pathFor } from '@/modules/google-shopping-for-shop/components/workbench/reports/TrendChart'
import type { TrendDay } from '@/modules/google-shopping-for-shop/lib/performance/report'

function day(date: string, imported: boolean, organicClicks = 0, adsClicks = 0): TrendDay {
  return {
    day: date,
    imported,
    organicClicks,
    organicImpressions: organicClicks * 10,
    adsClicks,
    adsImpressions: adsClicks * 10,
  }
}

describe('axisTop', () => {
  it('rounds up to one significant figure, so the gridline labels are readable', () => {
    expect(axisTop(8_143)).toBe(9_000)
    expect(axisTop(12)).toBe(20)
    expect(axisTop(1_000)).toBe(1_000)
  })

  it('is never zero - an axis from nought to nought has no scale', () => {
    expect(axisTop(0)).toBe(1)
    expect(axisTop(-5)).toBe(1)
  })
})

describe('pathFor', () => {
  it('draws one run through days that were all imported', () => {
    const path = pathFor([day('2026-09-01', true, 1), day('2026-09-02', true, 2), day('2026-09-03', true, 3)], 'clicks', 'organic', 10)
    expect(path.match(/M/g)).toHaveLength(1)
    expect(path.match(/L/g)).toHaveLength(2)
  })

  it('breaks the line at a day nothing was brought in, rather than running across it', () => {
    // The whole point: a gap must not be drawn as a straight line at whatever
    // height the two sides happen to be, and must never be drawn on the floor.
    const path = pathFor([day('2026-09-01', true, 1), day('2026-09-02', false), day('2026-09-03', true, 3)], 'clicks', 'organic', 10)
    expect(path.match(/M/g)).toHaveLength(2)
    expect(path).not.toContain('L')
  })

  it('draws nothing at all when no day was brought in', () => {
    expect(pathFor([day('2026-09-01', false), day('2026-09-02', false)], 'clicks', 'organic', 10)).toBe('')
  })

  it('keeps the two series apart', () => {
    const days = [day('2026-09-01', true, 1, 9), day('2026-09-02', true, 1, 9)]
    expect(pathFor(days, 'clicks', 'organic', 10)).not.toBe(pathFor(days, 'clicks', 'ads', 10))
  })

  it('puts a bigger figure higher up the chart, which is down the y axis', () => {
    const low = pathFor([day('2026-09-01', true, 1)], 'clicks', 'organic', 10)
    const high = pathFor([day('2026-09-01', true, 9)], 'clicks', 'organic', 10)
    const yOf = (path: string) => Number(path.split(' ')[1])
    expect(yOf(high)).toBeLessThan(yOf(low))
  })

  it('reads the impressions series when asked for it', () => {
    const days = [day('2026-09-01', true, 1)]
    expect(pathFor(days, 'impressions', 'organic', 100)).not.toBe(pathFor(days, 'clicks', 'organic', 100))
  })

  it('copes with a single day, which has no step to divide by', () => {
    expect(pathFor([day('2026-09-01', true, 5)], 'clicks', 'organic', 10)).toMatch(/^M[\d.]+ [\d.]+$/)
  })
})
