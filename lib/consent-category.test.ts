import { describe, expect, it } from 'vitest'
import { MARKETING_CATEGORY, bannerHasMarketingCategory } from '@/modules/google-shopping-for-shop/lib/consent-category'

// What decides whether the Customer Reviews survey waits for consent. The value
// this compares against once arrived on the server as a client reference rather
// than a string, so every banner read as having no marketing category; the
// constant lives in a plain module now, and these pin the decision itself.
describe('bannerHasMarketingCategory', () => {
  it('is the plain string, not a reference to it', () => {
    expect(MARKETING_CATEGORY).toBe('marketing')
  })

  it('is true when an enabled banner carries a marketing category', () => {
    expect(bannerHasMarketingCategory({ enabled: true, categories: [{ key: 'necessary' }, { key: 'marketing' }] })).toBe(true)
  })

  it('is false when the banner has no marketing category to grant', () => {
    expect(bannerHasMarketingCategory({ enabled: true, categories: [{ key: 'necessary' }, { key: 'analytics' }] })).toBe(false)
    expect(bannerHasMarketingCategory({ enabled: true, categories: [] })).toBe(false)
    expect(bannerHasMarketingCategory({ enabled: true })).toBe(false)
  })

  it('is false when the banner is switched off or missing', () => {
    expect(bannerHasMarketingCategory({ enabled: false, categories: [{ key: 'marketing' }] })).toBe(false)
    expect(bannerHasMarketingCategory({ categories: [{ key: 'marketing' }] })).toBe(false)
    expect(bannerHasMarketingCategory(null)).toBe(false)
    expect(bannerHasMarketingCategory(undefined)).toBe(false)
  })

  it('copes with a category that has no key', () => {
    expect(bannerHasMarketingCategory({ enabled: true, categories: [{}, { key: 'marketing' }] })).toBe(true)
  })
})
