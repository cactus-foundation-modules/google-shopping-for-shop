import { describe, it, expect } from 'vitest'
import { DayAccumulator } from '@/modules/google-shopping-for-shop/lib/performance/accumulate'
import type { PerformanceRow } from '@/modules/google-shopping-for-shop/lib/performance/types'

function row(day: string, itemId: string, clicks: number, method: PerformanceRow['method'] = 'organic'): PerformanceRow {
  return {
    day,
    itemId,
    method,
    clicks,
    impressions: clicks * 10,
    clickThroughRate: 0.1,
    conversions: null,
    conversionValueMicros: null,
    conversionCurrency: null,
  }
}

describe('DayAccumulator', () => {
  it('writes a day as soon as the reader has moved past it', async () => {
    const written: PerformanceRow[][] = []
    const accumulator = new DayAccumulator(async (rows) => { written.push(rows) })

    await accumulator.addPage([row('2026-09-01', 'a', 1), row('2026-09-02', 'b', 2)])
    // The 1st is complete; the 2nd might carry on into the next page.
    expect(written.flat().map((r) => r.day)).toEqual(['2026-09-01'])

    await accumulator.addPage([row('2026-09-02', 'c', 3), row('2026-09-03', 'd', 4)])
    expect(written.flat().map((r) => r.day)).toEqual(['2026-09-01', '2026-09-02', '2026-09-02'])

    await accumulator.finish()
    expect(written.flat().map((r) => r.day)).toEqual(['2026-09-01', '2026-09-02', '2026-09-02', '2026-09-03'])
    expect(accumulator.rowsWritten).toBe(4)
  })

  it('holds nothing back once finished', async () => {
    const written: PerformanceRow[] = []
    const accumulator = new DayAccumulator(async (rows) => { written.push(...rows) })
    await accumulator.addPage([row('2026-09-01', 'a', 1)])
    expect(written).toHaveLength(0)
    await accumulator.finish()
    expect(written).toHaveLength(1)
  })

  it('adds two readings of the same day, item and method rather than keeping one', async () => {
    const written: PerformanceRow[] = []
    const accumulator = new DayAccumulator(async (rows) => { written.push(...rows) })
    await accumulator.addPage([row('2026-09-01', 'a', 1), row('2026-09-01', 'a', 4)])
    await accumulator.finish()
    expect(written).toHaveLength(1)
    expect(written[0]?.clicks).toBe(5)
  })

  it('keeps the two marketing methods apart', async () => {
    const written: PerformanceRow[] = []
    const accumulator = new DayAccumulator(async (rows) => { written.push(...rows) })
    await accumulator.addPage([row('2026-09-01', 'a', 1, 'organic'), row('2026-09-01', 'a', 4, 'ads')])
    await accumulator.finish()
    expect(written).toHaveLength(2)
    expect(written.map((r) => r.clicks).sort()).toEqual([1, 4])
  })

  it('writes days oldest first, so a run cut short leaves a contiguous block', async () => {
    const order: string[] = []
    const accumulator = new DayAccumulator(async (rows) => { order.push(rows[0]?.day ?? '') })
    await accumulator.addPage([
      row('2026-09-03', 'a', 1),
      row('2026-09-01', 'b', 1),
      row('2026-09-02', 'c', 1),
      row('2026-09-04', 'd', 1),
    ])
    await accumulator.finish()
    expect(order).toEqual(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'])
  })

  it('writes nothing at all for an empty report', async () => {
    let calls = 0
    const accumulator = new DayAccumulator(async () => { calls++ })
    await accumulator.addPage([])
    await accumulator.finish()
    expect(calls).toBe(0)
    expect(accumulator.rowsWritten).toBe(0)
  })
})
