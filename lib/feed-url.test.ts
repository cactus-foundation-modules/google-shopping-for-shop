import { describe, it, expect } from 'vitest'
import { feedUrl } from '@/modules/google-shopping-for-shop/lib/feed-url'

describe('the feed address', () => {
  it('composes the three sources off one path', () => {
    expect(feedUrl('https://shop.example', 'tok')).toBe('https://shop.example/google-shopping/feed.xml?key=tok')
    expect(feedUrl('https://shop.example', 'tok', 'reviews')).toBe('https://shop.example/google-shopping/feed.xml?key=tok&content=reviews')
    expect(feedUrl('https://shop.example', 'tok', 'promotions')).toBe('https://shop.example/google-shopping/feed.xml?key=tok&content=promotions')
  })

  it('does not double the slash when the site URL carries one', () => {
    expect(feedUrl('https://shop.example/', 'tok')).toBe('https://shop.example/google-shopping/feed.xml?key=tok')
  })

  it('escapes the token, which is base64url and could carry a dash or underscore', () => {
    expect(feedUrl('https://shop.example', 'a b')).toBe('https://shop.example/google-shopping/feed.xml?key=a%20b')
  })

  it('has no address at all without both halves', () => {
    expect(feedUrl(null, 'tok')).toBeNull()
    expect(feedUrl('https://shop.example', null)).toBeNull()
  })
})
