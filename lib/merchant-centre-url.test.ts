import { describe, it, expect } from 'vitest'
import { merchantCentreItemUrl } from '@/modules/google-shopping-for-shop/lib/merchant-centre-url'

// The console's URL is not a documented contract, and the two details it is
// easiest to get wrong both fail as a browser "cannot find the page" rather than
// as anything a type-check would catch. Pinned here against a real address taken
// from a live Merchant Center account.
describe('merchantCentreItemUrl', () => {
  it('matches the address Merchant Center itself uses', () => {
    expect(merchantCentreItemUrl({ merchantId: '5841713129', offerId: 'd84340b4-9188-4dc1-8cb2-695cb236d108', feedLabel: 'GB' }))
      .toBe('https://merchants.google.com/mc/items/details?a=5841713129&offerId=d84340b4-9188-4dc1-8cb2-695cb236d108&language=en&channel=0&feedLabel=GB')
  })

  it('sends the online channel as 0, not the API word', () => {
    const url = merchantCentreItemUrl({ merchantId: '1', offerId: 'x', feedLabel: null })
    expect(url).toContain('channel=0')
    expect(url).not.toContain('channel=online')
  })

  it('is on merchants.google.com, not the marketing domain', () => {
    expect(merchantCentreItemUrl({ merchantId: '1', offerId: 'x', feedLabel: null }))
      .toMatch(/^https:\/\/merchants\.google\.com\/mc\/items\/details\?/)
  })

  it('leaves the feed label off when there is not one', () => {
    expect(merchantCentreItemUrl({ merchantId: '1', offerId: 'x', feedLabel: null })).not.toContain('feedLabel')
  })

  it('escapes an offer id that needs it', () => {
    expect(merchantCentreItemUrl({ merchantId: '1', offerId: 'a b&c', feedLabel: 'GB' })).toContain('offerId=a+b%26c')
  })
})
