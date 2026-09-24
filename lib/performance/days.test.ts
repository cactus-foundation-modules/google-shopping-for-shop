import { describe, it, expect } from 'vitest'
import {
  addDays,
  dayFromDate,
  dayFromGoogle,
  daysBetween,
  daysInRange,
  isDayString,
  maxDay,
  minDay,
  todayUtc,
} from '@/modules/google-shopping-for-shop/lib/performance/days'

describe('isDayString', () => {
  it('takes a real calendar day', () => {
    expect(isDayString('2026-09-23')).toBe(true)
    expect(isDayString('2024-02-29')).toBe(true)
  })

  it('refuses a day that does not exist, rather than rolling it into next month', () => {
    expect(isDayString('2026-02-31')).toBe(false)
    expect(isDayString('2026-13-01')).toBe(false)
    expect(isDayString('2025-02-29')).toBe(false)
  })

  it('refuses anything that is not the shape at all', () => {
    expect(isDayString('2026-9-3')).toBe(false)
    expect(isDayString('2026-09-23T00:00:00Z')).toBe(false)
    expect(isDayString('')).toBe(false)
    expect(isDayString(null)).toBe(false)
    expect(isDayString(20260923)).toBe(false)
  })
})

describe('dayFromGoogle', () => {
  it('reads a whole date', () => {
    expect(dayFromGoogle({ year: 2026, month: 9, day: 3 })).toBe('2026-09-03')
  })

  it('refuses a partial date, which Google uses for anniversaries and card expiries', () => {
    expect(dayFromGoogle({ year: 0, month: 9, day: 3 })).toBeNull()
    expect(dayFromGoogle({ year: 2026, month: 9, day: 0 })).toBeNull()
    expect(dayFromGoogle({ year: 2026, month: 0, day: 0 })).toBeNull()
  })

  it('refuses a date that is not one', () => {
    expect(dayFromGoogle({ year: 2026, month: 2, day: 31 })).toBeNull()
    expect(dayFromGoogle(null)).toBeNull()
    expect(dayFromGoogle('2026-09-03')).toBeNull()
    expect(dayFromGoogle({ year: '2026', month: 9, day: 3 })).toBeNull()
  })
})

describe('dayFromDate', () => {
  it('reads a DATE column in UTC, so the stored day is the day that comes back', () => {
    expect(dayFromDate(new Date('2026-09-23T00:00:00.000Z'))).toBe('2026-09-23')
    // A DATE that Prisma handed back with a time on it is still that day.
    expect(dayFromDate(new Date('2026-09-23T23:30:00.000Z'))).toBe('2026-09-23')
  })

  it('takes a string that is already a day', () => {
    expect(dayFromDate('2026-09-23')).toBe('2026-09-23')
  })

  it('is null for anything else', () => {
    expect(dayFromDate(null)).toBeNull()
    expect(dayFromDate(undefined)).toBeNull()
    expect(dayFromDate(new Date('nonsense'))).toBeNull()
  })
})

describe('day arithmetic', () => {
  it('adds and subtracts across month and year ends', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01')
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
  })

  it('does not drift across a daylight saving change', () => {
    // The UK clocks go back on 25 October 2026. Adding a day through a local
    // Date would give 25 October twice.
    expect(addDays('2026-10-24', 1)).toBe('2026-10-25')
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26')
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2)
  })

  it('counts the gap in both directions', () => {
    expect(daysBetween('2026-09-01', '2026-09-30')).toBe(29)
    expect(daysBetween('2026-09-30', '2026-09-01')).toBe(-29)
    expect(daysBetween('2026-09-01', '2026-09-01')).toBe(0)
  })

  it('picks the earlier and the later', () => {
    expect(minDay('2026-09-01', '2026-08-31')).toBe('2026-08-31')
    expect(maxDay('2026-09-01', '2026-08-31')).toBe('2026-09-01')
  })
})

describe('daysInRange', () => {
  it('is inclusive at both ends', () => {
    expect(daysInRange('2026-09-01', '2026-09-03')).toEqual(['2026-09-01', '2026-09-02', '2026-09-03'])
    expect(daysInRange('2026-09-01', '2026-09-01')).toEqual(['2026-09-01'])
  })

  it('is empty when the end is before the start', () => {
    expect(daysInRange('2026-09-03', '2026-09-01')).toEqual([])
  })

  it('stops at the limit rather than building a decade', () => {
    expect(daysInRange('2000-01-01', '2026-01-01', 5)).toHaveLength(5)
  })
})

describe('todayUtc', () => {
  it('reads the clock in UTC', () => {
    expect(todayUtc(new Date('2026-09-23T23:59:59.999Z'))).toBe('2026-09-23')
    expect(todayUtc(new Date('2026-09-24T00:00:00.000Z'))).toBe('2026-09-24')
  })
})
