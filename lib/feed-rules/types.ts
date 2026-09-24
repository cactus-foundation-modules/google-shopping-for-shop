// Feed rules: the shapes, and the one schema every rule is checked against.
//
// A rule is a set of conditions and one thing to do to every item they match:
// keep it out of the feed, put a custom label on it, send it a title template,
// or change what it says about its identifiers. Rules are kept in a list, and
// the list order is what decides between two rules that want the same field
// (lib/feed-rules/evaluate.ts has the precedence in full).
//
// Pure, and safe for the browser: the rule builder validates a draft with the
// very schema the server saves it through, so the two cannot disagree about
// what a valid rule is.
import { z } from 'zod'
import { OPERATORS_BY_KIND, parseRuleNumber, type FieldKind } from '@/modules/google-shopping-for-shop/lib/feed-rules/fields'

// ----- Conditions ------------------------------------------------------------

export const RULE_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'is_empty',
  'is_not_empty',
  'greater_than',
  'less_than',
  'in_list',
] as const
export type RuleOperator = (typeof RULE_OPERATORS)[number]

/** Operators that compare against nothing - the value is ignored. */
export const VALUELESS_OPERATORS: readonly RuleOperator[] = ['is_empty', 'is_not_empty']

export type RuleCondition = {
  /** A key from the field catalogue (lib/feed-rules/fields.ts): 'supplier',
   *  'price', 'attr:<attribute id>', 'option:<option name>'... */
  field: string
  operator: RuleOperator
  /** A single value for most operators, a list for `in_list`, absent for the
   *  two that compare against nothing. Numbers travel as text, the way the
   *  owner typed them, and are read as numbers by numeric fields only. */
  value?: string | string[]
}

export const GROUP_OPS = ['all', 'any'] as const
export type GroupOp = (typeof GROUP_OPS)[number]

/** `all` is AND, `any` is OR. Groups nest, so "(A and B) or C" is an `any`
 *  holding an `all` and a condition. */
export type RuleGroup = {
  op: GroupOp
  items: Array<RuleCondition | RuleGroup>
}

export function isRuleGroup(node: RuleCondition | RuleGroup): node is RuleGroup {
  return 'items' in node
}

// ----- Actions ---------------------------------------------------------------

/** Google's five free-text custom labels, custom_label_0 to custom_label_4. */
export const CUSTOM_LABEL_SLOTS = [0, 1, 2, 3, 4] as const
export type CustomLabelSlot = (typeof CUSTOM_LABEL_SLOTS)[number]

/** Google's limit on a custom label's value. */
export const CUSTOM_LABEL_MAX = 100

export const IDENTIFIER_MODES = ['no_identifiers', 'mpn_from_sku', 'brand'] as const
export type IdentifierMode = (typeof IDENTIFIER_MODES)[number]

export type RuleAction =
  | { type: 'exclude' }
  | { type: 'custom_label'; slot: CustomLabelSlot; value: string }
  | { type: 'title_template'; template: string }
  | { type: 'identifiers'; mode: IdentifierMode; brand?: string }

export const ACTION_TYPES = ['exclude', 'custom_label', 'title_template', 'identifiers'] as const
export type RuleActionType = (typeof ACTION_TYPES)[number]

// ----- Rules -----------------------------------------------------------------

export type FeedRule = {
  id: string
  name: string
  enabled: boolean
  /** 0 first. The list order the owner sees, and the order rules are tried in. */
  position: number
  conditions: RuleGroup
  action: RuleAction
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

/** Which rule did something, as it is shown back to the owner. */
export type RuleRef = { id: string; name: string }

// ----- Validation ------------------------------------------------------------

/** Deep enough for "(A and (B or C)) or D" and a little more; a tree deeper
 *  than this is a rule nobody will be able to read back next month. */
export const MAX_GROUP_DEPTH = 4
/** Across the whole tree. */
export const MAX_CONDITIONS = 50

const ConditionSchema = z.object({
  field: z.string().trim().min(1).max(200),
  operator: z.enum(RULE_OPERATORS),
  value: z.union([z.string().max(500), z.array(z.string().max(500)).max(500)]).optional(),
})

// Recursive: zod needs the type spelled out for a schema that refers to itself.
const GroupSchema: z.ZodType<RuleGroup> = z.lazy(() =>
  z.object({
    op: z.enum(GROUP_OPS),
    items: z.array(z.union([GroupSchema, ConditionSchema])).max(MAX_CONDITIONS),
  }),
)

const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('exclude') }),
  z.object({
    type: z.literal('custom_label'),
    slot: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    value: z.string().trim().min(1, 'Give the label a value').max(CUSTOM_LABEL_MAX, `Google takes up to ${CUSTOM_LABEL_MAX} characters in a custom label`),
  }),
  z.object({
    type: z.literal('title_template'),
    template: z.string().trim().min(1, 'Write the title template').max(500),
  }),
  z.object({
    type: z.literal('identifiers'),
    mode: z.enum(IDENTIFIER_MODES),
    brand: z.string().trim().max(70).optional(),
  }),
])

/** What the builder sends to be saved or previewed. */
export const RuleDraftSchema = z.object({
  name: z.string().trim().min(1, 'Give the rule a name').max(120),
  enabled: z.boolean(),
  conditions: GroupSchema,
  action: ActionSchema,
})
export type RuleDraft = z.infer<typeof RuleDraftSchema>

function depthOf(group: RuleGroup): number {
  let deepest = 0
  for (const item of group.items) if (isRuleGroup(item)) deepest = Math.max(deepest, depthOf(item))
  return deepest + 1
}

function conditionsIn(group: RuleGroup): RuleCondition[] {
  return group.items.flatMap((item) => (isRuleGroup(item) ? conditionsIn(item) : [item]))
}

function hasEmptyGroup(group: RuleGroup): boolean {
  return group.items.length === 0 || group.items.some((item) => isRuleGroup(item) && hasEmptyGroup(item))
}

/** Every condition in the tree, in reading order. */
export function flattenConditions(group: RuleGroup): RuleCondition[] {
  return conditionsIn(group)
}

/**
 * The checks a schema cannot express, in the owner's words. Empty when the
 * rule is fine. `kindOf` is asked about every field the rule names, and
 * answers null for one this shop does not have - so a rule pointing at an
 * attribute that has since been deleted is caught at save rather than quietly
 * matching nothing for ever.
 */
export function ruleProblems(draft: RuleDraft, kindOf: (field: string) => FieldKind | null): string[] {
  const problems: string[] = []
  const conditions = conditionsIn(draft.conditions)
  // A rule with no conditions matches every item in the shop. That is never
  // what somebody who pressed "Exclude" meant, so it is refused outright.
  if (conditions.length === 0) problems.push('Add at least one condition. A rule with none would catch every product in the shop.')
  else if (hasEmptyGroup(draft.conditions)) problems.push('One of the groups has nothing in it. Add a condition to it or remove it.')
  if (conditions.length > MAX_CONDITIONS) problems.push(`A rule can hold up to ${MAX_CONDITIONS} conditions.`)
  if (depthOf(draft.conditions) > MAX_GROUP_DEPTH) problems.push(`Groups can nest ${MAX_GROUP_DEPTH} deep at most.`)

  const seen = new Set<string>()
  const once = (message: string) => {
    if (seen.has(message)) return
    seen.add(message)
    problems.push(message)
  }
  for (const condition of conditions) {
    const kind = kindOf(condition.field)
    if (!kind) {
      once('One condition refers to a field this shop no longer has. Pick another.')
      continue
    }
    if (!OPERATORS_BY_KIND[kind].includes(condition.operator)) {
      once('One condition uses a comparison that field does not offer. Pick another.')
      continue
    }
    if (VALUELESS_OPERATORS.includes(condition.operator)) continue
    const values = (Array.isArray(condition.value) ? condition.value : [condition.value ?? '']).map((value) => value.trim())
    if (values.every((value) => value === '')) {
      once('One condition has nothing to compare against. Fill it in, or use "is empty".')
      continue
    }
    if (kind === 'number' && values.some((value) => value !== '' && Number.isNaN(parseRuleNumber(value)))) {
      once('One condition compares a number with something that is not one.')
    }
  }
  if (draft.action.type === 'identifiers' && draft.action.mode === 'brand' && !draft.action.brand?.trim()) {
    problems.push('Say which brand to send.')
  }
  return problems
}

/** The same draft with every string trimmed and the value shaped for its
 *  operator, so two drafts that differ only in stray spaces compare equal and
 *  the stored JSON is tidy. */
export function normaliseDraft(draft: RuleDraft): RuleDraft {
  const tidyGroup = (group: RuleGroup): RuleGroup => ({
    op: group.op,
    items: group.items.map((item) => (isRuleGroup(item) ? tidyGroup(item) : tidyCondition(item))),
  })
  const tidyCondition = (condition: RuleCondition): RuleCondition => {
    const field = condition.field.trim()
    if (VALUELESS_OPERATORS.includes(condition.operator)) return { field, operator: condition.operator }
    if (condition.operator === 'in_list') {
      const raw = Array.isArray(condition.value) ? condition.value : (condition.value ?? '').split('\n')
      return { field, operator: 'in_list', value: raw.map((value) => value.trim()).filter(Boolean) }
    }
    const single = Array.isArray(condition.value) ? condition.value[0] ?? '' : condition.value ?? ''
    return { field, operator: condition.operator, value: single.trim() }
  }
  const action: RuleAction = draft.action.type === 'identifiers'
    ? draft.action.mode === 'brand'
      ? { type: 'identifiers', mode: 'brand', brand: draft.action.brand?.trim() ?? '' }
      : { type: 'identifiers', mode: draft.action.mode }
    : draft.action
  return { name: draft.name.trim(), enabled: draft.enabled, conditions: tidyGroup(draft.conditions), action }
}
