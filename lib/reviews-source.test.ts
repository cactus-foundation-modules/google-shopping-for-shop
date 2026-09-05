import { describe, it, expect, vi, beforeEach } from 'vitest'

// The registry is generated at build time from the manifests of the modules
// actually installed, so the test stands one in - the seam being checked here is
// what happens to a provider's answer, not how it was found.
const registry: Record<string, Record<string, unknown>> = {}
vi.mock('@/lib/modules/extension-points.public', () => ({ modulePublicExtensionPointComponents: registry }))

const POINT = 'shop.product-reviews'

const good = {
  id: 'r1',
  productId: 'p1',
  productName: 'Oslo Desk',
  productSlug: 'oslo-desk',
  rating: 5,
  ratingMax: 5,
  title: 'Good',
  body: 'Very good desk.',
  authorName: 'Jane',
  publishedAt: '2026-03-01T09:30:00.000Z',
  verifiedPurchase: true,
  invited: true,
  orderNumber: 'DW000123',
}

function provide(fn: (opts: { limit: number; offset: number }) => Promise<unknown>) {
  registry[POINT] = { 'test-provider': fn }
}

describe('reviews source', () => {
  beforeEach(() => {
    for (const key of Object.keys(registry)) delete registry[key]
    vi.resetModules()
  })

  it('reports no provider on a site with no reviews module', async () => {
    const { hasReviewsProvider, getAllPublishedReviews } = await import('@/modules/google-shopping-for-shop/lib/reviews-source')
    expect(hasReviewsProvider()).toBe(false)
    expect(await getAllPublishedReviews({ pageSize: 10, max: 100 })).toEqual([])
  })

  it('takes a well-formed review as it stands', async () => {
    provide(async () => [good])
    const { getAllPublishedReviews } = await import('@/modules/google-shopping-for-shop/lib/reviews-source')
    const reviews = await getAllPublishedReviews({ pageSize: 10, max: 100 })
    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatchObject({ id: 'r1', rating: 5, invited: true, orderNumber: 'DW000123' })
  })

  it('drops a row missing anything Google insists on, keeping the rest', async () => {
    provide(async () => [
      good,
      { ...good, id: 'r2', body: '   ' },
      { ...good, id: 'r3', publishedAt: 'sometime last spring' },
      { ...good, id: 'r4', rating: 9 },
      { ...good, id: 'r5', productSlug: '' },
      'not a review at all',
    ])
    const { getAllPublishedReviews } = await import('@/modules/google-shopping-for-shop/lib/reviews-source')
    const reviews = await getAllPublishedReviews({ pageSize: 10, max: 100 })
    expect(reviews.map((r) => r.id)).toEqual(['r1'])
  })

  it('treats a missing name as anonymous rather than dropping the review', async () => {
    provide(async () => [{ ...good, authorName: '  ' }])
    const { getAllPublishedReviews } = await import('@/modules/google-shopping-for-shop/lib/reviews-source')
    const reviews = await getAllPublishedReviews({ pageSize: 10, max: 100 })
    expect(reviews[0]?.authorName).toBe('')
  })

  it('keeps paging while the provider fills a page, and stops when it does not', async () => {
    const asked: Array<{ limit: number; offset: number }> = []
    provide(async (opts) => {
      asked.push(opts)
      // Two full pages, then a short one.
      if (opts.offset >= 4) return [{ ...good, id: `r-${opts.offset}` }]
      return [{ ...good, id: `r-${opts.offset}-a` }, { ...good, id: `r-${opts.offset}-b` }]
    })
    const { getAllPublishedReviews } = await import('@/modules/google-shopping-for-shop/lib/reviews-source')
    const reviews = await getAllPublishedReviews({ pageSize: 2, max: 100 })
    expect(asked.map((a) => a.offset)).toEqual([0, 2, 4])
    expect(reviews).toHaveLength(5)
  })

  it('follows a full page even when every row in it was malformed', async () => {
    let calls = 0
    provide(async () => {
      calls++
      if (calls === 1) return [{ broken: true }, { broken: true }]
      return [good]
    })
    const { getAllPublishedReviews } = await import('@/modules/google-shopping-for-shop/lib/reviews-source')
    const reviews = await getAllPublishedReviews({ pageSize: 2, max: 100 })
    expect(calls).toBe(2)
    expect(reviews).toHaveLength(1)
  })

  it('never asks for more than the cap', async () => {
    const asked: number[] = []
    provide(async (opts) => {
      asked.push(opts.limit)
      return Array.from({ length: opts.limit }, (_, i) => ({ ...good, id: `r${opts.offset}-${i}` }))
    })
    const { getAllPublishedReviews } = await import('@/modules/google-shopping-for-shop/lib/reviews-source')
    const reviews = await getAllPublishedReviews({ pageSize: 4, max: 6 })
    expect(asked).toEqual([4, 2])
    expect(reviews).toHaveLength(6)
  })

  it('survives a provider that answers with something other than a list', async () => {
    provide(async () => ({ reviews: [good] }))
    const { getAllPublishedReviews } = await import('@/modules/google-shopping-for-shop/lib/reviews-source')
    expect(await getAllPublishedReviews({ pageSize: 10, max: 100 })).toEqual([])
  })
})
