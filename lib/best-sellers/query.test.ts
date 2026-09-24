import { describe, it, expect } from 'vitest'
import { brandQuery, clusterQuery } from '@/modules/google-shopping-for-shop/lib/best-sellers/query'

const base = { granularity: 'WEEKLY', countryCode: 'GB', categoryId: '436', limit: 50 } as const

// Google's own requirements, quoted in the file under test. Nothing that runs
// before a real request enforces any of them.
describe('best sellers queries', () => {
  it('always conditions on the granularity and the country, both of which Google requires', () => {
    for (const query of [clusterQuery(base), brandQuery(base)]) {
      expect(query).toMatch(/report_granularity = 'WEEKLY'/)
      expect(query).toMatch(/report_country_code = 'GB'/)
    }
  })

  it('always selects the four fields Google requires in the SELECT clause', () => {
    for (const [query, table] of [[clusterQuery(base), 'best_sellers_product_cluster_view'], [brandQuery(base), 'best_sellers_brand_view']] as const) {
      for (const field of ['report_date', 'report_granularity', 'report_country_code', 'report_category_id']) {
        expect(query).toContain(`${table}.${field}`)
      }
    }
  })

  it('asks about one category at a time, because LIMIT applies to the whole answer', () => {
    expect(clusterQuery(base)).toContain('report_category_id = 436')
    expect(clusterQuery(base)).toContain('LIMIT 50')
  })

  it('leaves the category condition out altogether for Google’s own default', () => {
    const query = clusterQuery({ ...base, categoryId: null })
    expect(query).not.toContain('report_category_id =')
    // Still selected, because Google requires it in the SELECT clause.
    expect(query).toContain('best_sellers_product_cluster_view.report_category_id')
  })

  it('never specifies a report date, so Google gives the latest it has', () => {
    expect(clusterQuery(base)).not.toContain("report_date =")
  })

  it('only orders by a field it selected, which Google requires', () => {
    const query = clusterQuery(base)
    expect(query).toContain('ORDER BY best_sellers_product_cluster_view.rank ASC')
    expect(query.slice(0, query.indexOf(' FROM '))).toContain('best_sellers_product_cluster_view.rank')
  })

  it('refuses a value that is not what it says it is, rather than putting it into the query', () => {
    // There is no parameter binding in this query language, and the category
    // ids come from a settings box an owner types into.
    expect(() => clusterQuery({ ...base, categoryId: "436' OR '1'='1" })).toThrow()
    expect(() => clusterQuery({ ...base, countryCode: 'GREAT BRITAIN' })).toThrow()
    expect(() => clusterQuery({ ...base, limit: 0 })).toThrow()
    expect(() => clusterQuery({ ...base, limit: 5_000 })).toThrow()
    expect(() => clusterQuery({ ...base, granularity: 'DAILY' as 'WEEKLY' })).toThrow()
  })

  it('takes a lower case country and sends it the way Google wants it', () => {
    expect(clusterQuery({ ...base, countryCode: 'gb' })).toContain("report_country_code = 'GB'")
  })
})
