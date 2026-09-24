import { describe, it, expect } from 'vitest'
import { formatDuration } from '@/modules/google-shopping-for-shop/components/workbench/reports/duration'

describe('formatDuration', () => {
  it('says under a minute rather than 0 minutes', () => {
    expect(formatDuration(0)).toBe('under a minute')
    expect(formatDuration(59)).toBe('under a minute')
  })

  it('counts minutes, then hours, then days', () => {
    expect(formatDuration(60)).toBe('1 minute')
    expect(formatDuration(45 * 60)).toBe('45 minutes')
    expect(formatDuration(60 * 60)).toBe('1 hour')
    expect(formatDuration(90 * 60)).toBe('1 hour 30 minutes')
    expect(formatDuration(48 * 60 * 60)).toBe('2 days')
    expect(formatDuration(50 * 60 * 60)).toBe('2 days 2 hours')
  })

  it('refuses nonsense rather than printing it', () => {
    expect(formatDuration(-1)).toBe('not known')
    expect(formatDuration(Number.NaN)).toBe('not known')
  })
})
