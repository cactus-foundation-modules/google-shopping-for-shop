import { describe, it, expect } from 'vitest'
import {
  WEEKDAY_NAMES,
  businessDays,
  fromAmountMicros,
  splitCutoff,
  toAmountMicros,
} from '@/modules/google-shopping-for-shop/lib/delivery/merchant-types'

// Micros are the easiest thing in the delivery sync to get wrong by a factor of
// a hundred, and a factor of a hundred on a delivery charge is the sort of
// mistake a customer notices before anybody here does.
describe('toAmountMicros', () => {
  it('turns pounds into millionths', () => {
    expect(toAmountMicros(9.99)).toBe('9990000')
    expect(toAmountMicros(10)).toBe('10000000')
    expect(toAmountMicros(0)).toBe('0')
  })

  it('rounds to the penny first, so no price is ever a fraction of one', () => {
    expect(toAmountMicros(12.345)).toBe('12350000')
    expect(toAmountMicros(0.005)).toBe('10000')
  })

  it('survives the floating point that 0.1 + 0.2 is famous for', () => {
    expect(toAmountMicros(0.1 + 0.2)).toBe('300000')
  })
})

describe('fromAmountMicros', () => {
  it('reads Google\'s figure back, string or number', () => {
    expect(fromAmountMicros('9990000')).toBe(9.99)
    expect(fromAmountMicros(10_000_000)).toBe(10)
  })

  it('round-trips', () => {
    for (const amount of [0, 0.5, 4.95, 9.99, 24.5, 199.95]) {
      expect(fromAmountMicros(toAmountMicros(amount))).toBe(amount)
    }
  })

  it('is null for nothing and for nonsense, never zero', () => {
    expect(fromAmountMicros(null)).toBeNull()
    expect(fromAmountMicros(undefined)).toBeNull()
    expect(fromAmountMicros('not a number')).toBeNull()
  })
})

describe('splitCutoff', () => {
  it('splits an HH:MM into the two integers Google wants', () => {
    expect(splitCutoff('14:30')).toEqual({ hour: 14, minute: 30 })
    expect(splitCutoff('00:00')).toEqual({ hour: 0, minute: 0 })
    expect(splitCutoff('09:05')).toEqual({ hour: 9, minute: 5 })
  })
})

describe('businessDays', () => {
  it('maps weekday numbers to Google\'s names, week order, 0 being Sunday', () => {
    expect(businessDays([1, 2, 3, 4, 5])).toEqual(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'])
    expect(businessDays([6, 0])).toEqual(['SUNDAY', 'SATURDAY'])
  })

  it('deduplicates and ignores anything that is not a weekday', () => {
    expect(businessDays([1, 1, 9, -1, 2])).toEqual(['MONDAY', 'TUESDAY'])
  })

  it('has a name for every day, so no index can come back undefined', () => {
    expect(WEEKDAY_NAMES).toHaveLength(7)
    expect(businessDays([0, 1, 2, 3, 4, 5, 6])).toHaveLength(7)
  })
})
