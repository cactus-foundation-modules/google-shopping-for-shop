// What saving a rule would do, worked out before it is saved.
//
// Pure. Runs the whole rule list twice over the catalogue the workbench
// already holds - once as it stands, once with the draft in place - and
// reports every item whose outcome would differ, with the reason in the
// owner's words. The whole list rather than the draft alone, because a rule
// never acts on its own: an Exclude an earlier rule already applies changes
// nothing, a label slot an earlier rule fills is not this rule's to fill, and
// the owner's own "always send" beats the lot.
import {
  compileGroup,
  evaluateFeedRules,
  EMPTY_OUTCOME,
  type RuleOutcome,
  type RuleSubject,
} from '@/modules/google-shopping-for-shop/lib/feed-rules/evaluate'
import { CUSTOM_LABEL_SLOTS, type FeedRule, type RuleDraft } from '@/modules/google-shopping-for-shop/lib/feed-rules/types'

export type PreviewChangeKind = 'leaves' | 'returns' | 'label' | 'title' | 'identifiers'

export type PreviewSample = { id: string; title: string; changes: string[] }

export type RulePreview = {
  /** Items the draft's conditions match, in the feed or out of it. */
  matched: number
  /** Items whose outcome would change, by kind. One item can be in several. */
  changes: Record<PreviewChangeKind, number>
  /** Items with any change at all. */
  affected: number
  /** Matched, but kept as they are by the owner's own choice on them. */
  heldByHand: number
  /** Matched, but already as the rule would leave them - an earlier rule
   *  does the same job, or they already carry what it sets. */
  alreadyCovered: number
  /** The first affected items, in feed order. */
  samples: PreviewSample[]
  /** How many items the preview looked at. */
  catalogue: number
}

/** What one rule catches today, whether it is switched on or not. */
export type RuleMatchCount = {
  /** Items whose conditions the rule meets. */
  matched: number
  /** For an Exclude rule that is switched OFF: how many items now going to
   *  Google it would take out the moment it was switched on. Zero for every
   *  other action, and for a rule already doing its work. */
  wouldExclude: number
}

/**
 * How many items each rule catches, counted over the same subjects the feed
 * was built from. Switched-off rules are counted too, which the evaluator
 * cannot do - it only ever runs the rules that are on - and which is what lets
 * the screen say what switching one on would cost before it is switched on.
 */
export function countRuleMatches(
  rules: readonly FeedRule[],
  subjects: readonly RuleSubject[],
  current: ReadonlyMap<string, RuleOutcome>,
): Map<string, RuleMatchCount> {
  const counts = new Map<string, RuleMatchCount>()
  for (const rule of rules) {
    const matches = compileGroup(rule.conditions)
    let matched = 0
    let wouldExclude = 0
    for (const subject of subjects) {
      if (!matches(subject)) continue
      matched++
      if (rule.enabled || rule.action.type !== 'exclude') continue
      // "Always send" beats every rule, and an item already held back by
      // something else is not this rule's to take out.
      if (subject.manual === 'include') continue
      if ((current.get(subject.itemId)?.exclusion ?? null) === null) wouldExclude++
    }
    counts.set(rule.id, { matched, wouldExclude })
  }
  return counts
}

/** The id a draft stands under while it has none of its own. */
export const DRAFT_RULE_ID = '__draft__'

const SAMPLE_LIMIT = 60

function identifiersText(outcome: RuleOutcome): string {
  const ids = outcome.identifiers
  return [ids.noIdentifiers ? 'none' : '', ids.mpnFromSku ? 'sku' : '', ids.brand?.value ?? ''].join('\u0001')
}

function describe(before: RuleOutcome, after: RuleOutcome): Array<{ kind: PreviewChangeKind; text: string }> {
  const out: Array<{ kind: PreviewChangeKind; text: string }> = []
  const wasIn = before.exclusion === null
  const isIn = after.exclusion === null
  if (wasIn && !isIn) out.push({ kind: 'leaves', text: 'Would be kept out of the feed' })
  if (!wasIn && isIn) out.push({ kind: 'returns', text: 'Would go back into the feed' })
  if (!isIn) return out
  for (const slot of CUSTOM_LABEL_SLOTS) {
    const from = before.labels[slot]?.value
    const to = after.labels[slot]?.value
    if (from === to) continue
    if (to === undefined) out.push({ kind: 'label', text: `Custom label ${slot} cleared (was "${from}")` })
    else out.push({ kind: 'label', text: from === undefined ? `Custom label ${slot} set to "${to}"` : `Custom label ${slot}: "${from}" becomes "${to}"` })
  }
  if ((before.titleTemplate?.template ?? '') !== (after.titleTemplate?.template ?? '')) {
    out.push({ kind: 'title', text: after.titleTemplate ? `Title template: ${after.titleTemplate.template}` : 'Title template taken away' })
  }
  if (identifiersText(before) !== identifiersText(after)) {
    const ids = after.identifiers
    const parts = [
      ids.brand ? `brand sent as "${ids.brand.value}"` : '',
      ids.mpnFromSku ? 'MPN from the SKU' : '',
      ids.noIdentifiers ? 'sent as having no identifiers' : '',
    ].filter(Boolean)
    out.push({ kind: 'identifiers', text: parts.length > 0 ? `Identifiers: ${parts.join(', ')}` : 'Identifier changes taken away' })
  }
  return out
}

/**
 * The difference `draft` would make, saved into the list at `editingId`'s
 * place (or at the end when new). The draft is previewed as switched on,
 * whatever its own switch says: a preview of a rule that does nothing would
 * tell the owner nothing. The screen says so when the draft is off.
 */
export function previewRule(
  rules: readonly FeedRule[],
  draft: RuleDraft,
  editingId: string | null,
  subjects: readonly RuleSubject[],
  current: ReadonlyMap<string, RuleOutcome>,
): RulePreview {
  const existing = editingId ? rules.find((rule) => rule.id === editingId) : undefined
  const lastPosition = rules.reduce((max, rule) => Math.max(max, rule.position), -1)
  const now = new Date().toISOString()
  const candidate: FeedRule = {
    id: existing?.id ?? DRAFT_RULE_ID,
    name: draft.name,
    enabled: true,
    position: existing?.position ?? lastPosition + 1,
    conditions: draft.conditions,
    action: draft.action,
    createdBy: existing?.createdBy ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  const nextRules = existing ? rules.map((rule) => (rule.id === existing.id ? candidate : rule)) : [...rules, candidate]
  const next = evaluateFeedRules(nextRules, subjects)
  const matches = compileGroup(draft.conditions)

  const changes: Record<PreviewChangeKind, number> = { leaves: 0, returns: 0, label: 0, title: 0, identifiers: 0 }
  const samples: PreviewSample[] = []
  let matched = 0
  let affected = 0
  let heldByHand = 0
  let alreadyCovered = 0

  for (const subject of subjects) {
    const isMatch = matches(subject)
    if (isMatch) matched++
    const before = current.get(subject.itemId) ?? EMPTY_OUTCOME
    const after = next.get(subject.itemId) ?? EMPTY_OUTCOME
    const found = describe(before, after)
    if (found.length > 0) {
      affected++
      for (const kind of new Set(found.map((entry) => entry.kind))) changes[kind]++
      if (samples.length < SAMPLE_LIMIT) samples.push({ id: subject.itemId, title: subject.title, changes: found.map((entry) => entry.text) })
    } else if (isMatch) {
      if (subject.manual !== 'rules') heldByHand++
      else alreadyCovered++
    }
  }

  return { matched, changes, affected, heldByHand, alreadyCovered, samples, catalogue: subjects.length }
}
