// Undo for the feed rules' change log entries.
//
// Worked out from the SHAPE of the entry's before and after rather than its
// action name, because an undo is logged as an entry of its own with the pair
// swapped round - and undoing that has to work too:
//
//   nothing before, a rule after      -> it was added: take it away
//   a rule before, nothing after      -> it was deleted: put it back
//   a rule before, a rule after       -> it was changed: put the old one back
//   positions before and after        -> it was reordered: put the old order back
//   a range attribute before and after -> the range setting: put it back
//
// Conservative, like every undo in the log: each one only goes ahead where the
// rule is still exactly as the change left it. A rule edited since is left to
// whoever edited it, and the answer counts it as skipped.
import { registerUndoHandler, type UndoHandler } from '@/modules/google-shopping-for-shop/lib/change-log'
import {
  canonicalJson,
  draftOf,
  getFeedRule,
  getRangeAttributeId,
  insertRule,
  listFeedRules,
  writePositions,
  writeRangeAttributeId,
  writeRuleContent,
  type PositionSnapshot,
} from '@/modules/google-shopping-for-shop/lib/feed-rules/store'
import { RuleDraftSchema, type FeedRule } from '@/modules/google-shopping-for-shop/lib/feed-rules/types'

type Snapshot = Pick<FeedRule, 'id' | 'name' | 'enabled' | 'position' | 'conditions' | 'action' | 'createdBy' | 'createdAt'>

function asSnapshot(value: unknown): Snapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || typeof raw.position !== 'number') return null
  const draft = RuleDraftSchema.safeParse({ name: raw.name, enabled: raw.enabled, conditions: raw.conditions, action: raw.action })
  if (!draft.success) return null
  return {
    id: raw.id,
    position: raw.position,
    ...draft.data,
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
  }
}

function asPositions(value: unknown): PositionSnapshot | null {
  if (!Array.isArray(value)) return null
  const out: PositionSnapshot = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null
    const { id, position } = entry as Record<string, unknown>
    if (typeof id !== 'string' || typeof position !== 'number') return null
    out.push({ id, position })
  }
  return out
}

function asRange(value: unknown): { rangeAttributeId: string | null } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('rangeAttributeId' in value)) return null
  const id = (value as { rangeAttributeId: unknown }).rangeAttributeId
  return { rangeAttributeId: typeof id === 'string' && id.trim() ? id : null }
}

function sameRule(a: Pick<FeedRule, 'name' | 'enabled' | 'conditions' | 'action'>, b: Pick<FeedRule, 'name' | 'enabled' | 'conditions' | 'action'>): boolean {
  return canonicalJson(draftOf(a)) === canonicalJson(draftOf(b))
}

const undoFeedRules: UndoHandler = async ({ entry, tx }) => {
  const { before, after } = entry

  // The range setting.
  const rangeBefore = asRange(before)
  const rangeAfter = asRange(after)
  if (rangeBefore && rangeAfter) {
    const current = await getRangeAttributeId(tx)
    if (current !== rangeAfter.rangeAttributeId) return { restored: 0, skipped: 1 }
    await writeRangeAttributeId(tx, rangeBefore.rangeAttributeId)
    return { restored: 1, skipped: 0 }
  }

  // A reorder: only while the list is still in the order it left.
  const positionsBefore = asPositions(before)
  const positionsAfter = asPositions(after)
  if (positionsBefore && positionsAfter) {
    await tx.$executeRaw`LOCK TABLE "gsf_feed_rules" IN SHARE ROW EXCLUSIVE MODE`
    const current = await listFeedRules(tx)
    const now = new Map(current.map((rule) => [rule.id, rule.position]))
    const untouched = positionsAfter.length === current.length && positionsAfter.every((entry) => now.get(entry.id) === entry.position)
    if (!untouched) return { restored: 0, skipped: 1 }
    await writePositions(tx, positionsBefore.filter((entry) => now.has(entry.id)))
    return { restored: 1, skipped: 0 }
  }

  const ruleBefore = asSnapshot(before)
  const ruleAfter = asSnapshot(after)

  // Added: take it away, if nobody has touched it since.
  if (!ruleBefore && ruleAfter && (before === null || before === undefined)) {
    const current = await getFeedRule(ruleAfter.id, tx, true)
    if (!current || !sameRule(current, ruleAfter)) return { restored: 0, skipped: 1 }
    await tx.$executeRaw`DELETE FROM "gsf_feed_rules" WHERE "id" = ${ruleAfter.id}`
    return { restored: 1, skipped: 0 }
  }

  // Deleted: put it back where it was, unless something has taken its id.
  if (ruleBefore && !ruleAfter && (after === null || after === undefined)) {
    const current = await getFeedRule(ruleBefore.id, tx, true)
    if (current) return { restored: 0, skipped: 1 }
    await insertRule(tx, {
      id: ruleBefore.id,
      draft: draftOf(ruleBefore),
      position: ruleBefore.position,
      createdBy: ruleBefore.createdBy,
      createdAt: ruleBefore.createdAt,
    })
    return { restored: 1, skipped: 0 }
  }

  // Changed: back to how it was, if it is still as the change left it.
  if (ruleBefore && ruleAfter) {
    const current = await getFeedRule(ruleAfter.id, tx, true)
    if (!current || !sameRule(current, ruleAfter)) return { restored: 0, skipped: 1 }
    await writeRuleContent(tx, ruleAfter.id, draftOf(ruleBefore))
    return { restored: 1, skipped: 0 }
  }

  throw new Error('That change cannot be undone')
}

registerUndoHandler('feed-rules', undoFeedRules)
