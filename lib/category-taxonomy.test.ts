import { describe, it, expect } from 'vitest'
import { googleCategoryResolver, taxonomyRows } from '@/modules/google-shopping-for-shop/lib/category-taxonomy'

// Root > Seating > Office Chairs, plus an unrelated root.
const CATEGORIES = [
  { id: 'furniture', name: 'Furniture', parentId: null },
  { id: 'seating', name: 'Seating', parentId: 'furniture' },
  { id: 'office-chairs', name: 'Office Chairs', parentId: 'seating' },
  { id: 'stationery', name: 'Stationery', parentId: null },
]

describe('googleCategoryResolver', () => {
  it('answers with a category’s own value', () => {
    const resolve = googleCategoryResolver(CATEGORIES, new Map([['office-chairs', '436']]))
    expect(resolve('office-chairs')).toBe('436')
  })

  it('inherits from the nearest mapped ancestor', () => {
    const resolve = googleCategoryResolver(CATEGORIES, new Map([['furniture', 'Furniture']]))
    expect(resolve('office-chairs')).toBe('Furniture')
  })

  it('prefers the nearer ancestor when two are mapped', () => {
    const resolve = googleCategoryResolver(CATEGORIES, new Map([['furniture', 'Furniture'], ['seating', 'Furniture > Chairs']]))
    expect(resolve('office-chairs')).toBe('Furniture > Chairs')
  })

  it('answers nothing where no ancestor is mapped', () => {
    const resolve = googleCategoryResolver(CATEGORIES, new Map([['furniture', 'Furniture']]))
    expect(resolve('stationery')).toBeUndefined()
  })

  it('answers nothing for no category and for one it has never heard of', () => {
    const resolve = googleCategoryResolver(CATEGORIES, new Map([['furniture', 'Furniture']]))
    expect(resolve(null)).toBeUndefined()
    expect(resolve('gone')).toBeUndefined()
  })

  it('survives a cycle in the parent ids rather than hanging', () => {
    const cyclic = [
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'a' },
    ]
    const resolve = googleCategoryResolver(cyclic, new Map())
    expect(resolve('a')).toBeUndefined()
  })
})

describe('taxonomyRows', () => {
  it('shows the trail, the value and what would be inherited without one', () => {
    const rows = taxonomyRows(CATEGORIES, new Map([['furniture', 'Furniture'], ['office-chairs', '436']]))
    const chairs = rows.find((r) => r.categoryId === 'office-chairs')
    const seating = rows.find((r) => r.categoryId === 'seating')
    expect(chairs?.path).toBe('Furniture > Seating > Office Chairs')
    expect(chairs?.googleProductCategory).toBe('436')
    // Its own value stands, so there is nothing to inherit.
    expect(chairs?.inherited).toBe('')
    expect(seating?.googleProductCategory).toBe('')
    expect(seating?.inherited).toBe('Furniture')
  })

  it('leaves both blank where nothing above answers either', () => {
    const rows = taxonomyRows(CATEGORIES, new Map())
    const stationery = rows.find((r) => r.categoryId === 'stationery')
    expect(stationery?.googleProductCategory).toBe('')
    expect(stationery?.inherited).toBe('')
  })
})
