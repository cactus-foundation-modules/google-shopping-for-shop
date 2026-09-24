import { describe, it, expect } from 'vitest'
import { productSlugFromPath } from '@/modules/google-shopping-for-shop/lib/click-tracking/resolve'

describe('productSlugFromPath', () => {
  it('reads a root-style product address', () => {
    expect(productSlugFromPath('/a-desk', 'ROOT')).toBe('a-desk')
    expect(productSlugFromPath('/a-desk/', 'ROOT')).toBe('a-desk')
  })

  it('reads a shop-style product address', () => {
    expect(productSlugFromPath('/shop/products/a-desk', 'SHOP')).toBe('a-desk')
    expect(productSlugFromPath('/shop/products/a-desk/', 'SHOP')).toBe('a-desk')
  })

  it('refuses the other style, so a landing is never filed under a slug from the wrong shape', () => {
    expect(productSlugFromPath('/shop/products/a-desk', 'ROOT')).toBeNull()
    expect(productSlugFromPath('/a-desk', 'SHOP')).toBeNull()
  })

  it('refuses anything that is not one segment deep', () => {
    for (const path of ['/', '/shop/categories/desks', '/a/b', '/shop/products', '/shop/products/a/b']) {
      expect(productSlugFromPath(path, 'ROOT'), path).toBeNull()
    }
    expect(productSlugFromPath('/', 'SHOP')).toBeNull()
  })

  it('leaves "is this actually a product?" to the database, not to a path test', () => {
    // On a root-style shop every single-segment address LOOKS like a product
    // slug - '/about' and '/shop' included - and no amount of pattern matching
    // here can tell them apart. The lookup does, and an address that names no
    // product records nothing.
    expect(productSlugFromPath('/shop', 'ROOT')).toBe('shop')
    expect(productSlugFromPath('/about', 'ROOT')).toBe('about')
  })

  it('ignores a query string or a fragment the caller left on', () => {
    expect(productSlugFromPath('/a-desk?colour=black', 'ROOT')).toBe('a-desk')
    expect(productSlugFromPath('/a-desk#spec', 'ROOT')).toBe('a-desk')
  })

  it('decodes an escaped slug and refuses a broken escape', () => {
    expect(productSlugFromPath('/caf%C3%A9-table', 'ROOT')).toBe('café-table')
    expect(productSlugFromPath('/%E0%A4%A', 'ROOT')).toBeNull()
  })

  it('refuses a slug nobody could have published', () => {
    expect(productSlugFromPath(`/${'a'.repeat(300)}`, 'ROOT')).toBeNull()
  })
})
