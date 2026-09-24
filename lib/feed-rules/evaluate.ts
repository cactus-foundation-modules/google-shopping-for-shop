// Feed rules, evaluated: which rules each item meets, and what that decides.
//
// Pure. The feed build hands this a subject per item (what the item and its
// listing are, as plain facts) and the rule list, and gets back an outcome per
// item carrying its reasons. Nothing here reads a database, so the precedence
// below is exercised by unit tests rather than trusted.
//
// Precedence (owner's decision, 2026-09-22):
//
//  1. The owner's own choice on the product or variation beats every rule.
//     "Always send" keeps an item in however many Exclude rules match it;
//     "Never send" keeps it out whatever the rules say. A variation's own
//     choice beats its listing's.
//  2. Any matching Exclude rule keeps the item out, wherever it sits in the
//     list. Exclusion wins over every other action: a label on an item Google
//     is not sent is not a label.
//  3. Custom labels, title templates and identifier changes apply in list
//     order, and the FIRST matching rule wins each target: each of the five
//     label slots separately, the title, and each of the three identifier
//     changes separately. A later rule fills only what an earlier one left.
import { fieldMeta, parseRuleNumber, type FieldKind, type FieldLevel } from '@/modules/google-shopping-for-shop/lib/feed-rules/fields'
import {
  isRuleGroup,
  type CustomLabelSlot,
  type FeedRule,
  type RuleCondition,
  type RuleGroup,
  type RuleRef,
} from '@/modules/google-shopping-for-shop/lib/feed-rules/types'

// ----- Subjects --------------------------------------------------------------

/** One fact about an item. Text-like facts are lists (an attribute can hold
 *  several values, a category comes with its ancestors); numbers and yes/no
 *  facts are single. Null means "no answer", which is not the same as zero. */
export type FactValue = readonly string[] | number | boolean | null

/** Facts keyed by field key ('supplier', 'price', 'attr:<id>', ...). */
export type RuleFacts = Record<string, FactValue>

/** What the owner has said by hand about an item. */
export type ManualChoice = 'rules' | 'include' | 'exclude'

export type RuleSubject = {
  itemId: string
  /** What the owner calls it, for previews. */
  title: string
  /** The listing a variation belongs to; null for a product with none. */
  parentId: string | null
  /** The row's own facts. */
  own: RuleFacts
  /** The listing's facts, shared by every variation of it. Null when standalone. */
  parent: RuleFacts | null
  /** The effective hand choice: the variation's own where it has one that is
   *  not "follow the rules", else its listing's. */
  manual: ManualChoice
}

function isEmptyFact(value: FactValue | undefined): boolean {
  if (value === undefined || value === null) return true
  if (Array.isArray(value)) return value.length === 0
  return false
}

/** The fact a field reads for this subject, following the field's level. */
export function factFor(subject: RuleSubject, field: string, level: FieldLevel): FactValue {
  const own = subject.own[field]
  const parent = subject.parent?.[field]
  switch (level) {
    case 'variation':
      return own ?? null
    case 'product':
      // A standalone product is its own listing.
      return subject.parent ? parent ?? null : own ?? null
    case 'either':
      return isEmptyFact(own) ? parent ?? own ?? null : own ?? null
  }
}

// ----- Compiling conditions --------------------------------------------------

type Predicate = (subject: RuleSubject) => boolean

const never: Predicate = () => false

function lower(value: string): string {
  return value.trim().toLowerCase()
}

function textsOf(value: FactValue): string[] {
  if (value === null) return []
  if (Array.isArray(value)) return value.map(lower).filter(Boolean)
  if (typeof value === 'number') return [String(value)]
  if (typeof value === 'boolean') return [value ? 'yes' : 'no']
  return []
}

function targetsOf(condition: RuleCondition): string[] {
  const raw = Array.isArray(condition.value) ? condition.value : condition.value === undefined ? [] : [condition.value]
  return raw.map(lower).filter(Boolean)
}

function compileText(condition: RuleCondition, read: (s: RuleSubject) => FactValue): Predicate {
  const targets = targetsOf(condition)
  const target = targets[0] ?? ''
  switch (condition.operator) {
    case 'equals': return (s) => textsOf(read(s)).includes(target)
    case 'not_equals': return (s) => !textsOf(read(s)).includes(target)
    case 'contains': return (s) => textsOf(read(s)).some((v) => v.includes(target))
    case 'not_contains': return (s) => !textsOf(read(s)).some((v) => v.includes(target))
    case 'in_list': {
      const wanted = new Set(targets)
      return (s) => textsOf(read(s)).some((v) => wanted.has(v))
    }
    case 'is_empty': return (s) => textsOf(read(s)).length === 0
    case 'is_not_empty': return (s) => textsOf(read(s)).length > 0
    // Not offered for text; a stored rule that has one anyway never matches.
    case 'greater_than':
    case 'less_than':
      return never
  }
}

function numberOf(value: FactValue): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function compileNumber(condition: RuleCondition, read: (s: RuleSubject) => FactValue): Predicate {
  const raw = Array.isArray(condition.value) ? condition.value : condition.value === undefined ? [] : [condition.value]
  const targets = raw.map(parseRuleNumber).filter((n) => !Number.isNaN(n))
  const target = targets[0]
  // Money and stock are compared to the penny; a float that is 49.990000001
  // after grossing up is still £49.99.
  const same = (a: number, b: number) => Math.abs(a - b) < 0.005
  switch (condition.operator) {
    case 'equals':
      return target === undefined ? never : (s) => { const n = numberOf(read(s)); return n !== null && same(n, target) }
    case 'not_equals':
      return target === undefined ? never : (s) => { const n = numberOf(read(s)); return n === null || !same(n, target) }
    case 'greater_than':
      return target === undefined ? never : (s) => { const n = numberOf(read(s)); return n !== null && n > target && !same(n, target) }
    case 'less_than':
      return target === undefined ? never : (s) => { const n = numberOf(read(s)); return n !== null && n < target && !same(n, target) }
    case 'in_list':
      return (s) => { const n = numberOf(read(s)); return n !== null && targets.some((t) => same(n, t)) }
    case 'is_empty': return (s) => numberOf(read(s)) === null
    case 'is_not_empty': return (s) => numberOf(read(s)) !== null
    case 'contains':
    case 'not_contains':
      return never
  }
}

function compileBoolean(condition: RuleCondition, read: (s: RuleSubject) => FactValue): Predicate {
  if (condition.operator !== 'equals') return never
  const wanted = targetsOf(condition)[0]
  if (wanted !== 'yes' && wanted !== 'no') return never
  const expect = wanted === 'yes'
  return (s) => read(s) === expect
}

function compileCondition(condition: RuleCondition): Predicate {
  const meta = fieldMeta(condition.field)
  if (!meta) return never
  const read = (s: RuleSubject) => factFor(s, condition.field, meta.level)
  const byKind: Record<FieldKind, () => Predicate> = {
    // Choices and categories are lists of values like text; a category's list
    // already carries every ancestor, which is what makes "equals" read as "in
    // or under".
    text: () => compileText(condition, read),
    choice: () => compileText(condition, read),
    category: () => compileText(condition, read),
    number: () => compileNumber(condition, read),
    boolean: () => compileBoolean(condition, read),
  }
  return byKind[meta.kind]()
}

/** A rule's conditions as one test. An empty `all` holds and an empty `any`
 *  does not, as in logic - though the builder refuses to save either. */
export function compileGroup(group: RuleGroup): Predicate {
  const parts = group.items.map((item) => (isRuleGroup(item) ? compileGroup(item) : compileCondition(item)))
  if (group.op === 'all') return (s) => parts.every((part) => part(s))
  return (s) => parts.some((part) => part(s))
}

/** Whether one subject meets a condition tree. */
export function matchesConditions(group: RuleGroup, subject: RuleSubject): boolean {
  return compileGroup(group)(subject)
}

// ----- Outcomes --------------------------------------------------------------

export type Exclusion = { by: 'hand' } | { by: 'rule'; rule: RuleRef }

export type LabelOutcome = { value: string; rule: RuleRef }

export type IdentifierOutcome = {
  noIdentifiers?: RuleRef
  mpnFromSku?: RuleRef
  brand?: { value: string; rule: RuleRef }
}

export type RuleOutcome = {
  /** Every switched-on rule whose conditions this item meets, in list order. */
  matched: RuleRef[]
  /** Why the item is kept out of the feed; null when it goes. */
  exclusion: Exclusion | null
  /** An Exclude rule matched and the owner's own "always send" beat it. */
  keptInOverRule: RuleRef | null
  /** Filled label slots. Empty when the item is excluded. */
  labels: Partial<Record<CustomLabelSlot, LabelOutcome>>
  /** Empty when the item is excluded. */
  titleTemplate: { template: string; rule: RuleRef } | null
  identifiers: IdentifierOutcome
}

export const EMPTY_OUTCOME: RuleOutcome = Object.freeze({
  matched: [],
  exclusion: null,
  keptInOverRule: null,
  labels: {},
  titleTemplate: null,
  identifiers: {},
}) as RuleOutcome

type CompiledRule = { ref: RuleRef; rule: FeedRule; test: Predicate }

/** The switched-on rules in list order, each compiled once. */
export function compileRules(rules: readonly FeedRule[]): CompiledRule[] {
  return [...rules]
    .filter((rule) => rule.enabled)
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt))
    .map((rule) => ({ ref: { id: rule.id, name: rule.name }, rule, test: compileGroup(rule.conditions) }))
}

/** One subject against the compiled rule list. */
export function outcomeFor(compiled: readonly CompiledRule[], subject: RuleSubject): RuleOutcome {
  const matched: CompiledRule[] = compiled.filter((entry) => entry.test(subject))
  const firstExclude = matched.find((entry) => entry.rule.action.type === 'exclude')?.ref ?? null

  let exclusion: Exclusion | null = null
  let keptInOverRule: RuleRef | null = null
  if (subject.manual === 'exclude') exclusion = { by: 'hand' }
  else if (firstExclude && subject.manual === 'include') keptInOverRule = firstExclude
  else if (firstExclude) exclusion = { by: 'rule', rule: firstExclude }

  const outcome: RuleOutcome = {
    matched: matched.map((entry) => entry.ref),
    exclusion,
    keptInOverRule,
    labels: {},
    titleTemplate: null,
    identifiers: {},
  }
  if (exclusion) return outcome

  for (const { ref, rule } of matched) {
    const action = rule.action
    switch (action.type) {
      case 'exclude':
        break
      case 'custom_label':
        if (!outcome.labels[action.slot]) outcome.labels[action.slot] = { value: action.value, rule: ref }
        break
      case 'title_template':
        if (!outcome.titleTemplate) outcome.titleTemplate = { template: action.template, rule: ref }
        break
      case 'identifiers':
        if (action.mode === 'no_identifiers' && !outcome.identifiers.noIdentifiers) outcome.identifiers.noIdentifiers = ref
        if (action.mode === 'mpn_from_sku' && !outcome.identifiers.mpnFromSku) outcome.identifiers.mpnFromSku = ref
        if (action.mode === 'brand' && !outcome.identifiers.brand && action.brand?.trim()) {
          outcome.identifiers.brand = { value: action.brand.trim(), rule: ref }
        }
        break
    }
  }
  return outcome
}

/** Every subject against the rule list, keyed by item id. */
export function evaluateFeedRules(rules: readonly FeedRule[], subjects: Iterable<RuleSubject>): Map<string, RuleOutcome> {
  const compiled = compileRules(rules)
  const outcomes = new Map<string, RuleOutcome>()
  for (const subject of subjects) outcomes.set(subject.itemId, outcomeFor(compiled, subject))
  return outcomes
}
