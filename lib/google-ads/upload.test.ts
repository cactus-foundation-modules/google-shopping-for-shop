import { describe, expect, it } from 'vitest'
import {
  buildClickConversion,
  conversionDateTime,
  describeUpload,
  explainBlock,
  readBatchVerdicts,
} from '@/modules/google-shopping-for-shop/lib/google-ads/upload'
import { NOT_ALLOWLISTED, PROJECT_NOT_APPROVED } from '@/modules/google-shopping-for-shop/lib/google-ads/types'
import type { UploadableOrder } from '@/modules/google-shopping-for-shop/lib/google-ads/store'

const LANDED = new Date('2026-09-20T09:00:00.000Z')
const PAID = new Date('2026-09-20T11:32:45.000Z')

function order(patch: Partial<UploadableOrder> = {}): UploadableOrder {
  return {
    orderId: 'ord_1',
    orderNumber: 'DW000123',
    clickEventId: 'clk_1',
    clickId: 'EAIaIQobChMI-gclid',
    clickIdKind: 'gclid',
    landedAt: LANDED,
    confirmedAt: PAID,
    value: '412.50',
    currency: 'gbp',
    attempts: 0,
    ...patch,
  }
}

describe('conversionDateTime', () => {
  it('renders the format Google documents, with an explicit offset', () => {
    // "yyyy-mm-dd HH:mm:ss+|-HH:mm", per Google's own reference for
    // ClickConversion.conversion_date_time.
    expect(conversionDateTime(PAID)).toBe('2026-09-20 11:32:45+00:00')
    expect(conversionDateTime(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01 00:00:00+00:00')
    expect(conversionDateTime(PAID)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  })
})

describe('buildClickConversion', () => {
  const action = 'customers/1234567890/conversionActions/555'

  it('builds the documented request for a gclid', () => {
    const built = buildClickConversion({ order: order(), conversionAction: action })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.conversion).toEqual({
      conversionAction: action,
      conversionDateTime: '2026-09-20 11:32:45+00:00',
      conversionValue: 412.5,
      currencyCode: 'GBP',
      orderId: 'ord_1',
      consent: { adUserData: 'GRANTED' },
      gclid: 'EAIaIQobChMI-gclid',
    })
  })

  it('never sets adPersonalization', () => {
    // Google's own reference for Consent: adPersonalization "can only be set
    // for OfflineUserDataJobService and UserDataService". This is neither.
    const built = buildClickConversion({ order: order(), conversionAction: action })
    expect(built.ok && 'adPersonalization' in built.conversion.consent).toBe(false)
  })

  it('puts a gbraid or a wbraid in its own field, not in gclid', () => {
    const gbraid = buildClickConversion({ order: order({ clickIdKind: 'gbraid', clickId: 'br-1' }), conversionAction: action })
    expect(gbraid.ok && gbraid.conversion).toMatchObject({ gbraid: 'br-1' })
    expect(gbraid.ok && 'gclid' in gbraid.conversion).toBe(false)

    const wbraid = buildClickConversion({ order: order({ clickIdKind: 'wbraid', clickId: 'wb-1' }), conversionAction: action })
    expect(wbraid.ok && wbraid.conversion).toMatchObject({ wbraid: 'wb-1' })
  })

  it('refuses an srsltid, which is not a Google Ads click at all', () => {
    // Google appends srsltid to FREE Shopping clicks and to ordinary search
    // results as well as to ads, and ClickConversion has no field for one.
    const built = buildClickConversion({ order: order({ clickIdKind: 'srsltid', clickId: 'sr-1' }), conversionAction: action })
    expect(built.ok).toBe(false)
  })

  it('refuses a payment recorded as earlier than the visit', () => {
    // Google: the conversion time "must be after the click time". Nudging it
    // forward to get past that would be inventing data.
    const built = buildClickConversion({
      order: order({ confirmedAt: new Date('2026-09-20T08:00:00Z') }),
      conversionAction: action,
    })
    expect(built.ok).toBe(false)
    expect(built.ok === false && built.reason).toContain('before the visit')
  })

  it('refuses an unreadable total rather than sending a nonsense value', () => {
    expect(buildClickConversion({ order: order({ value: 'lots' }), conversionAction: action }).ok).toBe(false)
    expect(buildClickConversion({ order: order({ value: '-1' }), conversionAction: action }).ok).toBe(false)
  })
})

describe('readBatchVerdicts', () => {
  it('counts a row Google answered for as sent', () => {
    const reply = { results: [{ gclid: 'a', conversionAction: 'customers/1/conversionActions/2' }] }
    expect(readBatchVerdicts(reply, 1)).toEqual([{ kind: 'uploaded' }])
  })

  it('files a per-row complaint against that row and leaves the rest alone', () => {
    const reply = {
      results: [{ gclid: 'a' }, {}, { gclid: 'c' }],
      partialFailureError: {
        details: [{
          errors: [{
            errorCode: { conversionUploadError: 'CLICK_NOT_FOUND' },
            message: 'No click was found.',
            location: { fieldPathElements: [{ fieldName: 'conversions', index: 1 }] },
          }],
        }],
      },
    }
    const verdicts = readBatchVerdicts(reply, 3)
    expect(verdicts[0]).toEqual({ kind: 'uploaded' })
    expect(verdicts[1]).toMatchObject({ kind: 'refused', code: 'CLICK_NOT_FOUND', accountWide: false })
    expect(verdicts[2]).toEqual({ kind: 'uploaded' })
  })

  it('treats a complaint with no index as refusing every sale in the batch', () => {
    const reply = {
      results: [{}, {}],
      partialFailureError: {
        details: [{
          errors: [{ errorCode: { authorizationError: NOT_ALLOWLISTED }, message: 'Not allowlisted.' }],
        }],
      },
    }
    const verdicts = readBatchVerdicts(reply, 2)
    expect(verdicts.every((verdict) => verdict.kind === 'refused')).toBe(true)
    expect(verdicts[0]).toMatchObject({ code: NOT_ALLOWLISTED, accountWide: true })
  })

  it('reads a duplicate order id as proof it already landed', () => {
    // Google: "an order id can only be used for one conversion per conversion
    // action". So a duplicate complaint means the first send worked, and
    // recording it as a failure would offer it again for ever.
    const reply = {
      results: [{}],
      partialFailureError: {
        details: [{
          errors: [{
            errorCode: { conversionUploadError: 'DUPLICATE_ORDER_ID' },
            message: 'Already used.',
            location: { fieldPathElements: [{ fieldName: 'conversions', index: 0 }] },
          }],
        }],
      },
    }
    expect(readBatchVerdicts(reply, 1)).toEqual([{ kind: 'uploaded' }])
  })

  it('never counts a row Google said nothing about as sent', () => {
    expect(readBatchVerdicts({ results: [{}] }, 1)).toMatchObject([{ kind: 'refused' }])
    expect(readBatchVerdicts({}, 1)).toMatchObject([{ kind: 'refused' }])
    expect(readBatchVerdicts(null, 2)).toHaveLength(2)
  })

  it('treats an error code it has never heard of as account-wide', () => {
    // The cautious way round: a new per-row code Google adds later raises a
    // notice a person then reads, rather than being filed silently under "one
    // of those things".
    const reply = {
      results: [{}],
      partialFailureError: {
        details: [{
          errors: [{
            errorCode: { conversionUploadError: 'SOMETHING_NEW' },
            message: 'New.',
            location: { fieldPathElements: [{ fieldName: 'conversions', index: 0 }] },
          }],
        }],
      },
    }
    expect(readBatchVerdicts(reply, 1)[0]).toMatchObject({ accountWide: true })
  })
})

describe('explainBlock', () => {
  it('explains the two refusals an owner can act on, in their own words', () => {
    expect(explainBlock(NOT_ALLOWLISTED, 'raw')).toContain('15 June 2026')
    expect(explainBlock(PROJECT_NOT_APPROVED, 'raw')).toContain('test access')
    // Anything else is Google's own sentence, unchanged.
    expect(explainBlock('CLICK_NOT_FOUND', 'No click was found.')).toBe('No click was found.')
    expect(explainBlock(null, 'No click was found.')).toBe('No click was found.')
  })
})

describe('describeUpload', () => {
  it('writes the run in a sentence a person can read', () => {
    expect(describeUpload({ status: 'ok', uploaded: 1, failed: 0, skipped: 0, leftWaiting: 0 }))
      .toBe('Told Google Ads about 1 sale.')
    expect(describeUpload({ status: 'part', uploaded: 2, failed: 3, skipped: 1, leftWaiting: 0 }))
      .toBe('Told Google Ads about 2 sales, 3 were refused, 1 was left out.')
    expect(describeUpload({ status: 'ok', uploaded: 0, failed: 0, skipped: 0, leftWaiting: 0 }))
      .toBe('Nothing needed sending to Google Ads')
  })
})
