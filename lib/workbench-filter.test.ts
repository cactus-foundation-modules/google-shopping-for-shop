import { describe, expect, it } from 'vitest'
import { clip } from '@/modules/google-shopping-for-shop/lib/feed-xml'
import { GOOGLE_TITLE_MAX, buildTitleTemplateContext } from '@/modules/google-shopping-for-shop/lib/title-template-render'
import { filterWorkbench, pageOf, searchTerms, sortWorkbench } from '@/modules/google-shopping-for-shop/lib/workbench-filter'
import { DEFAULT_WORKBENCH_QUERY, type WorkbenchQuery } from '@/modules/google-shopping-for-shop/lib/workbench-query'
import {
  baseSearchText,
  buildWorkbenchView,
  categoryLevels,
  summariseWorkbench,
  toWorkbenchRow,
  NO_RULE_EFFECTS,
  type MatchSnapshot,
  type WorkbenchBaseItem,
} from '@/modules/google-shopping-for-shop/lib/workbench-view'

function item(overrides: Partial<WorkbenchBaseItem> & { id: string }): WorkbenchBaseItem {
  const originalTitle = overrides.originalTitle ?? `Chair ${overrides.id}`
  const base: WorkbenchBaseItem = {
    groupId: null,
    feedIndex: 0,
    originalTitle,
    parentTitle: originalTitle,
    context: buildTitleTemplateContext({ originalTitle, parentTitle: originalTitle, sku: `SKU-${overrides.id}`, brand: 'Acme', options: [{ name: 'Colour', value: 'Blue' }] }),
    sku: `SKU-${overrides.id}`,
    mpn: '',
    gtin: '0123456789012',
    brand: 'Acme',
    identifierExists: true,
    productType: 'Office Chairs > Task Chairs',
    googleProductCategory: '',
    priceAmount: 100,
    regularPrice: 100,
    currency: 'GBP',
    availability: 'in_stock',
    imageUrl: '',
    url: 'https://example.test/p',
    searchText: '',
    rules: NO_RULE_EFFECTS,
    ...overrides,
  }
  return { ...base, searchText: baseSearchText([base.id, base.originalTitle, base.sku, base.brand, base.productType]) }
}

const checkedAt = new Date('2026-09-18T05:30:00Z')

function snapshot(overrides: Partial<MatchSnapshot> = {}): MatchSnapshot {
  return { matched: true, merchantTitle: null, benchmarkAmountMicros: null, benchmarkCurrency: 'GBP', reportingStatus: null, checkedAt, ...overrides }
}

function query(overrides: Partial<WorkbenchQuery> = {}): WorkbenchQuery {
  return { ...DEFAULT_WORKBENCH_QUERY, ...overrides }
}

describe('workbench view', () => {
  it('renders the template and sets our price against the typical one', () => {
    const view = buildWorkbenchView(item({ id: 'a', priceAmount: 110 }), '<brand> <original_title> <colour>', snapshot({ benchmarkAmountMicros: '100000000', merchantTitle: 'Acme Chair a Blue' }))
    expect(view.renderedTitle).toBe('Acme Chair a Blue')
    expect(view.matched).toBe('matched')
    expect(view.benchmarkAmount).toBe(100)
    expect(view.gapPercent).toBe(10)
    expect(view.pricePosition).toBe('dearer')
    expect(view.issues).toEqual([])
  })

  it('names the problems an owner can act on', () => {
    const view = buildWorkbenchView(
      item({ id: 'b', gtin: '', brand: '', identifierExists: false }),
      `<nope> ${'x'.repeat(160)}`,
      snapshot({ merchantTitle: 'An old title' }),
    )
    expect(view.issues).toEqual(['unknown-token', 'too-long', 'out-of-date', 'no-gtin', 'no-brand', 'no-identifiers'])
  })

  it('does not call a title out of date when only spacing or case differ', () => {
    const view = buildWorkbenchView(item({ id: 'c' }), undefined, snapshot({ merchantTitle: '  chair   C ' }))
    expect(view.issues).not.toContain('out-of-date')
  })

  it('compares a clipped title as Google holds it, not the uncut one', () => {
    const long = `Chair ${'word '.repeat(40)}end`
    const view = buildWorkbenchView(item({ id: 'd', originalTitle: long }), undefined, snapshot({ merchantTitle: clip(long, GOOGLE_TITLE_MAX) }))
    expect(view.issues).toContain('too-long')
    expect(view.issues).not.toContain('out-of-date')
  })

  it('refuses to compare against a benchmark in another currency', () => {
    const view = buildWorkbenchView(item({ id: 'e' }), undefined, snapshot({ benchmarkAmountMicros: '90000000', benchmarkCurrency: 'EUR' }))
    expect(view.gapPercent).toBeNull()
    expect(view.pricePosition).toBe('no-benchmark')
  })

  it('leaves unreported items unknown and sends no search index to the browser', () => {
    const view = buildWorkbenchView(item({ id: 'f' }), undefined, undefined)
    expect(view.matched).toBe('unknown')
    const row = toWorkbenchRow(view, 3)
    expect(row.listingSize).toBe(3)
    expect('haystack' in row).toBe(false)
    expect('searchText' in row).toBe(false)
  })

  it('offers the first two category levels', () => {
    expect(categoryLevels('A > B > C')).toEqual(['A', 'A > B'])
    expect(categoryLevels('')).toEqual([])
  })
})

describe('filtering by what Google says', () => {
  // Three items and three different stories: one Google turned down, one it
  // shows less often, one it has reported on and had nothing to say about -
  // and one it has never reported on at all, which is the interesting case.
  const views = [
    buildWorkbenchView(item({ id: 'down', feedIndex: 0 }), undefined, snapshot({ reportingStatus: 'not-eligible' }), { worst: 'disapproved', codes: ['image_link_broken', 'missing_value'] }),
    buildWorkbenchView(item({ id: 'demoted', feedIndex: 1 }), undefined, snapshot({ reportingStatus: 'limited' }), { worst: 'demoted', codes: ['missing_value'] }),
    buildWorkbenchView(item({ id: 'fine', feedIndex: 2 }), undefined, snapshot({ reportingStatus: 'eligible' }), undefined),
    buildWorkbenchView(item({ id: 'unasked', feedIndex: 3 }), undefined, undefined, undefined),
  ]
  const ids = (q: Partial<WorkbenchQuery>) => filterWorkbench(views, query(q)).map((v) => v.id)

  it('filters by severity and by Google\'s own code', () => {
    expect(ids({ google: 'any' })).toEqual(['down', 'demoted'])
    expect(ids({ google: 'disapproved' })).toEqual(['down'])
    expect(ids({ google: 'demoted' })).toEqual(['demoted'])
    expect(ids({ googleCode: 'missing_value' })).toEqual(['down', 'demoted'])
    expect(ids({ googleCode: 'image_link_broken' })).toEqual(['down'])
  })

  it('does not count an item nobody has asked about as one Google is happy with', () => {
    expect(ids({ google: 'none' })).toEqual(['fine'])
  })

  it('puts Google\'s codes in the search index', () => {
    expect(ids({ search: 'image_link_broken' })).toEqual(['down'])
  })

  it('counts items, not issues, and keeps the unasked out of both columns', () => {
    const summary = summariseWorkbench(views)
    expect(summary.google).toEqual({ any: 2, none: 1, disapproved: 1, demoted: 1, pending: 0 })
    expect(summary.googleCodes).toEqual([
      { value: 'missing_value', count: 2 },
      { value: 'image_link_broken', count: 1 },
    ])
  })
})

describe('workbench filtering', () => {
  const views = [
    buildWorkbenchView(item({ id: 'a', feedIndex: 0, originalTitle: 'Blue Task Chair', groupId: 'p1', priceAmount: 120 }), undefined, snapshot({ benchmarkAmountMicros: '100000000' })),
    buildWorkbenchView(item({ id: 'b', feedIndex: 1, originalTitle: 'Red Task Chair', groupId: 'p1', priceAmount: 80 }), 'Own <sku>', snapshot({ matched: false, benchmarkAmountMicros: '100000000' })),
    buildWorkbenchView(item({ id: 'c', feedIndex: 2, originalTitle: 'Oak Desk', brand: 'Birch & Co', productType: 'Desks', gtin: '' }), undefined, undefined),
  ]

  it('needs every search word, anywhere in the item', () => {
    expect(filterWorkbench(views, query({ search: 'task blue' })).map((v) => v.id)).toEqual(['a'])
    expect(filterWorkbench(views, query({ search: 'sku-b' })).map((v) => v.id)).toEqual(['b'])
    expect(filterWorkbench(views, query({ search: 'own sku-b' })).map((v) => v.id)).toEqual(['b'])
  })

  it('keeps a quoted phrase together', () => {
    expect(searchTerms('"task chair" red')).toEqual(['task chair', 'red'])
    expect(filterWorkbench(views, query({ search: '"chair blue"' }))).toEqual([])
  })

  it('filters by match state, own title, problem, price, brand, category and listing', () => {
    const ids = (q: Partial<WorkbenchQuery>) => filterWorkbench(views, query(q)).map((v) => v.id)
    expect(ids({ match: 'unmatched' })).toEqual(['b'])
    expect(ids({ match: 'unknown' })).toEqual(['c'])
    expect(ids({ override: 'overridden' })).toEqual(['b'])
    expect(ids({ override: 'plain' })).toEqual(['a', 'c'])
    expect(ids({ issue: 'no-gtin' })).toEqual(['c'])
    expect(ids({ issue: 'any' })).toEqual(['c'])
    expect(ids({ price: 'dearer' })).toEqual(['a'])
    expect(ids({ price: 'cheaper' })).toEqual(['b'])
    expect(ids({ price: 'no-benchmark' })).toEqual(['c'])
    expect(ids({ brand: 'Birch & Co' })).toEqual(['c'])
    expect(ids({ category: 'Office Chairs' })).toEqual(['a', 'b'])
    expect(ids({ category: 'Office' })).toEqual([])
    expect(ids({ group: 'p1' })).toEqual(['a', 'b'])
  })

  it('sorts without losing rows, unknown gaps last either way', () => {
    expect(sortWorkbench(views, 'price-asc').map((v) => v.id)).toEqual(['b', 'c', 'a'])
    expect(sortWorkbench(views, 'gap-desc').map((v) => v.id)).toEqual(['a', 'b', 'c'])
    expect(sortWorkbench(views, 'gap-asc').map((v) => v.id)).toEqual(['b', 'a', 'c'])
    expect(sortWorkbench(views, 'title').map((v) => v.id)).toEqual(['a', 'c', 'b'])
    expect(views.map((v) => v.id)).toEqual(['a', 'b', 'c'])
  })

  it('pages, and answers a page past the end with the last page', () => {
    expect(pageOf([1, 2, 3, 4, 5], 2, 2)).toEqual({ rows: [3, 4], page: 2, pageCount: 3, total: 5 })
    expect(pageOf([1, 2, 3, 4, 5], 40, 2)).toEqual({ rows: [5], page: 3, pageCount: 3, total: 5 })
    expect(pageOf([], 1, 50)).toEqual({ rows: [], page: 1, pageCount: 1, total: 0 })
  })

  it('summarises the whole list for the tiles and chips', () => {
    const summary = summariseWorkbench(views)
    expect(summary).toMatchObject({ total: 3, matched: 1, unmatched: 1, unknown: 1, overridden: 1, anyIssue: 1 })
    expect(summary.issues['no-gtin']).toBe(1)
    expect(summary.prices).toEqual({ dearer: 1, cheaper: 1, level: 0, 'no-benchmark': 1 })
    expect(summary.brands).toEqual([{ value: 'Acme', count: 2 }, { value: 'Birch & Co', count: 1 }])
    expect(summary.categories.map((c) => c.value)).toEqual(['Desks', 'Office Chairs', 'Office Chairs > Task Chairs'])
    expect(summary.lastCheckedAt).toBe(checkedAt.toISOString())
  })
})

describe('feed rules on the workbench', () => {
  const out = { id: 'r-out', name: 'Out' }
  const label = { id: 'r-label', name: 'Label' }
  const titled = { id: 'r-title', name: 'Titles' }
  const views = [
    buildWorkbenchView(item({ id: 'in', feedIndex: 0, rules: { ...NO_RULE_EFFECTS, labels: [{ slot: 0, value: 'sale', rule: label }], matched: [label] } }), undefined, undefined),
    buildWorkbenchView(item({ id: 'ruled', feedIndex: 1, rules: { ...NO_RULE_EFFECTS, feedStatus: 'rule', excludedBy: out, matched: [out, label] } }), undefined, undefined),
    buildWorkbenchView(item({ id: 'hand', feedIndex: 2, rules: { ...NO_RULE_EFFECTS, feedStatus: 'hand', manualChoice: 'exclude' } }), undefined, undefined),
    buildWorkbenchView(item({ id: 'rule-title', feedIndex: 3, rules: { ...NO_RULE_EFFECTS, ruleTitle: { template: 'Rule <sku>', rule: titled }, matched: [titled] } }), undefined, undefined),
    buildWorkbenchView(item({ id: 'own-title', feedIndex: 4, rules: { ...NO_RULE_EFFECTS, ruleTitle: { template: 'Rule <sku>', rule: titled }, matched: [titled] } }), 'Own <sku>', undefined),
  ]
  const ids = (query: Partial<WorkbenchQuery>) => filterWorkbench(views, { ...DEFAULT_WORKBENCH_QUERY, ...query }).map((view) => view.id)

  it('shows only what goes to Google by default, and what is kept out when asked', () => {
    expect(ids({})).toEqual(['in', 'rule-title', 'own-title'])
    expect(ids({ feed: 'out' })).toEqual(['ruled', 'hand'])
    expect(ids({ feed: 'all' })).toHaveLength(5)
  })

  it('narrows to the items a rule matches', () => {
    expect(ids({ feed: 'all', rule: 'r-label' })).toEqual(['in', 'ruled'])
    expect(ids({ rule: 'r-out' })).toEqual([])
    expect(ids({ feed: 'all', rule: 'r-out' })).toEqual(['ruled'])
  })

  it("sends a rule's title only where the item has none of its own, and says whose it is", () => {
    const ruleTitle = views.find((view) => view.id === 'rule-title')
    const ownTitle = views.find((view) => view.id === 'own-title')
    expect(ruleTitle?.renderedTitle).toBe('Rule SKU-rule-title')
    expect(ruleTitle?.titleFromRule).toEqual(titled)
    expect(ruleTitle?.titleTemplate).toBeNull()
    expect(ownTitle?.renderedTitle).toBe('Own SKU-own-title')
    expect(ownTitle?.titleFromRule).toBeNull()
  })

  it('counts the tiles over the feed only, and each rule over everything it matches', () => {
    const summary = summariseWorkbench(views)
    expect(summary.total).toBe(3)
    expect(summary.outOfFeed).toEqual({ rule: 1, hand: 1 })
    expect(summary.rules).toEqual([
      { id: 'r-label', name: 'Label', count: 2 },
      { id: 'r-out', name: 'Out', count: 1 },
      { id: 'r-title', name: 'Titles', count: 2 },
    ])
  })
})
