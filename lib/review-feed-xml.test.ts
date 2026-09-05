import { describe, it, expect } from 'vitest'
import { buildReviewFeedXml, type ReviewFeedItem } from '@/modules/google-shopping-for-shop/lib/review-feed-xml'

const publisher = { name: 'Test Shop', faviconUrl: 'https://example.test/icon-32.png' }

const baseReview: ReviewFeedItem = {
  id: 'review-1',
  authorName: 'Jane B',
  timestamp: '2026-03-01T09:30:00.000Z',
  title: 'Very good desk',
  content: 'Solid, arrived on time, would buy again.',
  url: 'https://example.test/shop/products/oslo-desk',
  urlType: 'group',
  rating: 5,
  ratingMin: 1,
  ratingMax: 5,
  products: [{
    url: 'https://example.test/shop/products/oslo-desk',
    name: 'Oslo Desk',
    gtins: ['5012345678900'],
    brands: ['Nordic'],
  }],
  collectionMethod: 'post_fulfillment',
  transactionId: 'DW000123',
}

describe('buildReviewFeedXml', () => {
  it('declares version 2.3 and the schema location', () => {
    const xml = buildReviewFeedXml(publisher, [baseReview])
    expect(xml).toContain('<version>2.3</version>')
    expect(xml).toContain('product_reviews.xsd')
  })

  it('keeps the schema\'s element order within a review', () => {
    const xml = buildReviewFeedXml(publisher, [baseReview])
    const order = ['<review_id>', '<reviewer>', '<review_timestamp>', '<title>', '<content>', '<review_url', '<ratings>', '<products>', '<is_spam>', '<collection_method>', '<transaction_id>']
    const positions = order.map((tag) => xml.indexOf(tag))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('renders the rating with its scale', () => {
    const xml = buildReviewFeedXml(publisher, [baseReview])
    expect(xml).toContain('<overall min="1" max="5">5</overall>')
  })

  it('gives a decimal rating one place, never a float tail', () => {
    const xml = buildReviewFeedXml(publisher, [{ ...baseReview, rating: 4.199999999999999 }])
    expect(xml).toContain('>4.2</overall>')
  })

  it('marks a nameless reviewer anonymous rather than inventing a name', () => {
    const xml = buildReviewFeedXml(publisher, [{ ...baseReview, authorName: '   ' }])
    expect(xml).toContain('<name is_anonymous="true">Anonymous</name>')
  })

  it('escapes what a reviewer typed', () => {
    const xml = buildReviewFeedXml(publisher, [{ ...baseReview, content: 'Tom & Jerry <b>desk</b>' }])
    expect(xml).toContain('Tom &amp; Jerry &lt;b&gt;desk&lt;/b&gt;')
    expect(xml).not.toContain('<b>desk</b>')
  })

  it('strips control characters that would break the whole document', () => {
    const xml = buildReviewFeedXml(publisher, [{ ...baseReview, content: 'Good\u0007 desk\u0000' }])
    expect(xml).not.toMatch(/[\u0000-\u0008]/)
    expect(xml).toContain('Good')
  })

  it('leaves out an empty title rather than writing an empty element', () => {
    const xml = buildReviewFeedXml(publisher, [{ ...baseReview, title: '   ' }])
    expect(xml).not.toContain('<title>')
  })

  it('leaves out identifier containers the shop knows nothing for', () => {
    const xml = buildReviewFeedXml(publisher, [{
      ...baseReview,
      products: [{ url: 'https://example.test/shop/products/oslo-desk', name: 'Oslo Desk' }],
    }])
    expect(xml).not.toContain('<product_ids>')
    expect(xml).not.toContain('<gtins>')
  })

  it('omits the reviews container entirely when there is nothing published', () => {
    const xml = buildReviewFeedXml(publisher, [])
    expect(xml).not.toContain('<reviews>')
    expect(xml).toContain('<publisher>')
  })

  it('leaves the favicon off when the site has none', () => {
    const xml = buildReviewFeedXml({ name: 'Test Shop' }, [baseReview])
    expect(xml).not.toContain('<favicon>')
    expect(xml).toContain('<name>Test Shop</name>')
  })

  it('says how each review was collected', () => {
    const xml = buildReviewFeedXml(publisher, [{ ...baseReview, collectionMethod: 'unsolicited' }])
    expect(xml).toContain('<collection_method>unsolicited</collection_method>')
  })
})
