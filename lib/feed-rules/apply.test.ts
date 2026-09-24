import { describe, expect, it } from 'vitest'
import { customLabelsOf, identifiersAfterRules, titleAfterRules, type IdentityInputs } from '@/modules/google-shopping-for-shop/lib/feed-rules/apply'
import { EMPTY_OUTCOME, type RuleOutcome } from '@/modules/google-shopping-for-shop/lib/feed-rules/evaluate'

const ref = (name: string) => ({ id: name, name })

function outcome(overrides: Partial<RuleOutcome>): RuleOutcome {
  return { ...EMPTY_OUTCOME, ...overrides }
}

const standalone: IdentityInputs = {
  data: { brand: null, gtin: null, mpn: null },
  fallbacks: { supplier: 'Supplier Co', defaultBrand: 'Shop Default', useSupplier: true },
  codes: { barcode: '5012345678900', sku: 'SKU-1' },
  standalone: true,
  mpnFromSku: false,
}

describe('identifiersAfterRules', () => {
  it('changes nothing with no rules', () => {
    expect(identifiersAfterRules(standalone, EMPTY_OUTCOME)).toEqual({ brand: 'Supplier Co', gtin: '5012345678900', mpn: undefined, identifierExists: true })
  })

  it("puts a rule's brand ahead of the supplier and the default, but behind one typed on the product", () => {
    const brandRule = outcome({ identifiers: { brand: { value: 'Rule Brand', rule: ref('b') } } })
    expect(identifiersAfterRules(standalone, brandRule).brand).toBe('Rule Brand')
    const typed = { ...standalone, data: { ...standalone.data, brand: 'Typed Brand' } }
    expect(identifiersAfterRules(typed, brandRule).brand).toBe('Typed Brand')
  })

  it('switches MPN-from-SKU on for the items a rule matches, where the shop has it off', () => {
    const rule = outcome({ identifiers: { mpnFromSku: ref('m') } })
    expect(identifiersAfterRules(standalone, rule).mpn).toBe('SKU-1')
    expect(identifiersAfterRules(standalone, EMPTY_OUTCOME).mpn).toBeUndefined()
  })

  it('drops the GTIN and MPN for "no identifiers", keeping the brand', () => {
    const rule = outcome({ identifiers: { noIdentifiers: ref('n'), mpnFromSku: ref('m') } })
    expect(identifiersAfterRules(standalone, rule)).toEqual({ brand: 'Supplier Co', identifierExists: false })
  })

  it('leaves a product with a typed-in code alone, whatever "no identifiers" says', () => {
    const typed = { ...standalone, data: { ...standalone.data, mpn: 'MAKER-9' } }
    const result = identifiersAfterRules(typed, outcome({ identifiers: { noIdentifiers: ref('n') } }))
    expect(result.identifierExists).toBe(true)
    expect(result.mpn).toBe('MAKER-9')
  })

  it('applies "no identifiers" to a variation, which has no typed-in codes of its own to protect', () => {
    const child = { ...standalone, standalone: false, data: { brand: null, gtin: '5000000000000', mpn: 'PARENT-MPN' } }
    expect(identifiersAfterRules(child, outcome({ identifiers: { noIdentifiers: ref('n') } })).identifierExists).toBe(false)
  })
})

describe('titleAfterRules', () => {
  const inputs = { originalTitle: 'Oslo Desk - Oak', parentTitle: 'Oslo Desk', variantLabel: 'Oak', sku: 'OS-1', options: [{ name: 'Finish', value: 'Oak' }] }
  const ids = { brand: 'Acme', identifierExists: true }

  it("sends the rule's template when the item has none of its own", () => {
    const result = titleAfterRules(inputs, ids, undefined, outcome({ titleTemplate: { template: '<brand> <parent_title> in <material>', rule: ref('t') } }))
    expect(result.title).toBe('Acme Oslo Desk in Oak')
  })

  it("lets the item's own template beat the rule's", () => {
    const result = titleAfterRules(inputs, ids, 'Own <sku>', outcome({ titleTemplate: { template: 'Rule title', rule: ref('t') } }))
    expect(result.title).toBe('Own OS-1')
  })

  it('fills tokens from the identifiers as the rules left them', () => {
    const result = titleAfterRules(inputs, { brand: 'Rule Brand', identifierExists: true }, '<brand> desk', EMPTY_OUTCOME)
    expect(result.title).toBe('Rule Brand desk')
    expect(result.context.brand).toBe('Rule Brand')
  })
})

describe('customLabelsOf', () => {
  it('is undefined when no slot is filled', () => {
    expect(customLabelsOf(EMPTY_OUTCOME)).toBeUndefined()
  })

  it('cuts a label to 100 characters counted as a person counts them', () => {
    const emoji = '\u{1F4CE}'.repeat(120)
    const labels = customLabelsOf(outcome({ labels: { 0: { value: emoji, rule: ref('a') } } }))
    expect(Array.from(labels?.[0] ?? '')).toHaveLength(100)
    // Nothing left half-written: every code unit belongs to a whole character.
    expect(Array.from(labels?.[0] ?? '').every((character) => character === '\u{1F4CE}')).toBe(true)
  })

  it('lines the values up by slot', () => {
    const labels = customLabelsOf(outcome({ labels: { 1: { value: 'one', rule: ref('a') }, 4: { value: ' four ', rule: ref('b') } } }))
    expect(labels).toEqual([undefined, 'one', undefined, undefined, 'four'])
  })
})
