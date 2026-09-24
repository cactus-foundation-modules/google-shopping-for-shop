import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKBENCH_QUERY,
  hasWorkbenchParams,
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

  it('recognises a link written before the sub-tabs existed', () => {
    // Anything the list owns means "the products tab", however stale the link.
    expect(hasWorkbenchParams(new URLSearchParams('tab=google-shopping-workbench&q=desk'))).toBe(true)
    expect(hasWorkbenchParams(new URLSearchParams('tab=google-shopping-workbench&per=200'))).toBe(true)
    expect(hasWorkbenchParams(new URLSearchParams('tab=google-shopping-workbench&listing=abc'))).toBe(true)
    // The host page's own parameter, and our own sub-tab, are not ours to claim.
    expect(hasWorkbenchParams(new URLSearchParams('tab=google-shopping-workbench'))).toBe(false)
    expect(hasWorkbenchParams(new URLSearchParams('tab=google-shopping-workbench&sub=shipping'))).toBe(false)
    expect(hasWorkbenchParams(new URLSearchParams(''))).toBe(false)
  })
})

describe('feed and rule filters in the address bar', () => {
  it('reads and writes them, leaving the defaults off', () => {
    const query = parseWorkbenchQuery(new URLSearchParams('feed=out&rule=abc'))
    expect(query.feed).toBe('out')
    expect(query.rule).toBe('abc')
    expect(isFilteredQuery(query)).toBe(true)
    const written = writeWorkbenchQuery({ ...query, feed: 'in', rule: '' }, new URLSearchParams('tab=x&feed=out&rule=abc'))
    expect(written.toString()).toBe('tab=x')
  })

  it('falls back to the feed as Google gets it for a value it does not know', () => {
    expect(parseWorkbenchQuery(new URLSearchParams('feed=sideways')).feed).toBe('in')
  })
})
