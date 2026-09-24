import { describe, it, expect } from 'vitest'
import { adsRedirectLink, alreadyTagged, taggedLink } from '@/modules/google-shopping-for-shop/lib/feed-link-tags'

describe('feed link tags', () => {
  it('adds the tag to a plain product link', () => {
    expect(taggedLink('https://example.com/a-desk')).toBe(
      'https://example.com/a-desk?utm_source=google&utm_medium=free_listing&utm_campaign=shopping',
    )
  })

  it('keeps an existing query string, which every variation link has', () => {
    expect(taggedLink('https://example.com/a-desk?colour=black&size=1400')).toBe(
      'https://example.com/a-desk?colour=black&size=1400&utm_source=google&utm_medium=free_listing&utm_campaign=shopping',
    )
  })

  it('puts the tag before a fragment rather than inside it', () => {
    expect(taggedLink('https://example.com/a-desk#spec')).toBe(
      'https://example.com/a-desk?utm_source=google&utm_medium=free_listing&utm_campaign=shopping#spec',
    )
    expect(taggedLink('https://example.com/a-desk?colour=black#spec')).toBe(
      'https://example.com/a-desk?colour=black&utm_source=google&utm_medium=free_listing&utm_campaign=shopping#spec',
    )
  })

  it('differs from the ads address in the medium and nothing else', () => {
    const link = taggedLink('https://example.com/a-desk?colour=black')
    const ads = adsRedirectLink('https://example.com/a-desk?colour=black')
    expect(ads).toBe(link.replace('utm_medium=free_listing', 'utm_medium=cpc'))
  })

  it('rewrites the medium on an already-tagged address rather than handing it back', () => {
    // The bug this exists to stop: an address tagged by hand came back from
    // adsRedirectLink unchanged, so ads_redirect was identical to link - medium
    // included - and every paid click on that item counted as a free listing.
    const byHand = 'https://example.com/a-desk?utm_source=google&utm_medium=free_listing&utm_campaign=shopping'
    expect(adsRedirectLink(byHand)).toBe('https://example.com/a-desk?utm_source=google&utm_medium=cpc&utm_campaign=shopping')
    expect(adsRedirectLink(byHand)).not.toBe(taggedLink(byHand))

    // And the other way round, so `link` is always the free address whatever
    // the owner typed.
    const paidByHand = 'https://example.com/a-desk?utm_source=google&utm_medium=cpc&utm_campaign=shopping'
    expect(taggedLink(paidByHand)).toBe('https://example.com/a-desk?utm_source=google&utm_medium=free_listing&utm_campaign=shopping')
  })

  it('adds a medium to a tagged address that carries none', () => {
    const noMedium = 'https://example.com/a-desk?utm_source=google&utm_campaign=shopping'
    expect(taggedLink(noMedium)).toBe('https://example.com/a-desk?utm_source=google&utm_campaign=shopping&utm_medium=free_listing')
    expect(adsRedirectLink(noMedium)).toBe('https://example.com/a-desk?utm_source=google&utm_campaign=shopping&utm_medium=cpc')
  })

  it('rewrites the medium in the query and never in a fragment', () => {
    const withHash = 'https://example.com/a-desk?utm_source=google&utm_medium=free_listing&utm_campaign=shopping#utm_medium=free_listing'
    expect(adsRedirectLink(withHash)).toBe('https://example.com/a-desk?utm_source=google&utm_medium=cpc&utm_campaign=shopping#utm_medium=free_listing')
  })

  it('never tags the same address twice', () => {
    const once = taggedLink('https://example.com/a-desk')
    expect(taggedLink(once)).toBe(once)
    expect(alreadyTagged(once)).toBe(true)
    expect(alreadyTagged('https://example.com/a-desk?utm_source=newsletter')).toBe(false)
    // Our own campaign, somebody else's source: not ours, so it gets tagged.
    expect(alreadyTagged('https://example.com/a-desk?utm_campaign=shopping')).toBe(false)
  })

  it('does not add a second copy of the tag to an address that already has one', () => {
    const byHand = 'https://example.com/a-desk?utm_source=google&utm_medium=free_listing&utm_campaign=shopping#spec'
    expect(taggedLink(byHand)).toBe(byHand)
    expect((taggedLink(byHand).match(/utm_source=/g) ?? [])).toHaveLength(1)
  })
})
