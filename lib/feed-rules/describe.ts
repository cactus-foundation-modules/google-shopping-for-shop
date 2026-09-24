// A rule in plain English, for the list and the change log's neighbours.
// Pure; the browser renders these.
import { operatorLabel, fieldMeta, type RuleField } from '@/modules/google-shopping-for-shop/lib/feed-rules/fields'
import {
  VALUELESS_OPERATORS,
  isRuleGroup,
  type RuleAction,
  type RuleCondition,
  type RuleGroup,
} from '@/modules/google-shopping-for-shop/lib/feed-rules/types'

export type DescribeContext = {
  fields: ReadonlyMap<string, RuleField>
  /** Category id to its full trail. */
  categories: ReadonlyMap<string, string>
}

function valueText(condition: RuleCondition, ctx: DescribeContext): string {
  const field = ctx.fields.get(condition.field)
  const values = Array.isArray(condition.value) ? condition.value : condition.value === undefined ? [] : [condition.value]
  const shown = values.map((value) => {
    if (field?.kind === 'category') return ctx.categories.get(value) ?? 'a category that has been deleted'
    const choice = field?.choices?.find((c) => c.value === value)
    return choice ? choice.label : `"${value}"`
  })
  if (shown.length <= 1) return shown[0] ?? ''
  if (shown.length <= 4) return shown.join(', ')
  return `${shown.slice(0, 3).join(', ')} and ${shown.length - 3} more`
}

export function describeCondition(condition: RuleCondition, ctx: DescribeContext): string {
  const field = ctx.fields.get(condition.field)
  const kind = field?.kind ?? fieldMeta(condition.field)?.kind ?? 'text'
  const label = field?.label ?? 'a field this shop no longer has'
  const op = operatorLabel(condition.operator, kind)
  if (VALUELESS_OPERATORS.includes(condition.operator)) return `${label} ${op}`
  return `${label} ${op} ${valueText(condition, ctx)}`
}

export function describeGroup(group: RuleGroup, ctx: DescribeContext, nested = false): string {
  const joiner = group.op === 'all' ? ' and ' : ' or '
  const parts = group.items.map((item) => (isRuleGroup(item) ? describeGroup(item, ctx, true) : describeCondition(item, ctx)))
  const text = parts.join(joiner)
  return nested && parts.length > 1 ? `(${text})` : text
}

export function describeAction(action: RuleAction): string {
  switch (action.type) {
    case 'exclude':
      return 'Keep out of the feed'
    case 'custom_label':
      return `Custom label ${action.slot}: "${action.value}"`
    case 'title_template':
      return `Title: ${action.template}`
    case 'identifiers':
      if (action.mode === 'no_identifiers') return 'Send as having no identifiers'
      if (action.mode === 'mpn_from_sku') return 'Send the SKU as the MPN'
      return `Send the brand as "${action.brand ?? ''}"`
  }
}
