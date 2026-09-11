import { describe, it, expect } from 'vitest'
import { buildPromotionsXml, type FeedPromotion } from '@/modules/google-shopping-for-shop/lib/promotions-xml'

const promotion = (over: Partial<FeedPromotion> = {}): FeedPromotion => ({
  id: 'osd-verco-abcd-4000',
  longTitle: '£40 off when you spend £420 or more',
  moneyOff: 40,
  minimumPurchase: 420,
  currency: 'GBP',
  startsAt: new Date('2026-09-11T09:00:00.000Z'),
  endsAt: new Date('2027-03-10T09:00:00.000Z'),
  ...over,
})

const channel = { title: 'Promotions', link: 'https://example.test', description: 'Promotions' }

describe('buildPromotionsXml', () => {
  it('renders the attributes Google requires', () => {
    const xml = buildPromotionsXml(channel, [promotion()])
    expect(xml).toContain('<g:promotion_id>osd-verco-abcd-4000</g:promotion_id>')
    expect(xml).toContain('<g:product_applicability>specific_products</g:product_applicability>')
    expect(xml).toContain('<g:offer_type>no_code</g:offer_type>')
    expect(xml).toContain('<g:redemption_channel>online</g:redemption_channel>')
    expect(xml).toContain('<g:coupon_value_type>money_off</g:coupon_value_type>')
    expect(xml).toContain('<g:promotion_destination>shopping_ads</g:promotion_destination>')
    expect(xml).toContain('<g:promotion_destination>free_listings</g:promotion_destination>')
  })

  it('writes money the way the product source does, number first', () => {
    const xml = buildPromotionsXml(channel, [promotion()])
    expect(xml).toContain('<g:money_off_amount>40.00 GBP</g:money_off_amount>')
    expect(xml).toContain('<g:minimum_purchase_amount>420.00 GBP</g:minimum_purchase_amount>')
  })

  it('writes the window as one slash-separated pair with an explicit offset', () => {
    const xml = buildPromotionsXml(channel, [promotion()])
    expect(xml).toContain(
      '<g:promotion_effective_dates>2026-09-11T09:00:00+00:00/2027-03-10T09:00:00+00:00</g:promotion_effective_dates>',
    )
  })

  it('stays inside the window Google allows', () => {
    const p = promotion()
    const days = (p.endsAt.getTime() - p.startsAt.getTime()) / 86_400_000
    expect(days).toBeLessThanOrEqual(183)
  })

  it('cuts a title to sixty characters and terms to five hundred', () => {
    const xml = buildPromotionsXml(channel, [promotion({
      longTitle: 'x'.repeat(200),
      finePrint: 'y'.repeat(900),
    })])
    expect(xml).toContain(`<g:long_title>${'x'.repeat(60)}</g:long_title>`)
    expect(xml).toContain(`<g:fine_print>${'y'.repeat(500)}</g:fine_print>`)
  })

  it('leaves the terms out entirely when there are none', () => {
    expect(buildPromotionsXml(channel, [promotion()])).not.toContain('<g:fine_print>')
  })

  it('escapes a supplier name that would otherwise break the document', () => {
    const xml = buildPromotionsXml(channel, [promotion({ finePrint: 'Marks & Spencer <only>' })])
    expect(xml).toContain('Marks &amp; Spencer &lt;only&gt;')
  })

  it('serves an empty source rather than a broken one when nothing qualifies', () => {
    const xml = buildPromotionsXml(channel, [])
    expect(xml).toContain('<channel>')
    expect(xml).not.toContain('<item>')
  })
})
