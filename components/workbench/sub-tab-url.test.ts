import { describe, expect, it } from 'vitest'
import { subTabFromParams, subTabParamValue } from '@/modules/google-shopping-for-shop/components/workbench/sub-tab-url'

const open = (search: string) => subTabFromParams(new URLSearchParams(search))

describe('workbench sub-tab in the URL', () => {
  it('opens Reports on a bare link', () => {
    expect(open('tab=google-shopping-workbench')).toBe('reports')
  })

  it('opens whichever tab the link names', () => {
    expect(open('tab=google-shopping-workbench&sub=shipping')).toBe('shipping')
    expect(open('tab=google-shopping-workbench&sub=feed-rules')).toBe('feed-rules')
  })

  it('opens Products for a link saved before the sub-tabs existed', () => {
    expect(open('tab=google-shopping-workbench&q=desk&per=200')).toBe('products')
  })

  it('keeps Reports after a refresh even with Products filters still in the address bar', () => {
    // Filters set on Products, then Reports clicked: sub is written explicitly,
    // so the leftover q/per no longer drag a refresh back to Products.
    expect(open(`tab=google-shopping-workbench&q=desk&per=200&sub=${subTabParamValue('reports')}`)).toBe('reports')
  })

  it('treats an unrecognised sub as the default, not as an old link', () => {
    expect(open('tab=google-shopping-workbench&sub=nonsense&q=desk')).toBe('reports')
  })

  it('always writes the tab, Reports included', () => {
    expect(subTabParamValue('reports')).toBe('reports')
    expect(subTabParamValue('products')).toBe('products')
  })
})
