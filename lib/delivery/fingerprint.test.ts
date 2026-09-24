import { describe, it, expect } from 'vitest'
import { planFingerprint } from '@/modules/google-shopping-for-shop/lib/delivery/fingerprint'
import type { MappedService } from '@/modules/google-shopping-for-shop/lib/delivery/mapping'

function mapped(name: string, micros: string, notes = 'anything'): MappedService {
  return {
    serviceKey: name.toLowerCase(),
    serviceName: name,
    handlingDays: 1,
    transitDays: 2,
    // Deliberately varied between cases: the preview's own wording must not
    // change the fingerprint, only the payload may.
    groups: [{ price: Number(micros) / 1_000_000, labels: [notes], catchAll: false }],
    payload: {
      serviceName: name,
      active: true,
      deliveryCountries: ['GB'],
      currencyCode: 'GBP',
      rateGroups: [{ applicableShippingLabels: [], singleValue: { flatRate: { amountMicros: micros, currencyCode: 'GBP' } } }],
    },
  }
}

describe('planFingerprint', () => {
  it('is the same for the same payload', () => {
    expect(planFingerprint([mapped('Standard', '9990000')], ['Standard']))
      .toBe(planFingerprint([mapped('Standard', '9990000')], ['Standard']))
  })

  it('moves when a price moves', () => {
    expect(planFingerprint([mapped('Standard', '9990000')], []))
      .not.toBe(planFingerprint([mapped('Standard', '7990000')], []))
  })

  it('moves when a service is added or renamed', () => {
    const one = planFingerprint([mapped('Standard', '9990000')], [])
    expect(one).not.toBe(planFingerprint([mapped('Standard', '9990000'), mapped('Express', '1')], []))
    expect(one).not.toBe(planFingerprint([mapped('Next day', '9990000')], []))
  })

  // A service retired between the looking and the pressing changes what the
  // send DOES - it takes one away - so it has to move the fingerprint.
  it('moves when the list of services this site owns changes', () => {
    expect(planFingerprint([mapped('Standard', '9990000')], []))
      .not.toBe(planFingerprint([mapped('Standard', '9990000')], ['Retired']))
  })

  it('does not move when only the order changes', () => {
    const a = mapped('Standard', '9990000')
    const b = mapped('Express', '1490000')
    expect(planFingerprint([a, b], ['x', 'y'])).toBe(planFingerprint([b, a], ['y', 'x']))
  })

  // The preview's sentences carry counts that move on their own - a coverage
  // figure changes when somebody adds a product. Refusing a send over that
  // would be a brake nobody could release.
  it('does not move when only the preview wording changes', () => {
    expect(planFingerprint([mapped('Standard', '9990000', 'one wording')], []))
      .toBe(planFingerprint([mapped('Standard', '9990000', 'quite another')], []))
  })

  it('is short enough to put in a request body', () => {
    expect(planFingerprint([mapped('Standard', '9990000')], [])).toHaveLength(16)
  })
})
