import { describe, it, expect } from 'vitest'
import { previousSpan, resolveRange } from '@/modules/google-shopping-for-shop/lib/performance/range'

const TODAY = '2026-09-23'

describe('resolveRange', () => {
  it('reads the fixed spans inclusively, so "7 days" is seven days', () => {
    expect(resolveRange({ today: TODAY, range: '7' })).toEqual({ range: '7', from: '2026-09-17', to: TODAY, days: 7 })
    expect(resolveRange({ today: TODAY, range: '30' }).days).toBe(30)
    expect(resolveRange({ today: TODAY, range: '90' }).days).toBe(90)
  })

  it('reads today as one day', () => {
    expect(resolveRange({ today: TODAY, range: 'today' })).toEqual({ range: 'today', from: TODAY, to: TODAY, days: 1 })
  })

  it('falls back to 30 days for anything it does not recognise, rather than failing', () => {
    expect(resolveRange({ today: TODAY, range: 'last tuesday' }).range).toBe('30')
    expect(resolveRange({ today: TODAY, range: '' }).range).toBe('30')
  })

  it('takes a custom pair of dates', () => {
    const range = resolveRange({ today: TODAY, range: 'custom', from: '2026-08-01', to: '2026-08-31' })
    expect(range).toEqual({ range: 'custom', from: '2026-08-01', to: '2026-08-31', days: 31 })
  })

  it('reads a custom pair the wrong way round as the span it describes', () => {
    const range = resolveRange({ today: TODAY, range: 'custom', from: '2026-08-31', to: '2026-08-01' })
    expect(range.from).toBe('2026-08-01')
    expect(range.to).toBe('2026-08-31')
  })

  it('never shows the future, which nobody has figures for', () => {
    const range = resolveRange({ today: TODAY, range: 'custom', from: '2026-09-01', to: '2027-01-01' })
    expect(range.to).toBe(TODAY)
  })

  it('does not reach back past the oldest day held', () => {
    const range = resolveRange({ today: TODAY, range: '90', earliest: '2026-09-01' })
    expect(range.from).toBe('2026-09-01')
  })

  it('falls back on a custom range with nonsense dates rather than failing', () => {
    const range = resolveRange({ today: TODAY, range: 'custom', from: 'yesterday', to: '' })
    expect(range.from).toBe('2026-08-25')
    expect(range.to).toBe(TODAY)
  })

  it('collapses a range entirely in the future rather than ending before it starts', () => {
    const range = resolveRange({ today: TODAY, range: 'custom', from: '2027-01-01', to: '2027-02-01' })
    expect(range.from).toBe(range.to)
    expect(range.days).toBe(1)
  })
})

describe('previousSpan', () => {
  it('is the same length, ending the day before', () => {
    expect(previousSpan({ from: '2026-09-17', to: '2026-09-23', days: 7 })).toEqual({ from: '2026-09-10', to: '2026-09-16' })
  })
})
