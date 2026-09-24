// What a feed rule can ask about an item: the field catalogue.
//
// Each field declares two things the evaluator and the builder both rely on:
//
//  - its KIND, which decides the operators on offer and how a comparison reads
//    (text is compared without regard to case, numbers as numbers, a category
//    as "in it or anywhere under it");
//  - its LEVEL, which decides where the answer comes from on a variation:
//      'product'   - the listing's answer. A variation asks its parent, the
//                    same way the feed already takes a variation's category,
//                    description and listing status from the parent.
//      'variation' - the row's own answer: the variation's own price, stock
//                    and photos. A product with no variations answers for
//                    itself.
//      'either'    - the row's own answer where it has one, the listing's
//                    where it has not. How the shop reads attributes and
//                    suppliers everywhere else: tick one on the parent and
//                    every variation carries it unless it says otherwise.
//
// Pure, and shared by the server (which evaluates) and the browser (which
// builds rules and labels fields for the owner).

import type { RuleOperator } from '@/modules/google-shopping-for-shop/lib/feed-rules/types'

export type FieldKind = 'text' | 'number' | 'boolean' | 'choice' | 'category'
export type FieldLevel = 'product' | 'variation' | 'either'

export type FieldChoice = { value: string; label: string }

export type RuleField = {
  key: string
  label: string
  kind: FieldKind
  level: FieldLevel
  /** The fixed list a choice field picks from. Categories are supplied by the
   *  shop at run time and are not listed here. */
  choices?: FieldChoice[]
  /** One line for the field picker, where the label alone is not enough. */
  hint?: string
}

/** Operators each kind of field offers, in the order the picker lists them. */
export const OPERATORS_BY_KIND: Record<FieldKind, readonly RuleOperator[]> = {
  text: ['equals', 'not_equals', 'contains', 'not_contains', 'in_list', 'is_empty', 'is_not_empty'],
  number: ['equals', 'not_equals', 'greater_than', 'less_than', 'in_list', 'is_empty', 'is_not_empty'],
  boolean: ['equals'],
  choice: ['equals', 'not_equals', 'in_list'],
  category: ['equals', 'not_equals', 'in_list', 'is_empty', 'is_not_empty'],
}

/** How an operator reads for a field of this kind. Category equality means
 *  "in, or anywhere under", and says so. */
export function operatorLabel(operator: RuleOperator, kind: FieldKind): string {
  if (kind === 'category') {
    if (operator === 'equals') return 'is in or under'
    if (operator === 'not_equals') return 'is not in or under'
    if (operator === 'in_list') return 'is in or under any of'
  }
  if (kind === 'boolean' && operator === 'equals') return 'is'
  switch (operator) {
    case 'equals': return 'is'
    case 'not_equals': return 'is not'
    case 'contains': return 'contains'
    case 'not_contains': return 'does not contain'
    case 'is_empty': return 'is empty'
    case 'is_not_empty': return 'is not empty'
    case 'greater_than': return 'is more than'
    case 'less_than': return 'is less than'
    case 'in_list': return 'is any of'
  }
}

export const YES_NO: FieldChoice[] = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
]

export const STOCK_STATUS_CHOICES: FieldChoice[] = [
  { value: 'in_stock', label: 'In stock' },
  { value: 'out_of_stock', label: 'Out of stock' },
  { value: 'preorder', label: 'Pre-order' },
  { value: 'backorder', label: 'Back order' },
]

export const PRODUCT_STATUS_CHOICES: FieldChoice[] = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'ARCHIVED', label: 'Archived' },
]

/** The fields every shop has, whatever else is installed. */
export const STATIC_FIELDS: readonly RuleField[] = [
  { key: 'supplier', label: 'Supplier', kind: 'text', level: 'either', hint: "The variation's own supplier, or its listing's when it has none" },
  { key: 'brand', label: 'Brand', kind: 'text', level: 'variation', hint: 'The brand the feed sends, before any rule changes it' },
  { key: 'category', label: 'Category', kind: 'category', level: 'product', hint: 'Any category the product is filed in, and every category above it' },
  { key: 'range', label: 'Range', kind: 'text', level: 'either', hint: 'Whichever attribute you have said is your range' },
  { key: 'stock_quantity', label: 'Stock quantity', kind: 'number', level: 'variation', hint: 'Empty where stock is not counted' },
  { key: 'stock_status', label: 'Stock status', kind: 'choice', level: 'variation', choices: STOCK_STATUS_CHOICES },
  { key: 'price', label: 'Price', kind: 'number', level: 'variation', hint: 'The regular price Google is sent, with VAT' },
  { key: 'sale_price', label: 'Sale price', kind: 'number', level: 'variation', hint: 'Empty unless an offer is running' },
  // Kept, with the truth in its hint rather than a shorter list of choices: a
  // rule saved against Draft or Archived still reads back, and the picker says
  // plainly that neither ever reaches the feed.
  { key: 'status', label: 'Product status', kind: 'choice', level: 'product', choices: PRODUCT_STATUS_CHOICES, hint: 'Only active products go to Google at all, so in the feed this is always Active' },
  { key: 'has_image', label: 'Has a photo', kind: 'boolean', level: 'variation', choices: YES_NO },
  { key: 'has_gtin', label: 'Has a barcode (GTIN)', kind: 'boolean', level: 'variation', choices: YES_NO },
]

export const ATTRIBUTE_PREFIX = 'attr:'
export const OPTION_PREFIX = 'option:'

export function attributeFieldKey(attributeId: string): string {
  return `${ATTRIBUTE_PREFIX}${attributeId}`
}

export function optionFieldKey(optionName: string): string {
  return `${OPTION_PREFIX}${optionName.trim().toLowerCase()}`
}

/** The attribute a field reads, or null when it is not an attribute field. */
export function attributeIdOf(fieldKey: string): string | null {
  return fieldKey.startsWith(ATTRIBUTE_PREFIX) ? fieldKey.slice(ATTRIBUTE_PREFIX.length) || null : null
}

/**
 * The whole catalogue for one shop: the fixed fields, one per product
 * attribute (from whichever module publishes them), and one per variation
 * option name seen in the catalogue ("Seat Colour", "Width").
 *
 * Attributes are 'either': ticked on a variation they are its own, ticked on
 * the listing every variation carries them. Options are the variation's own by
 * definition - a listing has no colour, its variations do.
 */
export function buildFieldCatalogue(
  attributes: ReadonlyArray<{ id: string; name: string }>,
  optionNames: readonly string[],
): RuleField[] {
  const fields: RuleField[] = [...STATIC_FIELDS]
  for (const attribute of attributes) {
    fields.push({ key: attributeFieldKey(attribute.id), label: attribute.name, kind: 'text', level: 'either', hint: 'Product attribute' })
  }
  const seen = new Set<string>()
  for (const name of optionNames) {
    const key = optionFieldKey(name)
    if (seen.has(key) || !name.trim()) continue
    seen.add(key)
    fields.push({ key, label: `Option: ${name.trim()}`, kind: 'text', level: 'variation', hint: "A variation's own choice" })
  }
  return fields
}

const STATIC_BY_KEY = new Map(STATIC_FIELDS.map((field) => [field.key, field]))

/** Kind and level for any field key, including attribute and option fields,
 *  without needing the shop's catalogue in hand. Null for a key nothing
 *  recognises, which the evaluator treats as a condition that never holds. */
export function fieldMeta(key: string): { kind: FieldKind; level: FieldLevel } | null {
  const known = STATIC_BY_KEY.get(key)
  if (known) return { kind: known.kind, level: known.level }
  if (key.startsWith(ATTRIBUTE_PREFIX) && key.length > ATTRIBUTE_PREFIX.length) return { kind: 'text', level: 'either' }
  if (key.startsWith(OPTION_PREFIX) && key.length > OPTION_PREFIX.length) return { kind: 'text', level: 'variation' }
  return null
}

/** A number as an owner types one: "1,200", "£49.99", " 3 ". NaN for anything
 *  that is not one, which the builder refuses before it is saved. */
export function parseRuleNumber(raw: string): number {
  const cleaned = raw.replace(/[£$€,\s]/g, '')
  return cleaned === '' ? Number.NaN : Number(cleaned)
}

/** What the picker says about a field's level, so an owner can tell a
 *  variation's own answer from one it inherits. */
export const LEVEL_LABELS: Record<FieldLevel, string> = {
  product: 'Listing',
  variation: 'Each variation',
  either: 'Variation, else listing',
}
