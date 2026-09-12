import { describe, it, expect } from 'vitest'
import { identifiersOf } from '@/modules/google-shopping-for-shop/lib/identifiers'

const NO_DATA = { brand: null, gtin: null, mpn: null }
const NO_BRAND = { supplier: null, defaultBrand: null, useSupplier: false }
const OFF = { standalone: true, mpnFromSku: false }

describe('identifiersOf', () => {
  it('leaves the part number off while the setting is off', () => {
    const out = identifiersOf(NO_DATA, NO_BRAND, { barcode: null, sku: 'KCUP4449' }, OFF)
    expect(out.mpn).toBeUndefined()
  })

  it('publishes a standalone product’s own code as the part number', () => {
    const out = identifiersOf(NO_DATA, NO_BRAND, { barcode: null, sku: 'KCUP4449' }, { standalone: true, mpnFromSku: true })
    expect(out.mpn).toBe('KCUP4449')
  })

  it('publishes a variation’s own code, which the old rule refused', () => {
    const out = identifiersOf(NO_DATA, NO_BRAND, { barcode: null, sku: 'BR000321' }, { standalone: false, mpnFromSku: true })
    expect(out.mpn).toBe('BR000321')
  })

  it('still refuses a variation its parent’s typed-in part number', () => {
    const out = identifiersOf({ brand: null, gtin: null, mpn: 'PARENT-MPN' }, NO_BRAND, { barcode: null, sku: null }, { standalone: false, mpnFromSku: true })
    expect(out.mpn).toBeUndefined()
  })

  it('lets a typed-in part number outrank the product code', () => {
    const out = identifiersOf({ brand: null, gtin: null, mpn: 'TYPED' }, NO_BRAND, { barcode: null, sku: 'KCUP4449' }, { standalone: true, mpnFromSku: true })
    expect(out.mpn).toBe('TYPED')
  })

  it('treats a blank or whitespace code as no code at all', () => {
    const out = identifiersOf(NO_DATA, NO_BRAND, { barcode: null, sku: '   ' }, { standalone: true, mpnFromSku: true })
    expect(out.mpn).toBeUndefined()
    expect(out.identifierExists).toBe(false)
  })

  it('counts brand plus part number as an identity, so identifier_exists is not sent', () => {
    const out = identifiersOf(NO_DATA, { supplier: 'Dynamic', defaultBrand: null, useSupplier: true }, { barcode: null, sku: 'KCUP4449' }, { standalone: false, mpnFromSku: true })
    expect(out.brand).toBe('Dynamic')
    expect(out.identifierExists).toBe(true)
  })

  it('leaves the barcode in charge of the GTIN either way', () => {
    const out = identifiersOf(NO_DATA, NO_BRAND, { barcode: '5056833358127', sku: 'BR000321' }, { standalone: false, mpnFromSku: true })
    expect(out.gtin).toBe('5056833358127')
  })
})
