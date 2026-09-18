import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKBENCH_QUERY,
  isFilteredQuery,
  parseWorkbenchQuery,
  parseWorkbenchQueryObject,
  writeWorkbenchQuery,
} from '@/modules/google-shopping-for-shop/lib/workbench-query'

describe('workbench query', () => {
  it('reads an empty address as the defaults', () => {
    expect(parseWorkbenchQuery(new URLSearchParams())).toEqual(DEFAULT_WORKBENCH_QUERY)
  })

  it('round-trips through the address bar without disturbing the host page', () => {
    const query = { ...DEFAULT_WORKBENCH_QUERY, search: 'blue chair', match: 'unmatched' as const, issue: 'no-gtin' as const, brand: 'Acme', group: 'p1', sort: 'gap-desc' as const, page: 3, perPage: 100 as const }
    const params = writeWorkbenchQuery(query, new URLSearchParams('tab=google-shopping-workbench'))
    expect(params.get('tab')).toBe('google-shopping-workbench')
    expect(parseWorkbenchQuery(params)).toEqual(query)
  })

  it('leaves defaults out of the address, so links stay short', () => {
    const params = writeWorkbenchQuery(DEFAULT_WORKBENCH_QUERY, new URLSearchParams('tab=x&q=old&page=4'))
    expect(params.toString()).toBe('tab=x')
  })

  it('falls back field by field on a hand-edited link rather than failing', () => {
    const query = parseWorkbenchQuery(new URLSearchParams('match=sideways&page=-2&per=37&sort=random&q=%20desk%20'))
    expect(query.match).toBe('all')
    expect(query.page).toBe(1)
    expect(query.perPage).toBe(50)
    expect(query.sort).toBe('feed')
    expect(query.search).toBe('desk')
  })

  it('accepts a query as a bulk request body carries it, ignoring junk', () => {
    expect(parseWorkbenchQueryObject({ match: 'matched', perPage: 200, nonsense: true })).toEqual({ ...DEFAULT_WORKBENCH_QUERY, match: 'matched', perPage: 200 })
    expect(parseWorkbenchQueryObject(null)).toEqual(DEFAULT_WORKBENCH_QUERY)
  })

  it('counts filters, not preferences, as filtering', () => {
    expect(isFilteredQuery({ ...DEFAULT_WORKBENCH_QUERY, sort: 'title', perPage: 200, page: 5 })).toBe(false)
    expect(isFilteredQuery({ ...DEFAULT_WORKBENCH_QUERY, category: 'Desks' })).toBe(true)
  })
})
