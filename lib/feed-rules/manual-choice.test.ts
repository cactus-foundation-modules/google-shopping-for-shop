import { describe, expect, it } from 'vitest'
import { manualChoiceOf } from '@/modules/google-shopping-for-shop/lib/feed-rules/manual-choice'
import { EMPTY_PRODUCT_DATA, type FeedChoice, type GsfProductData } from '@/modules/google-shopping-for-shop/lib/types'

const row = (productId: string, feedChoice: FeedChoice): GsfProductData => ({ productId, ...EMPTY_PRODUCT_DATA, feedChoice })

describe('manualChoiceOf', () => {
  it("lets a variation's own choice beat its listing's, both ways round", () => {
    expect(manualChoiceOf(row('child', 'include'), row('parent', 'exclude'))).toBe('include')
    expect(manualChoiceOf(row('child', 'exclude'), row('parent', 'include'))).toBe('exclude')
  })

  it('has a variation set to "follow the rules" do whatever its listing does', () => {
    expect(manualChoiceOf(row('child', 'rules'), row('parent', 'exclude'))).toBe('exclude')
    expect(manualChoiceOf(row('child', 'rules'), row('parent', 'include'))).toBe('include')
    expect(manualChoiceOf(row('child', 'rules'), row('parent', 'rules'))).toBe('rules')
  })

  it('falls back to the listing when the variation has no row at all', () => {
    expect(manualChoiceOf(undefined, row('parent', 'exclude'))).toBe('exclude')
    expect(manualChoiceOf(undefined, undefined)).toBe('rules')
  })

  it('has a product with no variations answer for itself', () => {
    expect(manualChoiceOf(row('solo', 'exclude'), undefined)).toBe('exclude')
    expect(manualChoiceOf(row('solo', 'rules'), undefined)).toBe('rules')
  })
})
