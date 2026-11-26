import { describe, expect, it } from 'vitest'
import { fieldMeta } from '@/modules/google-shopping-for-shop/lib/feed-rules/fields'
import { normaliseDraft, ruleProblems, RuleDraftSchema, type RuleDraft } from '@/modules/google-shopping-for-shop/lib/feed-rules/types'

const kindOf = (field: string) => fieldMeta(field)?.kind ?? null

const good: RuleDraft = {
  name: 'Rule',
  enabled: true,
  conditions: { op: 'all', items: [{ field: 'supplier', operator: 'equals', value: 'Acme' }] },
  action: { type: 'exclude' },
}

describe('ruleProblems', () => {
  it('passes a complete rule', () => {
    expect(ruleProblems(good, kindOf)).toEqual([])
  })

  it('refuses a rule with no conditions, which would catch the whole shop', () => {
    expect(ruleProblems({ ...good, conditions: { op: 'all', items: [] } }, kindOf)[0]).toMatch(/at least one condition/)
  })

  it('refuses an empty nested group', () => {
    const draft = { ...good, conditions: { op: 'all' as const, items: [...good.conditions.items, { op: 'any' as const, items: [] }] } }
    expect(ruleProblems(draft, kindOf)[0]).toMatch(/groups has nothing/)
  })

  it('refuses a field the shop does not have, a comparison the field does not offer, and a missing value', () => {
    expect(ruleProblems({ ...good, conditions: { op: 'all', items: [{ field: 'nope', operator: 'equals', value: 'x' }] } }, kindOf)[0]).toMatch(/no longer has/)
    expect(ruleProblems({ ...good, conditions: { op: 'all', items: [{ field: 'price', operator: 'contains', value: '1' }] } }, kindOf)[0]).toMatch(/does not offer/)
    expect(ruleProblems({ ...good, conditions: { op: 'all', items: [{ field: 'supplier', operator: 'equals', value: '  ' }] } }, kindOf)[0]).toMatch(/nothing to compare/)
    expect(ruleProblems({ ...good, conditions: { op: 'all', items: [{ field: 'supplier', operator: 'is_empty' }] } }, kindOf)).toEqual([])
  })

  it('refuses a number field compared with words', () => {
    expect(ruleProblems({ ...good, conditions: { op: 'all', items: [{ field: 'price', operator: 'less_than', value: 'cheap' }] } }, kindOf)[0]).toMatch(/not one/)
  })

  it('refuses a brand change with no brand', () => {
    expect(ruleProblems({ ...good, action: { type: 'identifiers', mode: 'brand', brand: ' ' } }, kindOf)).toContain('Say which brand to send.')
  })

  it('refuses nesting deeper than four', () => {
    const deep = { op: 'all' as const, items: [{ op: 'all' as const, items: [{ op: 'all' as const, items: [{ op: 'all' as const, items: [{ op: 'all' as const, items: [{ field: 'supplier', operator: 'equals' as const, value: 'x' }] }] }] }] }] }
    expect(ruleProblems({ ...good, conditions: deep }, kindOf).some((p) => /nest/.test(p))).toBe(true)
  })
})

describe('RuleDraftSchema and normaliseDraft', () => {
  it('refuses a custom label longer than Google allows and an unknown slot', () => {
    expect(RuleDraftSchema.safeParse({ ...good, action: { type: 'custom_label', slot: 0, value: 'x'.repeat(101) } }).success).toBe(false)
    expect(RuleDraftSchema.safeParse({ ...good, action: { type: 'custom_label', slot: 5, value: 'x' } }).success).toBe(false)
  })

  it('tidies values to the shape their operator wants', () => {
    const tidy = normaliseDraft({
      ...good,
      name: '  Spaced  ',
      conditions: {
        op: 'any',
        items: [
          { field: 'supplier', operator: 'in_list', value: ['A ', '', ' B'] },
          { field: 'supplier', operator: 'is_empty', value: 'ignored' },
          { field: 'price', operator: 'equals', value: [' 10 '] },
        ],
      },
    })
    expect(tidy.name).toBe('Spaced')
    expect(tidy.conditions.items).toEqual([
      { field: 'supplier', operator: 'in_list', value: ['A', 'B'] },
      { field: 'supplier', operator: 'is_empty' },
      { field: 'price', operator: 'equals', value: '10' },
    ])
  })

  it('drops a stray brand from an identifier change that is not a brand change', () => {
    expect(normaliseDraft({ ...good, action: { type: 'identifiers', mode: 'mpn_from_sku', brand: 'x' } }).action).toEqual({ type: 'identifiers', mode: 'mpn_from_sku' })
  })
})

describe('SKU lists', () => {
  const skuList = (value: string[]): RuleDraft => ({
    ...good,
    conditions: { op: 'all', items: [{ field: 'sku', operator: 'in_list', value }] },
    action: { type: 'identifiers', mode: 'brand', brand: 'Dynamic Office Solutions' },
  })

  it('offers SKU as a text field read from each variation', () => {
    expect(fieldMeta('sku')).toEqual({ kind: 'text', level: 'variation' })
  })

  it('accepts a pasted list of a few hundred SKUs and tidies it: blank lines, stray spaces, Windows line ends and repeats', () => {
    const pasted = Array.from({ length: 241 }, (_, i) => ` SKU-${i}\r`)
    const raw = [...pasted, '', '  ', 'sku-0', 'SKU-1']
    const parsed = RuleDraftSchema.safeParse(skuList(raw))
    expect(parsed.success).toBe(true)
    const tidy = normaliseDraft(parsed.success ? parsed.data : skuList([]))
    const condition = tidy.conditions.items[0]
    expect(condition && 'field' in condition ? condition.value : null).toEqual(Array.from({ length: 241 }, (_, i) => `SKU-${i}`))
    expect(ruleProblems(tidy, kindOf)).toEqual([])
  })

  it('refuses more than 500 values, in words an owner can act on', () => {
    const parsed = RuleDraftSchema.safeParse(skuList(Array.from({ length: 501 }, (_, i) => `SKU-${i}`)))
    expect(parsed.success).toBe(false)
    expect(parsed.success ? '' : parsed.error.issues[0]?.message).toMatch(/up to 500 values/)
  })
})
