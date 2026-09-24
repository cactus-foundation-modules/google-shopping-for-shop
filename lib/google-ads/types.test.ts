import { describe, expect, it } from 'vitest'
import {
  ADS_ENV_COPY,
  ADS_REQUIRED_ENV_VARS,
  ADS_SKIP_COPY,
  ADS_SKIP_REASONS,
  costPerSale,
  isAccountWideCode,
  isUploadableClickIdKind,
  microsToUnits,
} from '@/modules/google-shopping-for-shop/lib/google-ads/types'
import { asAdsCustomerId } from '@/modules/google-shopping-for-shop/lib/google-ads/credentials'

describe('the click identifiers we may upload', () => {
  it('takes the three Google Ads has a field for, and not srsltid', () => {
    expect(isUploadableClickIdKind('gclid')).toBe(true)
    expect(isUploadableClickIdKind('gbraid')).toBe(true)
    expect(isUploadableClickIdKind('wbraid')).toBe(true)
    expect(isUploadableClickIdKind('srsltid')).toBe(false)
    expect(isUploadableClickIdKind(null)).toBe(false)
  })
})

describe('isAccountWideCode', () => {
  it('knows the ordinary per-row refusals', () => {
    expect(isAccountWideCode('CLICK_NOT_FOUND')).toBe(false)
    expect(isAccountWideCode('expired_click')).toBe(false)
  })

  it('treats a refusal it has never heard of, and a missing code, as account-wide', () => {
    expect(isAccountWideCode('CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE')).toBe(true)
    expect(isAccountWideCode('SOMETHING_NEW')).toBe(true)
    expect(isAccountWideCode(null)).toBe(true)
  })
})

describe('money', () => {
  it('turns Google’s millionths into units, and no answer into no answer', () => {
    expect(microsToUnits(4_230_000n)).toBe(4.23)
    expect(microsToUnits(0n)).toBe(0)
    expect(microsToUnits(null)).toBeNull()
  })

  it('refuses to divide by no sales', () => {
    expect(costPerSale(100, 4)).toBe(25)
    // Not zero: a cost per sale with no sales is no answer at all.
    expect(costPerSale(100, 0)).toBeNull()
  })
})

describe('asAdsCustomerId', () => {
  it('keeps the digits an owner pasted with dashes', () => {
    expect(asAdsCustomerId('123-456-7890')).toBe('1234567890')
    expect(asAdsCustomerId(' ID: 123 456 7890 ')).toBe('1234567890')
    expect(asAdsCustomerId('')).toBeNull()
    expect(asAdsCustomerId('none')).toBeNull()
    expect(asAdsCustomerId(undefined)).toBeNull()
  })
})

describe('the copy', () => {
  it('has a sentence for every way a run can decline', () => {
    for (const reason of ADS_SKIP_REASONS) {
      expect(ADS_SKIP_COPY[reason].length).toBeGreaterThan(10)
    }
  })

  it('does not gate anything on the developer token, which Google has retired', () => {
    // Google sunset developer tokens on 9 September 2026 and now ignores the
    // header. Making it required would leave this feature permanently off, with
    // no way to obtain one.
    expect(ADS_REQUIRED_ENV_VARS).not.toContain('GOOGLE_ADS_DEVELOPER_TOKEN')
    expect(ADS_ENV_COPY.GOOGLE_ADS_DEVELOPER_TOKEN.required).toBe(false)
    expect(ADS_ENV_COPY.GOOGLE_ADS_DEVELOPER_TOKEN.where).toContain('No longer needed')
  })
})
