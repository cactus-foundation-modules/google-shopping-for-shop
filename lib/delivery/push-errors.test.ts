import { describe, it, expect } from 'vitest'
import {
  describePushFailure,
  failureDetail,
  readPushFailure,
  validationCodes,
} from '@/modules/google-shopping-for-shop/lib/delivery/push-errors'
import {
  GoogleApiError,
  GoogleAuthError,
  GoogleNetworkError,
} from '@/modules/google-shopping-for-shop/lib/google/errors'

/** Shaped the way Merchant Center really answers a refused shipping settings
 *  insert: a generic message, a generic status, and the actual rule that was
 *  broken buried in the ErrorInfo metadata. */
function refusal(code: string): GoogleApiError {
  return new GoogleApiError(
    'Request contains an invalid argument.',
    400,
    'INVALID_ARGUMENT',
    null,
    [{
      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
      reason: 'VALIDATION_ERRORS',
      domain: 'merchantapi.googleapis.com',
      metadata: { shipping_settings_errors: `[{"errorCode":"${code}"}]` },
    }],
  )
}

describe('validationCodes', () => {
  it('finds the rule Google names in the detail metadata', () => {
    expect(validationCodes(refusal('TOO_MANY_SHIPPING_SERVICES_PER_COUNTRY').details, 'Request contains an invalid argument.'))
      .toEqual(['TOO_MANY_SHIPPING_SERVICES_PER_COUNTRY'])
  })

  it('leaves out the wrappers that name nothing', () => {
    const codes = validationCodes(refusal('TOO_MANY_RATE_GROUPS').details, '')
    expect(codes).not.toContain('VALIDATION_ERRORS')
    expect(codes).not.toContain('INVALID_ARGUMENT')
  })

  it('falls back to the message only where the details held nothing', () => {
    expect(validationCodes([], '[TOO_MANY_SHIPPING_SERVICES_PER_COUNTRY] too many services'))
      .toEqual(['TOO_MANY_SHIPPING_SERVICES_PER_COUNTRY'])
  })

  it('does not mistake ordinary words for codes', () => {
    expect(validationCodes([], 'Request contains an invalid argument.')).toEqual([])
  })

  it('survives details in a shape Google has never sent', () => {
    expect(validationCodes([null, 'text', 42, { metadata: 7 }], '')).toEqual([])
  })
})

describe('describePushFailure', () => {
  // The one that cost an hour. The owner was told to go and compare, which sent
  // somebody looking at the etag, when Google had said plainly it was the cap.
  it('names the service cap in the owner\'s own terms', () => {
    const failure = describePushFailure(refusal('TOO_MANY_SHIPPING_SERVICES_PER_COUNTRY'), { servicesInPayload: 24 })
    expect(failure.generic).toBe(false)
    expect(failure.explanation).toContain('20 delivery services per country')
    expect(failure.explanation).toContain('24')
    expect(failure.explanation).toContain('Merchant Center')
    expect(failure.validationErrors).toEqual(['TOO_MANY_SHIPPING_SERVICES_PER_COUNTRY'])
    // Google's own words are kept whatever we make of them.
    expect(failure.message).toBe('Request contains an invalid argument.')
    expect(failure.status).toBe(400)
    expect(failure.reason).toBe('INVALID_ARGUMENT')
  })

  it('keeps an unrecognised code and says so generically rather than guessing', () => {
    const failure = describePushFailure(refusal('SOME_RULE_WE_HAVE_NEVER_SEEN'), { servicesInPayload: 4 })
    expect(failure.generic).toBe(true)
    expect(failure.explanation).toContain('Google would not accept your delivery settings')
    // The code is not thrown away just because nothing here can explain it.
    expect(failure.validationErrors).toEqual(['SOME_RULE_WE_HAVE_NEVER_SEEN'])
    expect(failureDetail(failure)).toContain('SOME_RULE_WE_HAVE_NEVER_SEEN')
    expect(failureDetail(failure)).toContain('Request contains an invalid argument.')
  })

  it('tells an owner refused for access what access is needed', () => {
    const failure = describePushFailure(new GoogleApiError('The caller does not have permission', 403, 'PERMISSION_DENIED'), { servicesInPayload: 4 })
    expect(failure.generic).toBe(false)
    expect(failure.explanation).toContain('Admin')
  })

  it('does not claim nothing changed when the answer never came back', () => {
    const failure = describePushFailure(new GoogleNetworkError('socket hang up'), { servicesInPayload: 4 })
    expect(failure.explanation).not.toContain('nothing has been changed')
    expect(failure.explanation).toContain('not known')
  })

  it('still records something for a failure that is not Google refusing', () => {
    const failure = describePushFailure(new GoogleAuthError('bad key'), { servicesInPayload: 4 })
    expect(failure.message).toBe('bad key')
    expect(failure.explanation).not.toBe('')
  })

  it('records an error of no known kind rather than nothing at all', () => {
    const failure = describePushFailure(new Error('something else broke'), { servicesInPayload: 4 })
    expect(failure.message).toBe('something else broke')
    expect(failure.generic).toBe(true)
  })
})

describe('failureDetail', () => {
  it('leads with what Google said', () => {
    const failure = describePushFailure(refusal('TOO_MANY_SHIPPING_SERVICES_PER_COUNTRY'), { servicesInPayload: 24 })
    expect(failureDetail(failure)).toBe(
      'Google said 400 INVALID_ARGUMENT: Request contains an invalid argument.: TOO_MANY_SHIPPING_SERVICES_PER_COUNTRY',
    )
  })
})

describe('readPushFailure', () => {
  it('reads one back out of jsonb', () => {
    const failure = describePushFailure(refusal('TOO_MANY_SHIPPING_SERVICES_PER_COUNTRY'), { servicesInPayload: 24 })
    expect(readPushFailure(JSON.parse(JSON.stringify(failure)))).toEqual(failure)
  })

  it('refuses anything that is not one, rather than throwing while drawing a log', () => {
    expect(readPushFailure(null)).toBeNull()
    expect(readPushFailure('failed')).toBeNull()
    expect(readPushFailure({ status: 400 })).toBeNull()
  })
})
