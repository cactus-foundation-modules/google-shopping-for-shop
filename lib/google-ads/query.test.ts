import { describe, expect, it } from 'vitest'
import {
  ADS_ACCOUNT_QUERY,
  ADS_CONVERSION_ACTIONS_QUERY,
  adsConversionActionQuery,
  adsSpendQuery,
} from '@/modules/google-shopping-for-shop/lib/google-ads/query'

// A query language is executed by no typechecker, no linter and no build: a
// misspelt field is a 400 from Google at run time and nothing before it. These
// tests are the only thing standing between a typo here and a live site.

describe('adsSpendQuery', () => {
  it('selects exactly the fields Google documents for shopping_performance_view', () => {
    const query = adsSpendQuery({ from: '2026-09-01', to: '2026-09-07' })
    // Spelt in snake_case, which GAQL uses whichever interface sends it.
    expect(query).toContain('segments.date')
    expect(query).toContain('segments.product_item_id')
    expect(query).toContain('metrics.cost_micros')
    expect(query).toContain('metrics.clicks')
    expect(query).toContain('metrics.impressions')
    expect(query).toContain('metrics.conversions')
    expect(query).toContain('metrics.conversions_value')
    expect(query).toContain('FROM shopping_performance_view')
  })

  it('never selects a further segment, which would split a day across its values', () => {
    const query = adsSpendQuery({ from: '2026-09-01', to: '2026-09-07' })
    for (const trap of ['product_title', 'product_brand', 'campaign', 'ad_group', 'device']) {
      expect(query).not.toContain(trap)
    }
  })

  it('puts the dates in quotes and orders by a field it selected', () => {
    const query = adsSpendQuery({ from: '2026-09-01', to: '2026-09-07' })
    expect(query).toContain("segments.date BETWEEN '2026-09-01' AND '2026-09-07'")
    // "You can only order by fields specified in the SELECT clause."
    expect(query).toContain('ORDER BY segments.date ASC')
  })

  it('refuses anything that is not a date, because there is no parameter binding', () => {
    expect(() => adsSpendQuery({ from: "2026-09-01' OR '1'='1", to: '2026-09-07' })).toThrow()
    expect(() => adsSpendQuery({ from: '2026-9-1', to: '2026-09-07' })).toThrow()
    expect(() => adsSpendQuery({ from: '2026-09-01', to: '' })).toThrow()
  })
})

describe('the fixed queries', () => {
  it('asks the customer resource for the currency and timezone, which nothing else reports', () => {
    expect(ADS_ACCOUNT_QUERY).toContain('customer.currency_code')
    expect(ADS_ACCOUNT_QUERY).toContain('customer.time_zone')
    expect(ADS_ACCOUNT_QUERY).toContain('FROM customer')
  })

  it('looks for every "Import from clicks" tracker, switched on or off', () => {
    expect(ADS_CONVERSION_ACTIONS_QUERY).toContain("conversion_action.type = 'UPLOAD_CLICKS'")
    // NOT filtered on ENABLED. Hidden, a paused tracker was found by neither
    // resource name nor name, so the setup created a second with the same name
    // and handed the owner Google's DUPLICATE_NAME refusal instead of "that
    // tracker is switched off at Google Ads".
    expect(ADS_CONVERSION_ACTIONS_QUERY).not.toContain("status = 'ENABLED'")
    // Selected so it can be judged afterwards, where there are words for it.
    expect(ADS_CONVERSION_ACTIONS_QUERY).toContain('conversion_action.status')
    // The whole safeguard against double counting rests on reading this one.
    expect(ADS_CONVERSION_ACTIONS_QUERY).toContain('conversion_action.primary_for_goal')
  })
})

describe('adsConversionActionQuery', () => {
  it('takes a real resource name', () => {
    const query = adsConversionActionQuery('customers/1234567890/conversionActions/555')
    expect(query).toContain("conversion_action.resource_name = 'customers/1234567890/conversionActions/555'")
    expect(query).toContain('conversion_action.primary_for_goal')
  })

  it('refuses anything else, because the name becomes syntax', () => {
    expect(() => adsConversionActionQuery("customers/1/conversionActions/1' OR '1'='1")).toThrow()
    expect(() => adsConversionActionQuery('conversionActions/555')).toThrow()
    expect(() => adsConversionActionQuery('')).toThrow()
  })
})
