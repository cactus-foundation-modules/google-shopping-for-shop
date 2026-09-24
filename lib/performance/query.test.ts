import { describe, it, expect } from 'vitest'
import { performanceQuery } from '@/modules/google-shopping-for-shop/lib/performance/query'

// The rules being held to here are Google's own, quoted in the file under
// test. None of them is enforced by anything that runs before a real request.
describe('performanceQuery', () => {
  const window = { from: '2026-06-26', to: '2026-07-02' }

  it('always carries a date condition, which Google requires', () => {
    const query = performanceQuery({ ...window, withConversions: true })
    expect(query).toContain("WHERE product_performance_view.date BETWEEN '2026-06-26' AND '2026-07-02'")
  })

  it('always selects at least one metric, which Google also requires', () => {
    const query = performanceQuery({ ...window, withConversions: false })
    expect(query).toContain('product_performance_view.clicks')
    expect(query).toContain('product_performance_view.impressions')
  })

  it('selects exactly three segments and no more', () => {
    const query = performanceQuery({ ...window, withConversions: true })
    const select = query.slice('SELECT '.length, query.indexOf(' FROM '))
    const segments = select.split(', ').filter((field) => !/clicks|impressions|click_through_rate|conversions|conversion_value/.test(field))
    expect(segments).toEqual([
      'product_performance_view.date',
      'product_performance_view.offer_id',
      'product_performance_view.marketing_method',
    ])
  })

  it('never asks for the title, which would split a day across a title change', () => {
    expect(performanceQuery({ ...window, withConversions: true })).not.toContain('title')
  })

  it('leaves the conversion metrics out on the fallback query', () => {
    const full = performanceQuery({ ...window, withConversions: true })
    const short = performanceQuery({ ...window, withConversions: false })
    expect(full).toContain('product_performance_view.conversions')
    expect(full).toContain('product_performance_view.conversion_value')
    expect(short).not.toContain('conversions')
    expect(short).not.toContain('conversion_value')
  })

  it('orders by date, which is what lets a day be written as soon as it is complete', () => {
    expect(performanceQuery({ ...window, withConversions: true })).toContain('ORDER BY product_performance_view.date ASC')
  })

  it('only orders by a field it selected, which Google requires', () => {
    const query = performanceQuery({ ...window, withConversions: true })
    const ordered = query.slice(query.indexOf('ORDER BY ') + 'ORDER BY '.length).replace(' ASC', '')
    expect(query.slice(0, query.indexOf(' FROM '))).toContain(ordered)
  })

  it('refuses a date that is not one, rather than putting it into the query', () => {
    // There is no parameter binding in this query language: a value reaching
    // here becomes syntax.
    expect(() => performanceQuery({ from: "2026-01-01' OR '1'='1", to: '2026-01-02', withConversions: true })).toThrow()
    expect(() => performanceQuery({ from: '2026-1-1', to: '2026-01-02', withConversions: true })).toThrow()
    expect(() => performanceQuery({ from: '', to: '2026-01-02', withConversions: true })).toThrow()
  })
})
