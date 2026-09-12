// The one rule the feed applies to its own output before publishing it.
//
// Worth pinning down because the failure it prevents is invisible from here:
// an item with no picture is accepted by the XML builder, accepted by every
// check in this repo, fetched happily by Google, and then rejected - and the
// only place that shows up is a Merchant Center screen the owner may never open.
import { describe, it, expect } from 'vitest'
import { partitionPublishable } from '@/modules/google-shopping-for-shop/lib/withholding'
import type { FeedItem } from '@/modules/google-shopping-for-shop/lib/feed-xml'

const item = (id: string, imageLinks: string[]): FeedItem => ({
  id,
  title: `Product ${id}`,
  description: 'd',
  link: 'https://example.test/p',
  imageLinks,
  availability: 'in_stock',
  price: 10,
  currency: 'GBP',
  identifierExists: true,
  condition: 'new',
} as unknown as FeedItem)

describe('partitionPublishable', () => {
  it('publishes an item with a picture', () => {
    const { publishable, withheld } = partitionPublishable([item('a', ['https://cdn.test/a.webp'])])
    expect(publishable.map((i) => i.id)).toEqual(['a'])
    expect(withheld).toEqual([])
  })

  it('withholds an item with no picture at all, and says which it was', () => {
    const { publishable, withheld } = partitionPublishable([item('a', [])])
    expect(publishable).toEqual([])
    expect(withheld).toEqual([{ id: 'a', title: 'Product a', reason: 'no-image' }])
  })

  it('treats a blank url as no picture', () => {
    // imageLinks is built from media rows, and one whose url never resolved
    // arrives as an empty string - which would publish <g:image_link></g:image_link>
    // and be refused exactly like a missing one.
    const { publishable, withheld } = partitionPublishable([item('a', ['', '   '])])
    expect(publishable).toEqual([])
    expect(withheld[0]?.id).toBe('a')
  })

  it('keeps an item whose FIRST picture is blank but has a real one behind it', () => {
    // g:image_link takes the first and the rest become additional images, so
    // this one is still publishable - just not as tidy as it could be.
    const { publishable } = partitionPublishable([item('a', ['', 'https://cdn.test/a.webp'])])
    expect(publishable.map((i) => i.id)).toEqual(['a'])
  })

  it('keeps the order of what survives', () => {
    const out = partitionPublishable([
      item('a', ['https://cdn.test/a.webp']),
      item('b', []),
      item('c', ['https://cdn.test/c.webp']),
    ])
    expect(out.publishable.map((i) => i.id)).toEqual(['a', 'c'])
    expect(out.withheld.map((i) => i.id)).toEqual(['b'])
  })

  it('is happy with an empty catalogue', () => {
    expect(partitionPublishable([])).toEqual({ publishable: [], withheld: [] })
  })
})
