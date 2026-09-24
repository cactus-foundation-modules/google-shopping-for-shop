import { describe, expect, it } from 'vitest'
import {
  evaluateFeedRules,
  factFor,
  matchesConditions,
  type RuleFacts,
  type RuleSubject,
} from '@/modules/google-shopping-for-shop/lib/feed-rules/evaluate'
import { attributeFieldKey, optionFieldKey } from '@/modules/google-shopping-for-shop/lib/feed-rules/fields'
import type { FeedRule, RuleAction, RuleCondition, RuleGroup } from '@/modules/google-shopping-for-shop/lib/feed-rules/types'

const MTO = attributeFieldKey('attr-mto')

function subject(overrides: Partial<RuleSubject> & { itemId: string }): RuleSubject {
  return { title: `Item ${overrides.itemId}`, parentId: null, own: {}, parent: null, manual: 'rules', ...overrides }
}

/** A variation and the listing facts it shares with its siblings. */
function variation(itemId: string, own: RuleFacts, parent: RuleFacts, manual: RuleSubject['manual'] = 'rules'): RuleSubject {
  return subject({ itemId, parentId: 'listing', own, parent, manual })
}

let position = 0
function rule(name: string, conditions: RuleGroup, action: RuleAction, overrides: Partial<FeedRule> = {}): FeedRule {
  position += 1
  return {
    id: name.toLowerCase().replace(/\W+/g, '-'),
    name,
    enabled: true,
    position,
    conditions,
    action,
    createdBy: null,
    createdAt: '2026-09-22T09:00:00.000Z',
    updatedAt: '2026-09-22T09:00:00.000Z',
    ...overrides,
  }
}

const all = (...items: Array<RuleCondition | RuleGroup>): RuleGroup => ({ op: 'all', items })
const any = (...items: Array<RuleCondition | RuleGroup>): RuleGroup => ({ op: 'any', items })
const is = (field: string, value: string): RuleCondition => ({ field, operator: 'equals', value })

describe("the owner's example: attribute MTO is Yes AND supplier is Dynamic Office Solutions -> Exclude", () => {
  const example = rule('MTO from DOS', all(is(MTO, 'Yes'), is('supplier', 'Dynamic Office Solutions')), { type: 'exclude' })
  const listing: RuleFacts = { supplier: ['Dynamic Office Solutions'], [MTO]: ['Yes'] }

  it('excludes an item that meets both, and names the rule as the reason', () => {
    const outcomes = evaluateFeedRules([example], [subject({ itemId: 'a', own: { supplier: ['Dynamic Office Solutions'], [MTO]: ['Yes'] } })])
    expect(outcomes.get('a')?.exclusion).toEqual({ by: 'rule', rule: { id: example.id, name: 'MTO from DOS' } })
  })

  it('leaves alone an item that meets only one half', () => {
    const outcomes = evaluateFeedRules([example], [
      subject({ itemId: 'wrong-supplier', own: { supplier: ['Someone Else'], [MTO]: ['Yes'] } }),
      subject({ itemId: 'not-mto', own: { supplier: ['Dynamic Office Solutions'], [MTO]: ['No'] } }),
      subject({ itemId: 'no-answer', own: { supplier: ['Dynamic Office Solutions'], [MTO]: [] } }),
    ])
    for (const id of ['wrong-supplier', 'not-mto', 'no-answer']) expect(outcomes.get(id)?.exclusion).toBeNull()
  })

  it('compares without regard to case or stray spaces', () => {
    const outcomes = evaluateFeedRules([example], [subject({ itemId: 'a', own: { supplier: ['  dynamic office solutions '], [MTO]: ['YES'] } })])
    expect(outcomes.get('a')?.exclusion?.by).toBe('rule')
  })

  it('catches every variation of a listing that carries both on the parent', () => {
    const outcomes = evaluateFeedRules([example], [
      variation('v1', { supplier: [], [MTO]: [] }, listing),
      variation('v2', {}, listing),
    ])
    expect(outcomes.get('v1')?.exclusion?.by).toBe('rule')
    expect(outcomes.get('v2')?.exclusion?.by).toBe('rule')
  })

  it("lets a variation's own answer beat its listing's", () => {
    const outcomes = evaluateFeedRules([example], [variation('v1', { [MTO]: ['No'] }, listing)])
    expect(outcomes.get('v1')?.exclusion).toBeNull()
  })
})

describe('nesting', () => {
  const chairs = is('category', 'cat-chairs')
  const cheap: RuleCondition = { field: 'price', operator: 'less_than', value: '50' }
  const outOfStock = is('stock_status', 'out_of_stock')
  // (chairs AND cheap) OR out of stock
  const tree = any(all(chairs, cheap), outOfStock)

  it('reads (A and B) or C the way it is written', () => {
    const cases: Array<[RuleSubject, boolean]> = [
      [subject({ itemId: '1', own: { category: ['cat-chairs'], price: 40, stock_status: ['in_stock'] } }), true],
      [subject({ itemId: '2', own: { category: ['cat-chairs'], price: 60, stock_status: ['in_stock'] } }), false],
      [subject({ itemId: '3', own: { category: ['cat-desks'], price: 40, stock_status: ['in_stock'] } }), false],
      [subject({ itemId: '4', own: { category: ['cat-desks'], price: 900, stock_status: ['out_of_stock'] } }), true],
    ]
    for (const [s, expected] of cases) expect(matchesConditions(tree, s)).toBe(expected)
  })

  it('goes three groups deep', () => {
    const deep = all(is('supplier', 'Acme'), any(is('brand', 'Acme'), all(is('has_image', 'yes'), { field: 'stock_quantity', operator: 'greater_than', value: '5' })))
    expect(matchesConditions(deep, subject({ itemId: 'x', own: { supplier: ['Acme'], brand: ['Other'], has_image: true, stock_quantity: 6 } }))).toBe(true)
    expect(matchesConditions(deep, subject({ itemId: 'y', own: { supplier: ['Acme'], brand: ['Other'], has_image: true, stock_quantity: 5 } }))).toBe(false)
    expect(matchesConditions(deep, subject({ itemId: 'z', own: { supplier: ['Acme'], brand: ['acme'], has_image: false, stock_quantity: 0 } }))).toBe(true)
  })

  it('treats an empty ALL as holding and an empty ANY as not - though neither can be saved', () => {
    const s = subject({ itemId: 'x' })
    expect(matchesConditions(all(), s)).toBe(true)
    expect(matchesConditions(any(), s)).toBe(false)
  })
})

describe('levels and inheritance', () => {
  const parent: RuleFacts = { supplier: ['Parent Co'], category: ['cat-a', 'cat-root'], status: ['ACTIVE'], price: 999 }

  it("reads a product-level field from the listing, whatever the variation says", () => {
    const v = variation('v', { category: ['cat-wrong'] }, parent)
    expect(factFor(v, 'category', 'product')).toEqual(['cat-a', 'cat-root'])
  })

  it("reads a variation-level field from the row alone, never the listing", () => {
    const v = variation('v', {}, parent)
    expect(factFor(v, 'price', 'variation')).toBeNull()
  })

  it("reads an 'either' field from the row, and from the listing only when the row has nothing", () => {
    expect(factFor(variation('v', { supplier: ['Child Co'] }, parent), 'supplier', 'either')).toEqual(['Child Co'])
    expect(factFor(variation('v', { supplier: [] }, parent), 'supplier', 'either')).toEqual(['Parent Co'])
    expect(factFor(variation('v', {}, parent), 'supplier', 'either')).toEqual(['Parent Co'])
  })

  it('has a product with no variations answer every level for itself', () => {
    const s = subject({ itemId: 's', own: { category: ['cat-b'], supplier: ['Solo'] } })
    expect(factFor(s, 'category', 'product')).toEqual(['cat-b'])
    expect(factFor(s, 'supplier', 'either')).toEqual(['Solo'])
  })

  it('matches a category anywhere above the one the product is filed in', () => {
    const v = variation('v', {}, parent)
    expect(matchesConditions(all(is('category', 'cat-root')), v)).toBe(true)
    expect(matchesConditions(all({ field: 'category', operator: 'not_equals', value: 'cat-root' }), v)).toBe(false)
  })

  it('reads variation options as the variation\'s own', () => {
    const colour = optionFieldKey('Seat Colour')
    const v = variation('v', { [colour]: ['Blue'] }, { [colour]: ['Red'] })
    expect(matchesConditions(all(is(colour, 'blue')), v)).toBe(true)
    expect(matchesConditions(all(is(colour, 'red')), v)).toBe(false)
  })
})

describe('empty values', () => {
  const empty = (field: string): RuleCondition => ({ field, operator: 'is_empty' })
  const notEmpty = (field: string): RuleCondition => ({ field, operator: 'is_not_empty' })

  it('tells "no answer" from an answer, for text and numbers alike', () => {
    const blank = subject({ itemId: 'b', own: { supplier: [], stock_quantity: null, sale_price: null } })
    const filled = subject({ itemId: 'f', own: { supplier: ['Acme'], stock_quantity: 0, sale_price: 19.99 } })
    for (const field of ['supplier', 'stock_quantity', 'sale_price']) {
      expect(matchesConditions(all(empty(field)), blank)).toBe(true)
      expect(matchesConditions(all(notEmpty(field)), blank)).toBe(false)
      expect(matchesConditions(all(empty(field)), filled)).toBe(false)
      expect(matchesConditions(all(notEmpty(field)), filled)).toBe(true)
    }
  })

  it('counts zero stock as an answer, not as empty', () => {
    const s = subject({ itemId: 'z', own: { stock_quantity: 0 } })
    expect(matchesConditions(all({ field: 'stock_quantity', operator: 'equals', value: '0' }), s)).toBe(true)
    expect(matchesConditions(all({ field: 'stock_quantity', operator: 'less_than', value: '1' }), s)).toBe(true)
  })

  it('never matches a number comparison against no number', () => {
    const s = subject({ itemId: 'n', own: { stock_quantity: null } })
    expect(matchesConditions(all({ field: 'stock_quantity', operator: 'greater_than', value: '-1' }), s)).toBe(false)
    expect(matchesConditions(all({ field: 'stock_quantity', operator: 'less_than', value: '100' }), s)).toBe(false)
    // "is not 5" is true of an item with no count at all.
    expect(matchesConditions(all({ field: 'stock_quantity', operator: 'not_equals', value: '5' }), s)).toBe(true)
  })

  it("does not match 'is not X' wrongly on an empty text value", () => {
    const s = subject({ itemId: 'e', own: { supplier: [] } })
    expect(matchesConditions(all({ field: 'supplier', operator: 'not_equals', value: 'Acme' }), s)).toBe(true)
    expect(matchesConditions(all({ field: 'supplier', operator: 'contains', value: 'Ac' }), s)).toBe(false)
    expect(matchesConditions(all({ field: 'supplier', operator: 'not_contains', value: 'Ac' }), s)).toBe(true)
  })

  it('never matches a field it has never heard of', () => {
    const s = subject({ itemId: 'u', own: { mystery: ['x'] } })
    expect(matchesConditions(all(is('mystery', 'x')), s)).toBe(false)
    expect(matchesConditions(all({ field: 'mystery', operator: 'is_empty' }), s)).toBe(false)
  })
})

describe('operators', () => {
  const s = subject({ itemId: 'o', own: { supplier: ['Acme Seating Ltd'], price: 49.99, stock_status: ['in_stock'], has_image: true, has_gtin: false } })

  it('covers every text comparison', () => {
    expect(matchesConditions(all({ field: 'supplier', operator: 'contains', value: 'seating' }), s)).toBe(true)
    expect(matchesConditions(all({ field: 'supplier', operator: 'not_contains', value: 'desk' }), s)).toBe(true)
    expect(matchesConditions(all({ field: 'supplier', operator: 'in_list', value: ['Other', 'acme seating ltd'] }), s)).toBe(true)
    expect(matchesConditions(all({ field: 'supplier', operator: 'in_list', value: ['Other'] }), s)).toBe(false)
  })

  it('reads prices to the penny, and takes numbers typed with a pound sign or commas', () => {
    expect(matchesConditions(all({ field: 'price', operator: 'equals', value: '£49.99' }), s)).toBe(true)
    expect(matchesConditions(all({ field: 'price', operator: 'greater_than', value: '49.99' }), s)).toBe(false)
    expect(matchesConditions(all({ field: 'price', operator: 'less_than', value: '1,000' }), s)).toBe(true)
    expect(matchesConditions(all({ field: 'price', operator: 'in_list', value: ['10', '49.99'] }), s)).toBe(true)
  })

  it('reads yes/no fields', () => {
    expect(matchesConditions(all(is('has_image', 'yes')), s)).toBe(true)
    expect(matchesConditions(all(is('has_gtin', 'no')), s)).toBe(true)
    expect(matchesConditions(all(is('has_gtin', 'yes')), s)).toBe(false)
  })

  it('never matches an operator the field does not offer', () => {
    expect(matchesConditions(all({ field: 'supplier', operator: 'greater_than', value: 'A' }), s)).toBe(false)
    expect(matchesConditions(all({ field: 'price', operator: 'contains', value: '49' }), s)).toBe(false)
  })
})

describe('precedence', () => {
  const acme = all(is('supplier', 'Acme'))
  const item = (id: string, manual: RuleSubject['manual'] = 'rules') => subject({ itemId: id, own: { supplier: ['Acme'] }, manual })

  it('lets any matching Exclude win, wherever it sits in the list', () => {
    const rules = [
      rule('Label first', acme, { type: 'custom_label', slot: 0, value: 'acme' }),
      rule('Title', acme, { type: 'title_template', template: '<brand> thing' }),
      rule('Exclude last', acme, { type: 'exclude' }),
    ]
    const outcome = evaluateFeedRules(rules, [item('a')]).get('a')
    expect(outcome?.exclusion).toEqual({ by: 'rule', rule: { id: 'exclude-last', name: 'Exclude last' } })
    // An excluded item carries no labels or title: it is not being sent.
    expect(outcome?.labels).toEqual({})
    expect(outcome?.titleTemplate).toBeNull()
    expect(outcome?.matched.map((r) => r.name)).toEqual(['Label first', 'Title', 'Exclude last'])
  })

  it('names the first Exclude as the reason when several match', () => {
    const rules = [rule('Out one', acme, { type: 'exclude' }), rule('Out two', acme, { type: 'exclude' })]
    expect(evaluateFeedRules(rules, [item('a')]).get('a')?.exclusion).toMatchObject({ rule: { name: 'Out one' } })
  })

  it('gives each label slot to the first rule that fills it, and leaves other slots to later rules', () => {
    const rules = [
      rule('Slot 0 first', acme, { type: 'custom_label', slot: 0, value: 'first' }),
      rule('Slot 0 second', acme, { type: 'custom_label', slot: 0, value: 'second' }),
      rule('Slot 3', acme, { type: 'custom_label', slot: 3, value: 'three' }),
    ]
    const labels = evaluateFeedRules(rules, [item('a')]).get('a')?.labels
    expect(labels?.[0]).toEqual({ value: 'first', rule: { id: 'slot-0-first', name: 'Slot 0 first' } })
    expect(labels?.[3]?.value).toBe('three')
    expect(labels?.[1]).toBeUndefined()
  })

  it('follows list position, not the order the rules arrived in', () => {
    const late = rule('Late', acme, { type: 'title_template', template: 'late' }, { position: 20 })
    const early = rule('Early', acme, { type: 'title_template', template: 'early' }, { position: 1 })
    expect(evaluateFeedRules([late, early], [item('a')]).get('a')?.titleTemplate?.template).toBe('early')
  })

  it('treats each identifier change as its own target', () => {
    const rules = [
      rule('Brand one', acme, { type: 'identifiers', mode: 'brand', brand: 'One' }),
      rule('Brand two', acme, { type: 'identifiers', mode: 'brand', brand: 'Two' }),
      rule('From SKU', acme, { type: 'identifiers', mode: 'mpn_from_sku' }),
      rule('None', acme, { type: 'identifiers', mode: 'no_identifiers' }),
    ]
    const ids = evaluateFeedRules(rules, [item('a')]).get('a')?.identifiers
    expect(ids?.brand?.value).toBe('One')
    expect(ids?.mpnFromSku?.name).toBe('From SKU')
    expect(ids?.noIdentifiers?.name).toBe('None')
  })

  it("lets the owner's own 'always send' beat an Exclude, and says which rule it beat", () => {
    const rules = [rule('Out', acme, { type: 'exclude' }), rule('Label', acme, { type: 'custom_label', slot: 1, value: 'kept' })]
    const outcome = evaluateFeedRules(rules, [item('a', 'include')]).get('a')
    expect(outcome?.exclusion).toBeNull()
    expect(outcome?.keptInOverRule?.name).toBe('Out')
    // Still labelled: it is going to Google, so its labels matter.
    expect(outcome?.labels[1]?.value).toBe('kept')
  })

  it("lets the owner's own 'never send' keep an item out with no rule at all", () => {
    const outcome = evaluateFeedRules([], [item('a', 'exclude')]).get('a')
    expect(outcome?.exclusion).toEqual({ by: 'hand' })
  })

  it('ignores switched-off rules entirely', () => {
    const outcome = evaluateFeedRules([rule('Off', acme, { type: 'exclude' }, { enabled: false })], [item('a')]).get('a')
    expect(outcome?.exclusion).toBeNull()
    expect(outcome?.matched).toEqual([])
  })
})
