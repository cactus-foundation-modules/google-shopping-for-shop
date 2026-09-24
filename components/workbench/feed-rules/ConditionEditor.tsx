'use client'

// The AND/OR builder: a group of conditions and groups, nesting as deep as
// types.ts allows. Each group says whether ALL or ANY of what is in it must
// hold; a condition is a field, a comparison and a value, and the value box
// changes shape with the field (a list of choices, a category picker, a yes/no,
// a number, or free text with suggestions).
//
// Every field in the picker says whose answer it reads - the listing's, each
// variation's own, or the variation's with the listing's behind it - because
// "Supplier is X" on a variation means something different depending on which.
import { useId } from 'react'
import {
  LEVEL_LABELS,
  OPERATORS_BY_KIND,
  operatorLabel,
  type RuleField,
} from '@/modules/google-shopping-for-shop/lib/feed-rules/fields'
import {
  GROUP_OPS,
  MAX_GROUP_DEPTH,
  RULE_OPERATORS,
  VALUELESS_OPERATORS,
  isRuleGroup,
  type RuleCondition,
  type RuleGroup,
  type RuleOperator,
} from '@/modules/google-shopping-for-shop/lib/feed-rules/types'
import type { CategoryOption } from '@/modules/google-shopping-for-shop/lib/feed-rules/category-options'

export type BuilderContext = {
  fields: RuleField[]
  fieldByKey: ReadonlyMap<string, RuleField>
  categories: CategoryOption[]
  /** Values already in the catalogue, by field key, for the text boxes. */
  suggestions: Record<string, string[]>
  disabled: boolean
}

export function blankCondition(fields: readonly RuleField[]): RuleCondition {
  const first = fields[0]
  return { field: first?.key ?? 'supplier', operator: 'equals', value: first?.kind === 'boolean' ? 'yes' : '' }
}

function defaultValueFor(field: RuleField | undefined, operator: RuleOperator): string | string[] | undefined {
  if (VALUELESS_OPERATORS.includes(operator)) return undefined
  if (operator === 'in_list') return []
  if (field?.kind === 'boolean') return 'yes'
  if (field?.kind === 'choice') return field.choices?.[0]?.value ?? ''
  return ''
}

function asOperator(value: string): RuleOperator {
  return RULE_OPERATORS.find((op) => op === value) ?? 'equals'
}

function FieldPicker({ value, ctx, onChange, label }: { value: string; ctx: BuilderContext; onChange: (key: string) => void; label: string }) {
  const known = ctx.fieldByKey.has(value)
  const groups: Array<{ name: string; fields: RuleField[] }> = [
    { name: 'Product, price and stock', fields: ctx.fields.filter((f) => !f.key.startsWith('attr:') && !f.key.startsWith('option:')) },
    { name: 'Product attributes', fields: ctx.fields.filter((f) => f.key.startsWith('attr:')) },
    { name: 'Variation options', fields: ctx.fields.filter((f) => f.key.startsWith('option:')) },
  ]
  return (
    <select className="gsw-select gsr-field" aria-label={label} value={value} disabled={ctx.disabled} onChange={(e) => onChange(e.target.value)}>
      {!known && <option value={value}>A field this shop no longer has</option>}
      {groups.filter((g) => g.fields.length > 0).map((group) => (
        <optgroup key={group.name} label={group.name}>
          {group.fields.map((field) => (
            <option key={field.key} value={field.key}>{field.label} · {LEVEL_LABELS[field.level]}</option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

function ValueInput({ condition, field, ctx, onChange, label }: {
  condition: RuleCondition
  field: RuleField | undefined
  ctx: BuilderContext
  onChange: (value: string | string[]) => void
  label: string
}) {
  const listId = useId()
  if (VALUELESS_OPERATORS.includes(condition.operator)) return null
  const kind = field?.kind ?? 'text'
  const values = Array.isArray(condition.value) ? condition.value : condition.value ? [condition.value] : []
  const single = values[0] ?? ''

  if (kind === 'boolean' || (kind === 'choice' && condition.operator !== 'in_list')) {
    const choices = field?.choices ?? []
    return (
      <select className="gsw-select" aria-label={label} value={single} disabled={ctx.disabled} onChange={(e) => onChange(e.target.value)}>
        {choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
      </select>
    )
  }

  if (kind === 'category' || kind === 'choice') {
    const options = kind === 'category' ? ctx.categories.map((c) => ({ value: c.id, label: c.path })) : field?.choices ?? []
    if (condition.operator === 'in_list') {
      return (
        <select
          multiple
          className="gsw-select gsr-multi"
          aria-label={`${label} (hold Ctrl or Cmd to pick several)`}
          value={values}
          disabled={ctx.disabled}
          onChange={(e) => onChange([...e.target.selectedOptions].map((option) => option.value))}
        >
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      )
    }
    return (
      <select className="gsw-select gsr-value" aria-label={label} value={single} disabled={ctx.disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">Pick one…</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    )
  }

  if (condition.operator === 'in_list') {
    return (
      <textarea
        className="gsr-textarea"
        aria-label={`${label}, one per line`}
        placeholder="One per line"
        rows={3}
        value={values.join('\n')}
        disabled={ctx.disabled}
        onChange={(e) => onChange(e.target.value.split('\n'))}
      />
    )
  }

  const suggestions = ctx.suggestions[condition.field] ?? []
  return (
    <>
      <input
        className="gsr-input"
        type="text"
        inputMode={kind === 'number' ? 'decimal' : undefined}
        aria-label={label}
        placeholder={kind === 'number' ? 'A number' : 'Value'}
        value={single}
        list={suggestions.length > 0 ? listId : undefined}
        disabled={ctx.disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((s) => <option key={s} value={s} />)}
        </datalist>
      )}
    </>
  )
}

function ConditionRow({ condition, ctx, onChange, onRemove, index }: {
  condition: RuleCondition
  ctx: BuilderContext
  onChange: (next: RuleCondition) => void
  onRemove: () => void
  index: number
}) {
  const field = ctx.fieldByKey.get(condition.field)
  const operators = OPERATORS_BY_KIND[field?.kind ?? 'text']
  const label = `Condition ${index + 1}`
  return (
    <div className="gsr-condition">
      <FieldPicker
        value={condition.field}
        ctx={ctx}
        label={`${label}: field`}
        onChange={(key) => {
          const next = ctx.fieldByKey.get(key)
          const allowed = OPERATORS_BY_KIND[next?.kind ?? 'text']
          const operator = allowed.includes(condition.operator) ? condition.operator : allowed[0] ?? 'equals'
          onChange({ field: key, operator, value: defaultValueFor(next, operator) })
        }}
      />
      <select
        className="gsw-select"
        aria-label={`${label}: comparison`}
        value={condition.operator}
        disabled={ctx.disabled}
        onChange={(e) => {
          const operator = asOperator(e.target.value)
          const keepValue = !VALUELESS_OPERATORS.includes(operator) && (operator === 'in_list') === (condition.operator === 'in_list')
          onChange({ field: condition.field, operator, value: keepValue ? condition.value : defaultValueFor(field, operator) })
        }}
      >
        {!operators.includes(condition.operator) && <option value={condition.operator}>{operatorLabel(condition.operator, field?.kind ?? 'text')}</option>}
        {operators.map((op) => <option key={op} value={op}>{operatorLabel(op, field?.kind ?? 'text')}</option>)}
      </select>
      <ValueInput condition={condition} field={field} ctx={ctx} label={`${label}: value`} onChange={(value) => onChange({ ...condition, value })} />
      <button type="button" className="gsw-search-clear" aria-label={`Remove ${label.toLowerCase()}`} disabled={ctx.disabled} onClick={onRemove}>×</button>
    </div>
  )
}

type GroupProps = {
  group: RuleGroup
  ctx: BuilderContext
  onChange: (next: RuleGroup) => void
  /** Absent on the outermost group, which cannot be removed. */
  onRemove?: () => void
  depth?: number
}

export function ConditionGroupEditor({ group, ctx, onChange, onRemove, depth = 1 }: GroupProps) {
  const replaceAt = (index: number, item: RuleCondition | RuleGroup) =>
    onChange({ ...group, items: group.items.map((existing, i) => (i === index ? item : existing)) })
  const removeAt = (index: number) => onChange({ ...group, items: group.items.filter((_item, i) => i !== index) })
  const joiner = group.op === 'all' ? 'and' : 'or'

  return (
    <div className={`gsr-group${depth > 1 ? ' is-nested' : ''}`}>
      <div className="gsr-group-head">
        <span className="gsw-small">Match</span>
        <select
          className="gsw-select"
          aria-label={depth > 1 ? 'How this group combines its conditions' : 'How the conditions combine'}
          value={group.op}
          disabled={ctx.disabled}
          onChange={(e) => onChange({ ...group, op: GROUP_OPS.find((op) => op === e.target.value) ?? 'all' })}
        >
          <option value="all">all of these (AND)</option>
          <option value="any">any of these (OR)</option>
        </select>
        {onRemove && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={ctx.disabled} onClick={onRemove}>Remove group</button>
        )}
      </div>
      {group.items.length === 0 && <p className="gsw-muted gsw-small gsr-empty">Nothing in this group yet.</p>}
      {group.items.map((item, index) => (
        <div key={index} className="gsr-item">
          {index > 0 && <span className="gsr-joiner" aria-hidden>{joiner}</span>}
          {isRuleGroup(item) ? (
            <ConditionGroupEditor
              group={item}
              ctx={ctx}
              depth={depth + 1}
              onChange={(next) => replaceAt(index, next)}
              onRemove={() => removeAt(index)}
            />
          ) : (
            <ConditionRow
              condition={item}
              ctx={ctx}
              index={index}
              onChange={(next) => replaceAt(index, next)}
              onRemove={() => removeAt(index)}
            />
          )}
        </div>
      ))}
      <div className="gsr-group-actions">
        <button type="button" className="btn btn-secondary btn-sm" disabled={ctx.disabled} onClick={() => onChange({ ...group, items: [...group.items, blankCondition(ctx.fields)] })}>
          Add condition
        </button>
        {depth < MAX_GROUP_DEPTH && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={ctx.disabled}
            onClick={() => onChange({ ...group, items: [...group.items, { op: group.op === 'all' ? 'any' : 'all', items: [blankCondition(ctx.fields)] }] })}
          >
            Add a group ({group.op === 'all' ? 'OR' : 'AND'} inside)
          </button>
        )}
      </div>
    </div>
  )
}
