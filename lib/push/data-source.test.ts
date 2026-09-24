import { describe, it, expect } from 'vitest'
import { linkPlacement, linkedRule, unlinkedRule } from '@/modules/google-shopping-for-shop/lib/push/data-source'

// The merge that decides whether this feature does anything at all.
//
// Google replaces a primary data source's WHOLE default rule on a patch - "It
// doesn't work as an addition" - so a link that did not carry the owner's
// existing sources across would silently take them out of their own feed.
//
// And the ORDER of that list is not a nicety. Google, on the field itself:
// "providing the following list: [`1001`, `self`] will take attribute values
// from supplemental data source `1001`, and fallback to `self` if the attribute
// is not set in `1001`." First wins. `self` is the fetched feed.xml, which emits
// g:price and g:availability on every single item - so a link that put us LAST
// left our live prices permanently outranked by the very feed they exist to get
// ahead of, with nothing anywhere reporting a problem. Every ordering case below
// is there to stop that coming back.

const OURS = 'accounts/123/dataSources/999'
const THEIRS = 'accounts/123/dataSources/888'

describe('linkedRule', () => {
  it('puts OURS FIRST, because the list is first-wins', () => {
    expect(linkedRule([{ self: true }], OURS)).toEqual([
      { supplementalDataSourceName: OURS },
      { self: true },
    ])
  })

  it('goes ahead of the owner’s other supplemental sources too', () => {
    // Deliberate, and said out loud in the preview: a live price from the shop
    // that sells the thing should beat a price from a spreadsheet uploaded last
    // Tuesday. Everything those sources set that we do not send is untouched.
    expect(linkedRule([{ supplementalDataSourceName: THEIRS }, { self: true }], OURS)).toEqual([
      { supplementalDataSourceName: OURS },
      { supplementalDataSourceName: THEIRS },
      { self: true },
    ])
  })

  it('adds the feed itself to an EMPTY rule, which Google refuses outright', () => {
    // Google: "If `self` is missing from the list of `take_from_data_sources`,
    // the API will ignore attributes from the primary data source itself" -
    // and an empty list is refused, so there would be nothing to read at all.
    expect(linkedRule([], OURS)).toEqual([{ supplementalDataSourceName: OURS }, { self: true }])
  })

  it('does NOT add the feed itself to a non-empty rule that leaves it out', () => {
    // Only the empty case gets `self` invented for it. A rule that lists other
    // sources and deliberately omits `self` is somebody telling Google to
    // ignore the primary feed's own values, and putting it back would be this
    // module overturning a decision nobody asked it about.
    expect(linkedRule([{ supplementalDataSourceName: THEIRS }], OURS)).toEqual([
      { supplementalDataSourceName: OURS },
      { supplementalDataSourceName: THEIRS },
    ])
  })

  it('is null only when ours is already IN FRONT, so nothing is written', () => {
    expect(linkedRule([{ supplementalDataSourceName: OURS }, { self: true }], OURS)).toBeNull()
    // No `self` at all: the feed's own values are ignored, so being present is
    // being in front.
    expect(linkedRule([{ supplementalDataSourceName: THEIRS }, { supplementalDataSourceName: OURS }], OURS)).toBeNull()
  })

  it('REPAIRS a rule where ours has fallen behind the feed', () => {
    // The state nothing used to check for. Membership said "linked", setup said
    // "nothing to do", and Merchant Center answered from the feed every time.
    expect(linkedRule([{ self: true }, { supplementalDataSourceName: OURS }], OURS)).toEqual([
      { supplementalDataSourceName: OURS },
      { self: true },
    ])
    expect(linkedRule([{ supplementalDataSourceName: THEIRS }, { self: true }, { supplementalDataSourceName: OURS }], OURS)).toEqual([
      { supplementalDataSourceName: OURS },
      { supplementalDataSourceName: THEIRS },
      { self: true },
    ])
  })

  it('never drops what was already in the rule, and keeps its relative order', () => {
    const current = [
      { supplementalDataSourceName: 'accounts/123/dataSources/1' },
      { self: true },
      { supplementalDataSourceName: 'accounts/123/dataSources/2' },
    ]
    const next = linkedRule(current, OURS)
    expect(next?.[0]).toEqual({ supplementalDataSourceName: OURS })
    expect(next?.slice(1)).toEqual(current)
  })
})

describe('linkPlacement', () => {
  it('tells the three states apart', () => {
    expect(linkPlacement([{ self: true }], OURS)).toBe('missing')
    expect(linkPlacement([{ supplementalDataSourceName: OURS }, { self: true }], OURS)).toBe('ahead')
    expect(linkPlacement([{ self: true }, { supplementalDataSourceName: OURS }], OURS)).toBe('behind')
  })

  it('counts ours as ahead when the rule has no `self` to be behind', () => {
    expect(linkPlacement([{ supplementalDataSourceName: THEIRS }, { supplementalDataSourceName: OURS }], OURS)).toBe('ahead')
  })

  it('is about the feed, not about other supplemental sources', () => {
    // Being behind somebody else's extra feed is a preference. Being behind the
    // shop's own feed is the difference between working and not.
    expect(linkPlacement([{ supplementalDataSourceName: THEIRS }, { supplementalDataSourceName: OURS }, { self: true }], OURS)).toBe('ahead')
  })

  it('is missing on an empty rule', () => {
    expect(linkPlacement([], OURS)).toBe('missing')
  })
})

describe('unlinkedRule', () => {
  it('takes ours out and leaves everything else where it was', () => {
    expect(unlinkedRule([{ supplementalDataSourceName: OURS }, { supplementalDataSourceName: THEIRS }, { self: true }], OURS)).toEqual([
      { supplementalDataSourceName: THEIRS },
      { self: true },
    ])
  })

  it('is null when ours was never there', () => {
    expect(unlinkedRule([{ self: true }], OURS)).toBeNull()
  })

  it('never leaves an empty rule behind', () => {
    // Google refuses one, so a rule holding nothing but ours falls back to the
    // feed on its own.
    expect(unlinkedRule([{ supplementalDataSourceName: OURS }], OURS)).toEqual([{ self: true }])
  })

  it('undoes exactly what linkedRule did', () => {
    const before = [{ supplementalDataSourceName: THEIRS }, { self: true }]
    const linked = linkedRule(before, OURS)
    expect(unlinkedRule(linked ?? [], OURS)).toEqual(before)
  })
})
