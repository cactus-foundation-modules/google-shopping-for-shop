import { describe, it, expect } from 'vitest'
import {
  attributeLabel,
  issueCodeLabel,
  issueDetailLine,
  storedFetchState,
  storedReportingStatus,
  storedResolution,
  storedSeverity,
} from '@/modules/google-shopping-for-shop/lib/health/types'
import { isDisapprovalSpike } from '@/modules/google-shopping-for-shop/lib/health/spike'

describe('reading back what we stored', () => {
  it('accepts our own values and calls anything else unknown', () => {
    expect(storedSeverity('disapproved')).toBe('disapproved')
    expect(storedSeverity('something a later version wrote')).toBe('unknown')
    expect(storedResolution('merchant_action')).toBe('merchant_action')
    expect(storedResolution(null)).toBe('unknown')
    expect(storedFetchState('succeeded')).toBe('succeeded')
    expect(storedFetchState(undefined)).toBe('unknown')
  })

  it('keeps "never reported" apart from "Google would not say"', () => {
    // NULL in the column means the item has not been reported on since the
    // column existed. 'unknown' means Google answered and we did not follow.
    expect(storedReportingStatus(null)).toBeNull()
    expect(storedReportingStatus(undefined)).toBeNull()
    expect(storedReportingStatus('whatever')).toBe('unknown')
    expect(storedReportingStatus('eligible')).toBe('eligible')
  })
})

describe('making Google\'s words readable', () => {
  it('strips the namespace off an attribute name', () => {
    expect(attributeLabel('n:image_link')).toBe('image link')
    expect(attributeLabel('brand')).toBe('brand')
    expect(attributeLabel('')).toBe('')
  })

  it('turns an issue code into a sentence opener', () => {
    expect(issueCodeLabel('image_link_broken')).toBe('Image link broken')
    expect(issueCodeLabel('validation/invalid_value')).toBe('Validation/invalid value')
    // Google's own placeholder for a code it will not name.
    expect(issueCodeLabel('?')).toBe('Problem Google did not name')
    expect(issueCodeLabel('')).toBe('Unnamed problem')
  })

  it('says which field and which countries, and nothing when there is nothing', () => {
    expect(issueDetailLine({
      attribute: 'n:gtin',
      contexts: [
        { context: 'SHOPPING_ADS', disapprovedCountries: ['GB'], demotedCountries: [] },
        { context: 'FREE_LISTINGS', disapprovedCountries: [], demotedCountries: ['FR'] },
      ],
    })).toBe('Field: gtin · In FR, GB')
    expect(issueDetailLine({ attribute: '', contexts: [] })).toBe('')
  })
})

describe('when a jump in disapprovals is worth saying something about', () => {
  it('fires on a rise of at least the threshold', () => {
    expect(isDisapprovalSpike({ disapproved: 130, previous: 100, threshold: 25 })).toBe(true)
    expect(isDisapprovalSpike({ disapproved: 125, previous: 100, threshold: 25 })).toBe(true)
    expect(isDisapprovalSpike({ disapproved: 124, previous: 100, threshold: 25 })).toBe(false)
  })

  it('stays quiet about a standing problem that is not getting worse', () => {
    expect(isDisapprovalSpike({ disapproved: 400, previous: 400, threshold: 25 })).toBe(false)
    expect(isDisapprovalSpike({ disapproved: 200, previous: 400, threshold: 25 })).toBe(false)
  })

  it('never fires on the very first check', () => {
    expect(isDisapprovalSpike({ disapproved: 5_000, previous: null, threshold: 25 })).toBe(false)
  })

  it('is switched off by a threshold of zero', () => {
    expect(isDisapprovalSpike({ disapproved: 5_000, previous: 0, threshold: 0 })).toBe(false)
  })
})
