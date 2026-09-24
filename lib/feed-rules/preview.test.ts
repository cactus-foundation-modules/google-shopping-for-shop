import { describe, expect, it } from 'vitest'
import { evaluateFeedRules, type RuleSubject } from '@/modules/google-shopping-for-shop/lib/feed-rules/evaluate'
import { countRuleMatches, previewRule } from '@/modules/google-shopping-for-shop/lib/feed-rules/preview'
import type { FeedRule, RuleDraft } from '@/modules/google-shopping-for-shop/lib/feed-rules/types'

const subjects: RuleSubject[] = [
  { itemId: 'a', title: 'Acme chair', parentId: null, own: { supplier: ['Acme'] }, parent: null, manual: 'rules' },
  { itemId: 'b', title: 'Acme desk', parentId: null, own: { supplier: ['Acme'] }, parent: null, manual: 'include' },
  { itemId: 'c', title: 'Other lamp', parentId: null, own: { supplier: ['Other'] }, parent: null, manual: 'rules' },
  { itemId: 'd', title: 'Acme shelf', parentId: null, own: { supplier: ['Acme'] }, parent: null, manual: 'rules' },
]

const acme: RuleDraft = {
  name: 'No Acme',
  enabled: true,
  conditions: { op: 'all', items: [{ field: 'supplier', operator: 'equals', value: 'Acme' }] },
  action: { type: 'exclude' },
}

function saved(draft: RuleDraft, id: string, position: number): FeedRule {
  return { ...draft, id, position, createdBy: null, createdAt: '2026-09-22T09:00:00.000Z', updatedAt: '2026-09-22T09:00:00.000Z' }
}

describe('countRuleMatches', () => {
  it('counts a switched-off Exclude rule, and what switching it on would take out', () => {
    const off = { ...saved(acme, 'r1', 0), enabled: false }
    const counts = countRuleMatches([off], subjects, evaluateFeedRules([off], subjects))
    // Three match; b is sent by hand, so only two would leave the feed.
    expect(counts.get('r1')).toEqual({ matched: 3, wouldExclude: 2 })
  })

  it('counts a rule already doing its work as taking nothing further out', () => {
    const on = saved(acme, 'r1', 0)
    const counts = countRuleMatches([on], subjects, evaluateFeedRules([on], subjects))
    expect(counts.get('r1')).toEqual({ matched: 3, wouldExclude: 0 })
  })

  it('counts a switched-off label rule as taking nothing out', () => {
    const label = { ...saved({ ...acme, action: { type: 'custom_label' as const, slot: 1 as const, value: 'x' } }, 'r2', 0), enabled: false }
    expect(countRuleMatches([label], subjects, evaluateFeedRules([], subjects)).get('r2')).toEqual({ matched: 3, wouldExclude: 0 })
  })

  it('does not count an item another rule already keeps out', () => {
    const on = saved(acme, 'r1', 0)
    const off = { ...saved({ ...acme, name: 'Also Acme' }, 'r2', 1), enabled: false }
    const counts = countRuleMatches([on, off], subjects, evaluateFeedRules([on, off], subjects))
    expect(counts.get('r2')?.wouldExclude).toBe(0)
  })
})

describe('previewRule', () => {
  it('counts what a new Exclude would catch, and what it would actually take out', () => {
    const current = evaluateFeedRules([], subjects)
    const preview = previewRule([], acme, null, subjects, current)
    expect(preview.matched).toBe(3)
    // b is sent by hand, so the rule matches it and changes nothing.
    expect(preview.changes.leaves).toBe(2)
    expect(preview.affected).toBe(2)
    expect(preview.heldByHand).toBe(1)
    expect(preview.samples.map((s) => s.id)).toEqual(['a', 'd'])
    expect(preview.samples[0]?.changes).toEqual(['Would be kept out of the feed'])
    expect(preview.catalogue).toBe(4)
  })

  it('says an Exclude an earlier rule already applies would change nothing', () => {
    const rules = [saved(acme, 'r1', 0)]
    const current = evaluateFeedRules(rules, subjects)
    const preview = previewRule(rules, { ...acme, name: 'Again' }, null, subjects, current)
    expect(preview.affected).toBe(0)
    expect(preview.alreadyCovered).toBe(2)
  })

  it('shows items coming back when an edit narrows a rule', () => {
    const rules = [saved(acme, 'r1', 0)]
    const current = evaluateFeedRules(rules, subjects)
    const narrower: RuleDraft = { ...acme, conditions: { op: 'all', items: [{ field: 'supplier', operator: 'equals', value: 'Nobody' }] } }
    const preview = previewRule(rules, narrower, 'r1', subjects, current)
    expect(preview.matched).toBe(0)
    expect(preview.changes.returns).toBe(2)
  })

  it('previews a switched-off draft as if it were on', () => {
    const current = evaluateFeedRules([], subjects)
    expect(previewRule([], { ...acme, enabled: false }, null, subjects, current).changes.leaves).toBe(2)
  })

  it('reports label changes by slot, and a lower rule that loses the slot as changing nothing', () => {
    const first = saved({ ...acme, name: 'First', action: { type: 'custom_label', slot: 2, value: 'first' } }, 'r1', 0)
    const current = evaluateFeedRules([first], subjects)
    const second: RuleDraft = { ...acme, name: 'Second', action: { type: 'custom_label', slot: 2, value: 'second' } }
    const preview = previewRule([first], second, null, subjects, current)
    expect(preview.affected).toBe(0)

    const other: RuleDraft = { ...acme, name: 'Other slot', action: { type: 'custom_label', slot: 0, value: 'zero' } }
    const labelled = previewRule([first], other, null, subjects, current)
    expect(labelled.changes.label).toBe(3)
    expect(labelled.samples[0]?.changes).toEqual(['Custom label 0 set to "zero"'])
  })
})
