import { describe, expect, it } from 'vitest'
import {
  GoogleAdsApiError,
  parseAdsFailure,
  parseAdsRequestId,
} from '@/modules/google-shopping-for-shop/lib/google-ads/errors'

// The envelope below is the one Google's REST interface actually returns: the
// useful sentence is two levels down, and `errorCode` is a protobuf oneof - in
// JSON, an object with exactly one key naming the error family.

const TOP_LEVEL = {
  error: {
    code: 400,
    message: 'Request contains an invalid argument.',
    status: 'INVALID_ARGUMENT',
    details: [{
      '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure',
      errors: [{
        errorCode: { authorizationError: 'CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE' },
        message: 'The customer is not allowlisted for this feature.',
      }],
      requestId: 'abc123',
    }],
  },
}

const PARTIAL = {
  code: 3,
  message: 'Request contains an invalid argument.',
  details: [{
    '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure',
    errors: [
      {
        errorCode: { conversionUploadError: 'CLICK_NOT_FOUND' },
        message: 'No click was found for the given identifier.',
        location: { fieldPathElements: [{ fieldName: 'conversions', index: 2 }] },
      },
      {
        errorCode: { conversionUploadError: 'EXPIRED_CLICK' },
        message: 'The click is too old.',
        location: { fieldPathElements: [{ fieldName: 'conversions', index: 5 }] },
      },
    ],
    requestId: 'def456',
  }],
}

describe('parseAdsFailure', () => {
  it('digs the real complaint out of a top-level error', () => {
    expect(parseAdsFailure(TOP_LEVEL)).toEqual([{
      family: 'authorizationError',
      code: 'CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE',
      message: 'The customer is not allowlisted for this feature.',
      // No field path: the complaint is about the request, not about a row.
      operationIndex: -1,
    }])
  })

  it('reads a partialFailureError, which is the same shape one level up', () => {
    const failures = parseAdsFailure({ error: PARTIAL })
    expect(failures).toHaveLength(2)
    expect(failures[0]).toMatchObject({ code: 'CLICK_NOT_FOUND', operationIndex: 2 })
    expect(failures[1]).toMatchObject({ code: 'EXPIRED_CLICK', operationIndex: 5 })
  })

  it('reads a Status handed over without an error wrapper', () => {
    expect(parseAdsFailure(PARTIAL)).toHaveLength(2)
  })

  it('uses -1 for "about the whole request", never 0', () => {
    // Filing a whole-request refusal against the first row would leave the
    // other forty-nine looking as though they had gone through.
    const failures = parseAdsFailure({
      error: { details: [{ errors: [{ errorCode: { requestError: 'BAD_RESOURCE_ID' }, message: 'no' }] }] },
    })
    expect(failures[0]?.operationIndex).toBe(-1)
  })

  it('answers an empty list rather than throwing on anything it cannot read', () => {
    expect(parseAdsFailure(null)).toEqual([])
    expect(parseAdsFailure('nope')).toEqual([])
    expect(parseAdsFailure({ error: { details: 'not a list' } })).toEqual([])
    expect(parseAdsFailure({ error: { details: [{ errors: [{}] }] } })).toEqual([{
      family: null, code: null, message: 'Google refused it and did not say why.', operationIndex: -1,
    }])
  })
})

describe('parseAdsRequestId', () => {
  it('finds the id Google support asks for first', () => {
    expect(parseAdsRequestId(TOP_LEVEL)).toBe('abc123')
    expect(parseAdsRequestId(PARTIAL)).toBe('def456')
    expect(parseAdsRequestId({})).toBeNull()
  })
})

describe('GoogleAdsApiError', () => {
  it('shows Google’s innermost sentence rather than the outer one', () => {
    const error = new GoogleAdsApiError({
      status: 400,
      fallbackMessage: 'Request contains an invalid argument.',
      failures: parseAdsFailure(TOP_LEVEL),
      requestId: 'abc123',
    })
    expect(error.message).toBe('The customer is not allowlisted for this feature.')
    expect(error.code).toBe('CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE')
    expect(error.status).toBe(400)
  })

  it('falls back to the outer message when there is nothing underneath', () => {
    const error = new GoogleAdsApiError({
      status: 503, fallbackMessage: 'Service unavailable', failures: [], requestId: null,
    })
    expect(error.message).toBe('Service unavailable')
    // Inherits the shared retry rule unchanged: 429 and 5xx only.
    expect(error.retryable).toBe(true)
    expect(new GoogleAdsApiError({ status: 403, fallbackMessage: 'no', failures: [], requestId: null }).retryable).toBe(false)
    expect(new GoogleAdsApiError({ status: 403, fallbackMessage: 'no', failures: [], requestId: null }).forbidden).toBe(true)
  })
})
