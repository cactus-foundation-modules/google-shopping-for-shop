import { describe, it, expect } from 'vitest'
import { classifyLanding } from '@/modules/google-shopping-for-shop/lib/click-tracking/classify'

describe('classifyLanding', () => {
  it('says nothing about an address that carries nothing of ours', () => {
    expect(classifyLanding('')).toBeNull()
    expect(classifyLanding('?colour=black')).toBeNull()
    expect(classifyLanding('?utm_source=newsletter&utm_campaign=spring')).toBeNull()
    // Our source, somebody else's campaign: not ours.
    expect(classifyLanding('?utm_source=google&utm_campaign=brand')).toBeNull()
  })

  it('reads our free listing tag', () => {
    expect(classifyLanding('?utm_source=google&utm_medium=free_listing&utm_campaign=shopping')).toEqual({
      source: 'free', clickId: null, clickIdKind: null,
    })
  })

  it('reads our paid tag', () => {
    expect(classifyLanding('?utm_source=google&utm_medium=cpc&utm_campaign=shopping')).toEqual({
      source: 'paid', clickId: null, clickIdKind: null,
    })
  })

  it('treats any real ad identifier as paid, tag or no tag', () => {
    for (const name of ['gclid', 'gbraid', 'wbraid']) {
      expect(classifyLanding(`?${name}=abc123`), name).toEqual({ source: 'paid', clickId: 'abc123', clickIdKind: name })
    }
  })

  it('lets an ad identifier outrank a free tag on the same address', () => {
    // Google appends gclid to the address our own feed tagged, so this is the
    // ordinary shape of a paid click and must not be counted as free.
    expect(classifyLanding('?utm_source=google&utm_medium=free_listing&utm_campaign=shopping&gclid=abc')).toEqual({
      source: 'paid', clickId: 'abc', clickIdKind: 'gclid',
    })
  })

  it('does NOT treat srsltid on its own as paid', () => {
    // Google adds it to free Shopping clicks as well as paid ones.
    expect(classifyLanding('?srsltid=xyz')).toEqual({ source: 'free', clickId: 'xyz', clickIdKind: 'srsltid' })
    expect(classifyLanding('?gclid=abc&srsltid=xyz')).toEqual({ source: 'paid', clickId: 'abc', clickIdKind: 'gclid' })
  })

  it('falls back to free when the medium has been rewritten', () => {
    // Something in between edited the tag. Free is the answer that cannot
    // over-claim an ad spend.
    expect(classifyLanding('?utm_source=google&utm_medium=whatever&utm_campaign=shopping')?.source).toBe('free')
  })

  it('is not fooled by case or by an empty value', () => {
    expect(classifyLanding('?UTM_SOURCE=Google&utm_medium=CPC&UTM_CAMPAIGN=Shopping')).toBeNull()
    expect(classifyLanding('?utm_source=GOOGLE&utm_medium=CPC&utm_campaign=SHOPPING')?.source).toBe('paid')
    expect(classifyLanding('?gclid=')).toBeNull()
  })

  it('caps a click identifier rather than storing whatever was sent', () => {
    const long = 'a'.repeat(1_000)
    expect(classifyLanding(`?gclid=${long}`)?.clickId).toHaveLength(256)
  })
})
