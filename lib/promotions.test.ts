import { describe, it, expect } from 'vitest'
import {
  groupPromotions,
  promotionIdFor,
  promotionTerms,
  promotionTitle,
  type PromotionCandidate,
} from '@/modules/google-shopping-for-shop/lib/promotions'

const candidate = (over: Partial<PromotionCandidate> = {}): PromotionCandidate => ({
  itemId: 'item-1',
  supplier: 'Verco',
  storedPence: 4000,
  grossDeduction: 48,
  grossThreshold: 420,
  ...over,
})

describe('promotionIdFor', () => {
  it('is stable across calls, which is the only thing joining the two sources', () => {
    expect(promotionIdFor('Verco', 4000)).toBe(promotionIdFor('Verco', 4000))
  })

  it('ignores the case and spacing of a supplier name', () => {
    expect(promotionIdFor('  verco  ', 600)).toBe(promotionIdFor('Verco', 600))
  })

  it('separates two suppliers whose names slug identically', () => {
    expect(promotionIdFor('Verco Ltd.', 600)).not.toBe(promotionIdFor('Verco, Ltd', 600))
  })

  it('separates two amounts from the same supplier', () => {
    expect(promotionIdFor('Verco', 600)).not.toBe(promotionIdFor('Verco', 4000))
  })

  it('survives a supplier name with nothing sluggable in it', () => {
    const id = promotionIdFor('***', 600)
    expect(id).toMatch(/^osd-[a-z0-9]{4}-600$/)
  })
})

describe('groupPromotions', () => {
  it('makes one promotion per supplier and amount', () => {
    const { promotions, promotionIdByItem } = groupPromotions([
      candidate({ itemId: 'a', storedPence: 4000, grossDeduction: 48 }),
      candidate({ itemId: 'b', storedPence: 4000, grossDeduction: 48 }),
      candidate({ itemId: 'c', storedPence: 600, grossDeduction: 7.2 }),
      candidate({ itemId: 'd', supplier: 'Elite', storedPence: 600, grossDeduction: 7.2, grossThreshold: 300 }),
    ])
    expect(promotions).toHaveLength(3)
    expect(promotionIdByItem.get('a')).toBe(promotionIdByItem.get('b'))
    expect(promotionIdByItem.get('a')).not.toBe(promotionIdByItem.get('c'))
    expect(promotionIdByItem.get('c')).not.toBe(promotionIdByItem.get('d'))
  })

  it('under-promises across a group taxed at two rates', () => {
    const { promotions } = groupPromotions([
      candidate({ itemId: 'a', grossDeduction: 48, grossThreshold: 420 }),
      candidate({ itemId: 'b', grossDeduction: 40, grossThreshold: 350 }),
    ])
    expect(promotions).toHaveLength(1)
    // The smallest discount anybody gets, against the highest bar anybody has.
    expect(promotions[0]?.moneyOff).toBe(40)
    expect(promotions[0]?.minimumPurchase).toBe(420)
  })

  it('drops a candidate with no usable figures rather than advertising nothing off', () => {
    const { promotions, promotionIdByItem } = groupPromotions([
      candidate({ itemId: 'a', grossDeduction: 0 }),
      candidate({ itemId: 'b', grossThreshold: 0 }),
      candidate({ itemId: 'c', grossDeduction: Number.NaN }),
    ])
    expect(promotions).toEqual([])
    expect(promotionIdByItem.size).toBe(0)
  })

  it('orders promotions the same way every run', () => {
    const one = groupPromotions([candidate({ itemId: 'a', supplier: 'Zed' }), candidate({ itemId: 'b', supplier: 'Ash' })])
    const two = groupPromotions([candidate({ itemId: 'b', supplier: 'Ash' }), candidate({ itemId: 'a', supplier: 'Zed' })])
    expect(one.promotions.map((p) => p.id)).toEqual(two.promotions.map((p) => p.id))
  })
})

describe('the copy', () => {
  const promotion = { id: 'osd-verco-abcd-4000', moneyOff: 40, minimumPurchase: 420 }

  it('fits a title inside Google\'s sixty characters', () => {
    expect(promotionTitle(promotion, '£').length).toBeLessThanOrEqual(60)
    expect(promotionTitle(promotion, '£')).toBe('£40 off when you spend £420 or more')
  })

  it('drops the pennies only where there are none', () => {
    expect(promotionTitle({ ...promotion, moneyOff: 6.5 }, '£')).toContain('£6.50')
  })

  it('says the two things Google cannot express', () => {
    const terms = promotionTerms(promotion, '£')
    expect(terms).toContain('comes off each of these products')
    expect(terms).toContain('these products only')
    expect(terms).toContain('delivery does not count')
  })

  it('puts the owner\'s own wording after the conditions, never in front', () => {
    const terms = promotionTerms(promotion, '£', '  Trade accounts excluded.  ')
    expect(terms.endsWith('Trade accounts excluded.')).toBe(true)
    expect(terms.startsWith('£40 comes off')).toBe(true)
  })
})
