import { describe, it, expect } from 'vitest'
import { errorName, tooLarge } from '@/modules/google-shopping-for-shop/lib/click-tracking/beacon-guards'

describe('tooLarge', () => {
  it('refuses a body that declares itself over the limit', () => {
    expect(tooLarge('5000', 4_096)).toBe(true)
    expect(tooLarge('4097', 4_096)).toBe(true)
  })

  it('allows one exactly at the limit and under it', () => {
    expect(tooLarge('4096', 4_096)).toBe(false)
    expect(tooLarge('10', 4_096)).toBe(false)
    expect(tooLarge('0', 4_096)).toBe(false)
  })

  it('treats a missing or nonsense length as not known, never as too large', () => {
    // Absent on a chunked request. Refusing those would refuse real browsers.
    expect(tooLarge(null, 4_096)).toBe(false)
    expect(tooLarge(undefined, 4_096)).toBe(false)
    expect(tooLarge('', 4_096)).toBe(false)
    expect(tooLarge('lots', 4_096)).toBe(false)
    expect(tooLarge('-1', 4_096)).toBe(false)
  })
})

describe('errorName', () => {
  it('gives the name and never the message', () => {
    const error = new Error('insert into gsf_click_events values (gclid-abc, attr-xyz) failed')
    expect(errorName(error)).toBe('Error')
    expect(errorName(error)).not.toContain('gclid')

    const named = new Error('boom')
    named.name = 'PrismaClientKnownRequestError'
    expect(errorName(named)).toBe('PrismaClientKnownRequestError')
  })

  it('says what it was handed when it was not an error at all', () => {
    expect(errorName('a string')).toBe('string')
    expect(errorName(null)).toBe('object')
    expect(errorName(undefined)).toBe('undefined')
  })
})
