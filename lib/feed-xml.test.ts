import { describe, it, expect } from 'vitest'
import { buildFeedXml, mapVariantAxes, normaliseGtin, type FeedItem } from '@/modules/google-shopping-for-shop/lib/feed-xml'

const baseItem: FeedItem = {
  id: 'child-1',
  itemGroupId: 'parent-1',
  title: 'Oslo Desk - Oak / 1200mm',
  description: 'A desk.',
  link: 'https://example.test/shop/products/oslo-desk-oak-1200',
  imageLinks: ['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg'],
  availability: 'in_stock',
  price: 299.99,
  currency: 'GBP',
  brand: 'Deskwell',
  identifierExists: true,
  condition: 'new',
}

describe('buildFeedXml', () => {
  it('renders the g: namespace item with grouped id and money format', () => {
    const xml = buildFeedXml({ title: 'Feed', link: 'https://example.test', description: 'd' }, [baseItem])
    expect(xml).toContain('xmlns:g="http://base.google.com/ns/1.0"')
    expect(xml).toContain('<g:id>child-1</g:id>')
    expect(xml).toContain('<g:item_group_id>parent-1</g:item_group_id>')
    expect(xml).toContain('<g:price>299.99 GBP</g:price>')
    expect(xml).toContain('<g:availability>in stock</g:availability>')
    expect(xml).toContain('<g:image_link>https://cdn.test/a.jpg</g:image_link>')
    expect(xml).toContain('<g:additional_image_link>https://cdn.test/b.jpg</g:additional_image_link>')
    expect(xml).not.toContain('<g:identifier_exists>')
    expect(xml).not.toContain('<g:sale_price>')
  })

  it('escapes XML entities everywhere a value lands', () => {
    const xml = buildFeedXml({ title: 'Feed', link: 'https://example.test', description: 'd' }, [
      { ...baseItem, title: 'Desk & Chair <"Bundle">', productType: "Office > Desks & 'Tables'" },
    ])
    expect(xml).toContain('Desk &amp; Chair &lt;&quot;Bundle&quot;&gt;')
    expect(xml).toContain('<g:product_type>Office &gt; Desks &amp; &apos;Tables&apos;</g:product_type>')
    expect(xml).not.toContain('<"')
  })

  it('marks items without identifiers and keeps sale price when given', () => {
    const xml = buildFeedXml({ title: 'Feed', link: 'https://example.test', description: 'd' }, [
      { ...baseItem, identifierExists: false, brand: undefined, salePrice: 249.5 },
    ])
    expect(xml).toContain('<g:identifier_exists>no</g:identifier_exists>')
    expect(xml).toContain('<g:sale_price>249.50 GBP</g:sale_price>')
    expect(xml).not.toContain('<g:brand>')
  })

  it('clips a runaway title on a word inside the 150-character limit', () => {
    const xml = buildFeedXml({ title: 'Feed', link: 'https://example.test', description: 'd' }, [
      { ...baseItem, title: `${'Very '.repeat(40)}Long Desk` },
    ])
    const title = /<g:title>([^<]*)<\/g:title>/.exec(xml)?.[1] ?? ''
    expect(title.length).toBeLessThanOrEqual(150)
    expect(title.endsWith('Very')).toBe(true)
  })

  it('renders handling and transit times as both ends of a range', () => {
    const xml = buildFeedXml({ title: 'Feed', link: 'https://example.test', description: 'd' }, [
      { ...baseItem, minHandlingTime: 2, maxHandlingTime: 2, minTransitTime: 5, maxTransitTime: 5 },
    ])
    expect(xml).toContain('<g:min_handling_time>2</g:min_handling_time>')
    expect(xml).toContain('<g:max_handling_time>2</g:max_handling_time>')
    expect(xml).toContain('<g:min_transit_time>5</g:min_transit_time>')
    expect(xml).toContain('<g:max_transit_time>5</g:max_transit_time>')
  })

  it('renders a zero handling time rather than dropping it', () => {
    const xml = buildFeedXml({ title: 'Feed', link: 'https://example.test', description: 'd' }, [
      { ...baseItem, minHandlingTime: 0, maxHandlingTime: 0, minTransitTime: 3, maxTransitTime: 3 },
    ])
    expect(xml).toContain('<g:min_handling_time>0</g:min_handling_time>')
    expect(xml).toContain('<g:max_handling_time>0</g:max_handling_time>')
  })

  it('omits a half-stated range entirely', () => {
    const xml = buildFeedXml({ title: 'Feed', link: 'https://example.test', description: 'd' }, [
      { ...baseItem, minHandlingTime: 2, minTransitTime: 5, maxTransitTime: 5 },
    ])
    expect(xml).not.toContain('<g:min_handling_time>')
    expect(xml).not.toContain('<g:max_handling_time>')
    expect(xml).toContain('<g:min_transit_time>5</g:min_transit_time>')
  })

  it('omits every shipping time when the shop cannot put one on the product', () => {
    const xml = buildFeedXml({ title: 'Feed', link: 'https://example.test', description: 'd' }, [baseItem])
    expect(xml).not.toContain('<g:min_handling_time>')
    expect(xml).not.toContain('<g:min_transit_time>')
    expect(xml).not.toContain('<g:availability_date>')
  })

  it('carries an availability date on pre-order and backorder only', () => {
    const withDate = { ...baseItem, availabilityDate: '2026-09-01T00:00:00.000Z' }
    for (const availability of ['preorder', 'backorder'] as const) {
      const xml = buildFeedXml({ title: 'Feed', link: 'https://example.test', description: 'd' }, [
        { ...withDate, availability },
      ])
      expect(xml).toContain('<g:availability_date>2026-09-01T00:00:00.000Z</g:availability_date>')
    }
    const inStock = buildFeedXml({ title: 'Feed', link: 'https://example.test', description: 'd' }, [withDate])
    expect(inStock).not.toContain('<g:availability_date>')
  })

  it('caps additional images at ten', () => {
    const links = Array.from({ length: 15 }, (_, i) => `https://cdn.test/${i}.jpg`)
    const xml = buildFeedXml({ title: 'Feed', link: 'https://example.test', description: 'd' }, [
      { ...baseItem, imageLinks: links },
    ])
    expect(xml.match(/<g:additional_image_link>/g)?.length).toBe(10)
  })

  it('renders one shipping group per delivery service, free included', () => {
    const xml = buildFeedXml({ title: 'Feed', link: 'https://example.test', description: 'd' }, [
      {
        ...baseItem,
        shippingGroups: [
          { country: 'GB', service: 'Flat-Pack', price: 0, minHandlingTime: 1, maxHandlingTime: 1, minTransitTime: 5, maxTransitTime: 5 },
          { country: 'GB', service: 'Express Flat-Pack', price: 21, minHandlingTime: 1, maxHandlingTime: 1, minTransitTime: 1, maxTransitTime: 1 },
        ],
      },
    ])
    expect(xml.match(/<g:shipping>/g)?.length).toBe(2)
    expect(xml).toContain('<g:shipping><g:country>GB</g:country><g:service>Flat-Pack</g:service><g:price>0.00 GBP</g:price><g:min_handling_time>1</g:min_handling_time><g:max_handling_time>1</g:max_handling_time><g:min_transit_time>5</g:min_transit_time><g:max_transit_time>5</g:max_transit_time></g:shipping>')
    expect(xml).toContain('<g:service>Express Flat-Pack</g:service><g:price>21.00 GBP</g:price>')
  })

  it('escapes a service name and upper-cases the country', () => {
    const xml = buildFeedXml({ title: 'Feed', link: 'https://example.test', description: 'd' }, [
      { ...baseItem, shippingGroups: [{ country: 'gb', service: 'Delivery & Assembly', price: 62.28 }] },
    ])
    expect(xml).toContain('<g:country>GB</g:country><g:service>Delivery &amp; Assembly</g:service><g:price>62.28 GBP</g:price>')
    // No day counts on the group: it falls back to the item-level pair.
    expect(xml).not.toContain('<g:price>62.28 GBP</g:price><g:min_handling_time>')
  })

  it('drops a group Google would reject rather than the whole item', () => {
    const xml = buildFeedXml({ title: 'Feed', link: 'https://example.test', description: 'd' }, [
      {
        ...baseItem,
        shippingGroups: [
          { country: 'GBR', service: 'Bad country', price: 5 },
          { country: 'GB', service: '  ', price: 5 },
          { country: 'GB', service: 'Negative', price: -1 },
          { country: 'GB', service: 'Installation', price: 26 },
        ],
      },
    ])
    expect(xml.match(/<g:shipping>/g)?.length).toBe(1)
    expect(xml).toContain('<g:service>Installation</g:service>')
  })

  it('leaves shipping groups off entirely when there are none', () => {
    const xml = buildFeedXml({ title: 'Feed', link: 'https://example.test', description: 'd' }, [baseItem])
    expect(xml).not.toContain('<g:shipping>')
  })
})

describe('mapVariantAxes', () => {
  it('sorts furniture options onto Google axes, first match winning', () => {
    const axes = mapVariantAxes([
      { name: 'Seat Colour', value: 'Stevia Blue' },
      { name: 'Frame Colour', value: 'Black' },
      { name: 'Width', value: '1200mm' },
      { name: 'Depth', value: '800mm' },
      { name: 'Finish', value: 'Oak' },
    ])
    expect(axes.color).toBe('Stevia Blue')
    expect(axes.size).toBe('1200mm x 800mm')
    expect(axes.material).toBe('Oak')
    expect(axes.pattern).toBeUndefined()
  })

  it('leaves unmatched options off the axes entirely', () => {
    const axes = mapVariantAxes([{ name: 'Back Style', value: 'Mesh' }, { name: 'Pedestal Facing', value: 'Left' }])
    expect(axes).toEqual({})
  })

  it('ignores blank values', () => {
    expect(mapVariantAxes([{ name: 'Colour', value: '  ' }])).toEqual({})
  })
})

describe('normaliseGtin', () => {
  it('accepts 8, 12, 13 and 14 digit codes, stripping separators', () => {
    expect(normaliseGtin('5060540250124')).toBe('5060540250124')
    expect(normaliseGtin('5060-5402 50124')).toBe('5060540250124')
    expect(normaliseGtin('12345678')).toBe('12345678')
  })

  it('rejects supplier codes that are not GTINs', () => {
    expect(normaliseGtin('OSL-1200-OAK')).toBeNull()
    expect(normaliseGtin('12345')).toBeNull()
    expect(normaliseGtin('')).toBeNull()
    expect(normaliseGtin(null)).toBeNull()
  })
})
