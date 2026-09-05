import { describe, it, expect } from 'vitest'
import { addWorkingDays, isoDate } from '@/modules/google-shopping-for-shop/lib/customer-reviews'

// The date arithmetic alone. Everything else in customer-reviews.ts reads the
// database, and what is worth testing here is the bit that decides when Google
// is told to write to somebody.
describe('addWorkingDays', () => {
  it('counts weekdays only', () => {
    // Thursday 5 March 2026 + 3 working days = Tuesday 10 March.
    expect(isoDate(addWorkingDays(new Date('2026-03-05T10:00:00.000Z'), 3))).toBe('2026-03-10')
  })

  it('steps off a Saturday before it starts counting', () => {
    // Saturday 7 March + 1 working day = Monday 9 March.
    expect(isoDate(addWorkingDays(new Date('2026-03-07T10:00:00.000Z'), 1))).toBe('2026-03-09')
  })

  it('leaves the day alone when nothing is added', () => {
    expect(isoDate(addWorkingDays(new Date('2026-03-07T10:00:00.000Z'), 0))).toBe('2026-03-07')
  })

  it('treats a negative or fractional count as its nearest sensible whole', () => {
    expect(isoDate(addWorkingDays(new Date('2026-03-05T10:00:00.000Z'), -4))).toBe('2026-03-05')
    expect(isoDate(addWorkingDays(new Date('2026-03-05T10:00:00.000Z'), 2.7))).toBe('2026-03-09')
  })

  it('crosses a month end', () => {
    // Monday 30 March + 5 working days = Monday 6 April.
    expect(isoDate(addWorkingDays(new Date('2026-03-30T10:00:00.000Z'), 5))).toBe('2026-04-06')
  })

  it('gives Google the date shape it accepts, and nothing else', () => {
    expect(isoDate(new Date('2026-03-05T23:59:59.000Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
