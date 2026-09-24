import { describe, it, expect } from 'vitest'
import { parseBrandRow, parseClusterRow } from '@/modules/google-shopping-for-shop/lib/best-sellers/parse'
import { catalogueVerdict } from '@/modules/google-shopping-for-shop/lib/best-sellers/types'

const cluster = {
  reportDate: { year: 2026, month: 9, day: 14 },
  reportGranularity: 'WEEKLY',
  reportCountryCode: 'gb',
  reportCategoryId: '436',
  rank: '3',
  previousRank: '7',
  title: 'Herman Miller Aeron Chair',
  brand: 'Herman Miller',
  categoryL1: 'Furniture',
  categoryL2: 'Office Furniture',
  categoryL3: 'Office Chairs',
  relativeDemand: 'VERY_HIGH',
  previousRelativeDemand: 'HIGH',
  relativeDemandChange: 'RISER',
  inventoryStatus: 'IN_STOCK',
  brandInventoryStatus: 'IN_STOCK',
  variantGtins: ['5012345678900', ' 5012345678917 ', 'not-a-barcode', 42],
}

describe('parseClusterRow', () => {
  it('reads a ranking row whole', () => {
    expect(parseClusterRow({ bestSellersProductClusterView: cluster })).toEqual({
      kind: 'cluster',
      reportDate: '2026-09-14',
      granularity: 'WEEKLY',
      countryCode: 'GB',
      categoryId: '436',
      rank: 3,
      previousRank: 7,
      title: 'Herman Miller Aeron Chair',
      brand: 'Herman Miller',
      categoryPath: 'Furniture > Office Furniture > Office Chairs',
      relativeDemand: 'very-high',
      previousRelativeDemand: 'high',
      demandChange: 'riser',
      inventoryStatus: 'in-stock',
      brandInventoryStatus: 'in-stock',
      variantGtins: ['5012345678900', '5012345678917'],
    })
  })

  it('drops a row with no key rather than filing it under a made-up one', () => {
    expect(parseClusterRow({ bestSellersProductClusterView: { ...cluster, rank: undefined } })).toBeNull()
    expect(parseClusterRow({ bestSellersProductClusterView: { ...cluster, reportCategoryId: 'Office Chairs' } })).toBeNull()
    expect(parseClusterRow({ bestSellersProductClusterView: { ...cluster, reportDate: undefined } })).toBeNull()
    expect(parseClusterRow({})).toBeNull()
  })

  it('leaves previousRank null for something new to the list', () => {
    const row = parseClusterRow({ bestSellersProductClusterView: { ...cluster, previousRank: undefined } })
    expect(row?.previousRank).toBeNull()
  })

  it('calls an enum it has never seen "unknown" rather than guessing', () => {
    const row = parseClusterRow({
      bestSellersProductClusterView: { ...cluster, relativeDemand: 'ASTRONOMICAL', inventoryStatus: 'BACKORDER' },
    })
    expect(row?.relativeDemand).toBe('unknown')
    expect(row?.inventoryStatus).toBe('unknown')
  })

  it('has no category path when Google sent no levels', () => {
    const row = parseClusterRow({
      bestSellersProductClusterView: { ...cluster, categoryL1: undefined, categoryL2: undefined, categoryL3: undefined },
    })
    expect(row?.categoryPath).toBeNull()
  })
})

describe('parseBrandRow', () => {
  it('reads a brand row, with everything a brand has no answer for left blank', () => {
    const row = parseBrandRow({
      bestSellersBrandView: {
        reportDate: { year: 2026, month: 9, day: 1 },
        reportGranularity: 'MONTHLY',
        reportCountryCode: 'GB',
        reportCategoryId: '436',
        rank: '1',
        previousRank: '1',
        brand: 'Herman Miller',
        relativeDemand: 'VERY_HIGH',
        previousRelativeDemand: 'VERY_HIGH',
        relativeDemandChange: 'FLAT',
      },
    })
    expect(row?.kind).toBe('brand')
    expect(row?.granularity).toBe('MONTHLY')
    expect(row?.title).toBeNull()
    expect(row?.categoryPath).toBeNull()
    expect(row?.variantGtins).toEqual([])
    // No inventory status on the brand report, so "not known" rather than a no.
    expect(row?.inventoryStatus).toBe('unknown')
  })
})

describe('catalogueVerdict', () => {
  it('lets a barcode match win outright - it is the only answer that names a product', () => {
    expect(catalogueVerdict({ matchedProductId: 'p1', inventoryStatus: 'not-in-inventory' })).toBe('matched')
  })

  it('falls back to Google saying it is in the data source', () => {
    expect(catalogueVerdict({ matchedProductId: null, inventoryStatus: 'in-stock' })).toBe('google')
    expect(catalogueVerdict({ matchedProductId: null, inventoryStatus: 'out-of-stock' })).toBe('google')
  })

  it('says no only when Google said no', () => {
    expect(catalogueVerdict({ matchedProductId: null, inventoryStatus: 'not-in-inventory' })).toBe('no')
  })

  it('says "not known" rather than no when nothing could answer', () => {
    expect(catalogueVerdict({ matchedProductId: null, inventoryStatus: 'unknown' })).toBe('unknown')
  })
})
