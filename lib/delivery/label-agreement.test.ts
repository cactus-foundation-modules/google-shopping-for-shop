import { describe, it, expect } from 'vitest'
import { resolveDeliveryLabelAgreement } from '@/modules/google-shopping-for-shop/lib/delivery/label-agreement'
import { assignDeliveryLabels } from '@/modules/google-shopping-for-shop/lib/delivery/labels'
import type { DeliveryCatalogue, DeliveryScope } from '@/modules/google-shopping-for-shop/lib/delivery/catalogue'
import type { GsfLabelSource } from '@/modules/google-shopping-for-shop/lib/types'

const SHIPPING_ATTRIBUTE = 'e5f327c1-5201-48ac-b9ad-9d67533c19cc'

function scope(id: string, label: string, kind: DeliveryScope['kind'] = 'RANGE'): DeliveryScope {
  return { id, kind, ref: kind === 'DEFAULT' ? null : id, label }
}

function catalogue(scopes: DeliveryScope[], extra: Partial<DeliveryCatalogue> = {}): DeliveryCatalogue {
  return {
    scopeOrder: ['RANGE', 'CATEGORY', 'SUPPLIER', 'DEFAULT'],
    pricing: 'per-unit',
    scopes,
    rangeAttributeId: SHIPPING_ATTRIBUTE,
    services: [],
    dispatch: { cutoffTime: '14:30', timezone: 'Europe/London', shipDays: [1, 2, 3, 4, 5], dispatchLeadDays: 1 },
    holidays: [],
    ...extra,
  }
}

function resolve(cat: DeliveryCatalogue, source: GsfLabelSource, attributeId: string | null) {
  return resolveDeliveryLabelAgreement({
    labelSource: source,
    labelAttributeId: attributeId,
    catalogue: cat,
    labels: assignDeliveryLabels(cat.scopes),
  })
}

const RANGES = [scope('range:a', 'Orion'), scope('range:b', 'Vega')]

describe('resolveDeliveryLabelAgreement', () => {
  // (a) - unchanged. Labelling by the delivery rules agrees by construction,
  // whatever shape the scopes are and whatever attribute is sitting in the
  // other setting.
  it('agrees where the feed labels by the delivery rules themselves', () => {
    const cat = catalogue([...RANGES, scope('category:c', 'Office chairs', 'CATEGORY'), scope('default', 'Everything', 'DEFAULT')])
    expect(resolve(cat, 'delivery-services', null)).toEqual({ agreed: true, via: 'delivery-services' })
  })

  it('agrees by the delivery rules even where no attribute setting is involved at all', () => {
    expect(resolve(catalogue(RANGES, { rangeAttributeId: null }), 'delivery-services', null))
      .toEqual({ agreed: true, via: 'delivery-services' })
  })

  // (b) - the live configuration this was all about. One attribute, read twice.
  it('agrees where the feed labels by the delivery rules OWN range attribute', () => {
    expect(resolve(catalogue(RANGES), 'attribute', SHIPPING_ATTRIBUTE))
      .toEqual({ agreed: true, via: 'range-attribute' })
  })

  it('agrees on a single range too, and does not mind surrounding whitespace on either id', () => {
    expect(resolve(catalogue([scope('range:a', 'Orion')], { rangeAttributeId: ` ${SHIPPING_ATTRIBUTE} ` }), 'attribute', `${SHIPPING_ATTRIBUTE} `))
      .toEqual({ agreed: true, via: 'range-attribute' })
  })

  // The hand-kept pair of lists the block exists for.
  it('does NOT agree where the feed labels by some other attribute', () => {
    expect(resolve(catalogue(RANGES), 'attribute', 'some-other-attribute')).toEqual({ agreed: false, via: null })
  })

  it('does NOT agree where the feed labels by no attribute at all', () => {
    expect(resolve(catalogue(RANGES), 'attribute', null)).toEqual({ agreed: false, via: null })
    expect(resolve(catalogue(RANGES), 'attribute', '   ')).toEqual({ agreed: false, via: null })
  })

  // A category, a supplier or a catch-all cannot be said with a value of one
  // attribute, so the two label sets really do diverge and the block stands.
  it('does NOT agree where a category scope sits alongside the ranges', () => {
    const cat = catalogue([...RANGES, scope('category:c', 'Office chairs', 'CATEGORY')])
    expect(resolve(cat, 'attribute', SHIPPING_ATTRIBUTE)).toEqual({ agreed: false, via: null })
  })

  it('does NOT agree where a supplier scope sits alongside the ranges', () => {
    const cat = catalogue([...RANGES, scope('supplier:Furdeco', 'Furdeco', 'SUPPLIER')])
    expect(resolve(cat, 'attribute', SHIPPING_ATTRIBUTE)).toEqual({ agreed: false, via: null })
  })

  it('does NOT agree where the shop has a catch-all rule as well', () => {
    const cat = catalogue([...RANGES, scope('default', 'Everything', 'DEFAULT')])
    expect(resolve(cat, 'attribute', SHIPPING_ATTRIBUTE)).toEqual({ agreed: false, via: null })
  })

  // An older advanced-shipping publishes no range attribute. Unknown is never
  // equal, and must behave exactly as this did before it was published at all.
  it('does NOT agree where the delivery module publishes no range attribute', () => {
    expect(resolve(catalogue(RANGES, { rangeAttributeId: null }), 'attribute', SHIPPING_ATTRIBUTE))
      .toEqual({ agreed: false, via: null })
    const older = catalogue(RANGES)
    delete older.rangeAttributeId
    expect(resolve(older, 'attribute', SHIPPING_ATTRIBUTE)).toEqual({ agreed: false, via: null })
  })

  // Nothing to agree about is not agreement.
  it('does NOT agree where the catalogue has no scopes at all', () => {
    expect(resolve(catalogue([]), 'attribute', SHIPPING_ATTRIBUTE)).toEqual({ agreed: false, via: null })
  })

  // Two ranges named the same thing: this module renames one to keep the rate
  // groups apart, and the feed - reading the attribute - would send the plain
  // name for both. That is the silent mispricing, so the block stands.
  it('does NOT agree where two groups wanted the same name and one had to be qualified', () => {
    const cat = catalogue([scope('range:a', 'Orion'), scope('range:b', 'Orion')])
    expect(assignDeliveryLabels(cat.scopes).qualified).toHaveLength(1)
    expect(resolve(cat, 'attribute', SHIPPING_ATTRIBUTE)).toEqual({ agreed: false, via: null })
  })
})
