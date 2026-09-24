// Feed rules, stored: gsf_feed_rules, and every write to it logged.
//
// Each write and its change log entry land in one transaction, so the log
// never records a change that did not happen, or misses one that did. The
// entries carry whole-rule snapshots; lib/feed-rules/undo.ts reads them back.
import { prisma, type PrismaTransactionClient } from '@/lib/db/prisma'
import { pruneChangeLog, recordChange } from '@/modules/google-shopping-for-shop/lib/change-log'
import {
  RuleDraftSchema,
  type FeedRule,
  type RuleAction,
  type RuleDraft,
  type RuleGroup,
} from '@/modules/google-shopping-for-shop/lib/feed-rules/types'
import { canonicalJson } from '@/modules/google-shopping-for-shop/lib/feed-rules/canonical'

export { canonicalJson }

export const TRANSACTION_OPTIONS = { timeout: 50_000, maxWait: 10_000 } as const

type Row = {
  id: string
  name: string
  enabled: boolean
  position: number
  conditions: unknown
  action: unknown
  created_by: string | null
  created_at: Date
  updated_at: Date
}

/** A stored rule whose jsonb no longer passes the schema - written by a later
 *  version, or edited by hand - is read as switched off with no conditions,
 *  rather than thrown on. The feed goes on being served, and the rule shows in
 *  the list for the owner to fix or delete. */
const BROKEN_CONDITIONS: RuleGroup = { op: 'all', items: [] }

function toRule(row: Row): FeedRule {
  const parsed = RuleDraftSchema.safeParse({ name: row.name, enabled: row.enabled, conditions: row.conditions, action: row.action })
  return {
    id: row.id,
    name: row.name,
    enabled: parsed.success ? row.enabled : false,
    position: row.position,
    conditions: parsed.success ? parsed.data.conditions : BROKEN_CONDITIONS,
    action: parsed.success ? parsed.data.action : { type: 'exclude' },
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

const SELECT = 'SELECT "id", "name", "enabled", "position", "conditions", "action", "created_by", "created_at", "updated_at" FROM "gsf_feed_rules"'

/** Every rule, in list order. */
export async function listFeedRules(db: PrismaTransactionClient = prisma): Promise<FeedRule[]> {
  const rows = await db.$queryRawUnsafe<Row[]>(`${SELECT} ORDER BY "position" ASC, "created_at" ASC, "id" ASC`)
  return rows.map(toRule)
}

export async function getFeedRule(id: string, db: PrismaTransactionClient = prisma, lock = false): Promise<FeedRule | null> {
  const rows = lock
    ? await db.$queryRawUnsafe<Row[]>(`${SELECT} WHERE "id" = $1 FOR UPDATE`, id)
    : await db.$queryRawUnsafe<Row[]>(`${SELECT} WHERE "id" = $1`, id)
  return rows[0] ? toRule(rows[0]) : null
}

/** What a snapshot in the change log holds: the rule as it stood. */
export type RuleSnapshot = FeedRule

/** One rule's place in the list, for reorder entries. */
export type PositionSnapshot = Array<{ id: string; position: number }>

// ----- Writes ----------------------------------------------------------------

export async function insertRule(
  tx: PrismaTransactionClient,
  input: { id?: string; draft: RuleDraft; position: number; createdBy: string | null; createdAt?: string },
): Promise<FeedRule> {
  const conditions = JSON.stringify(input.draft.conditions)
  const action = JSON.stringify(input.draft.action)
  // Put back as it was on a restore, so an undone delete keeps its place among
  // rules sharing a position. ISO text in, read as UTC, which is how every
  // timestamp column here is written and read.
  const createdAt = input.createdAt ?? new Date().toISOString()
  const rows = input.id
    ? await tx.$queryRaw<Row[]>`
        INSERT INTO "gsf_feed_rules" ("id", "name", "enabled", "position", "conditions", "action", "created_by", "created_at", "updated_at")
        VALUES (${input.id}, ${input.draft.name}, ${input.draft.enabled}, ${input.position}::int, ${conditions}::jsonb, ${action}::jsonb, ${input.createdBy}, (${createdAt}::timestamptz AT TIME ZONE 'UTC'), CURRENT_TIMESTAMP)
        RETURNING "id", "name", "enabled", "position", "conditions", "action", "created_by", "created_at", "updated_at"
      `
    : await tx.$queryRaw<Row[]>`
        INSERT INTO "gsf_feed_rules" ("name", "enabled", "position", "conditions", "action", "created_by")
        VALUES (${input.draft.name}, ${input.draft.enabled}, ${input.position}::int, ${conditions}::jsonb, ${action}::jsonb, ${input.createdBy})
        RETURNING "id", "name", "enabled", "position", "conditions", "action", "created_by", "created_at", "updated_at"
      `
  const row = rows[0]
  if (!row) throw new Error('Could not save that rule')
  return toRule(row)
}

export async function writeRuleContent(tx: PrismaTransactionClient, id: string, draft: RuleDraft): Promise<FeedRule | null> {
  const rows = await tx.$queryRaw<Row[]>`
    UPDATE "gsf_feed_rules" SET
      "name" = ${draft.name},
      "enabled" = ${draft.enabled},
      "conditions" = ${JSON.stringify(draft.conditions)}::jsonb,
      "action" = ${JSON.stringify(draft.action)}::jsonb,
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${id}
    RETURNING "id", "name", "enabled", "position", "conditions", "action", "created_by", "created_at", "updated_at"
  `
  return rows[0] ? toRule(rows[0]) : null
}

export async function writePositions(tx: PrismaTransactionClient, positions: PositionSnapshot): Promise<void> {
  if (positions.length === 0) return
  const ids = positions.map((entry) => entry.id)
  const values = positions.map((entry) => entry.position)
  await tx.$executeRaw`
    UPDATE "gsf_feed_rules" r SET "position" = v."position", "updated_at" = CURRENT_TIMESTAMP
    FROM unnest(${ids}::text[], ${values}::int[]) AS v("id", "position")
    WHERE r."id" = v."id" AND r."position" IS DISTINCT FROM v."position"
  `
}

/** The part of a rule the owner edits, as a draft. */
export function draftOf(rule: Pick<FeedRule, 'name' | 'enabled' | 'conditions' | 'action'>): RuleDraft {
  return { name: rule.name, enabled: rule.enabled, conditions: rule.conditions, action: rule.action as RuleAction }
}

function quoted(name: string): string {
  return `"${name}"`
}

async function log(
  tx: PrismaTransactionClient,
  action: string,
  summary: string,
  before: unknown,
  after: unknown,
  createdBy: string | null,
): Promise<string> {
  const id = await recordChange({ area: 'feed-rules', action, summary, before, after, createdBy }, tx)
  await pruneChangeLog(tx)
  return id
}

export type RuleWriteResult = { rule: FeedRule; changeId: string }

/** Adds a rule at the end of the list. */
export async function createFeedRule(draft: RuleDraft, actor: string | null): Promise<RuleWriteResult> {
  return prisma.$transaction(async (tx) => {
    // Serialises concurrent creates, so two new rules cannot take one position.
    await tx.$executeRaw`LOCK TABLE "gsf_feed_rules" IN SHARE ROW EXCLUSIVE MODE`
    const [last] = await tx.$queryRaw<Array<{ next: number }>>`
      SELECT COALESCE(MAX("position") + 1, 0)::int AS "next" FROM "gsf_feed_rules"
    `
    const rule = await insertRule(tx, { draft, position: last?.next ?? 0, createdBy: actor })
    const changeId = await log(tx, 'create', `Added the rule ${quoted(rule.name)}`, null, rule, actor)
    return { rule, changeId }
  }, TRANSACTION_OPTIONS)
}

function sameContent(a: RuleDraft, b: RuleDraft): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

export type UpdateOutcome = { status: 'saved'; rule: FeedRule; changeId: string | null } | { status: 'not-found' }

/** Replaces a rule's name, switch, conditions and action. Logged as a plain
 *  switch on or off when that is all that changed, so the history reads the
 *  way the owner acted. */
export async function updateFeedRule(id: string, draft: RuleDraft, actor: string | null): Promise<UpdateOutcome> {
  return prisma.$transaction(async (tx): Promise<UpdateOutcome> => {
    const before = await getFeedRule(id, tx, true)
    if (!before) return { status: 'not-found' }
    if (sameContent(draftOf(before), draft)) return { status: 'saved', rule: before, changeId: null }
    const after = await writeRuleContent(tx, id, draft)
    if (!after) return { status: 'not-found' }
    const onlySwitch = sameContent({ ...draftOf(before), enabled: draft.enabled }, draft)
    const summary = onlySwitch
      ? `${draft.enabled ? 'Turned on' : 'Turned off'} the rule ${quoted(after.name)}`
      : before.name === after.name
        ? `Changed the rule ${quoted(after.name)}`
        : `Changed the rule ${quoted(before.name)}, now called ${quoted(after.name)}`
    const changeId = await log(tx, onlySwitch ? 'enable' : 'update', summary, before, after, actor)
    return { status: 'saved', rule: after, changeId }
  }, TRANSACTION_OPTIONS)
}

export type DeleteOutcome = { status: 'deleted'; changeId: string } | { status: 'not-found' }

export async function deleteFeedRule(id: string, actor: string | null): Promise<DeleteOutcome> {
  return prisma.$transaction(async (tx): Promise<DeleteOutcome> => {
    const before = await getFeedRule(id, tx, true)
    if (!before) return { status: 'not-found' }
    await tx.$executeRaw`DELETE FROM "gsf_feed_rules" WHERE "id" = ${id}`
    const changeId = await log(tx, 'delete', `Deleted the rule ${quoted(before.name)}`, before, null, actor)
    return { status: 'deleted', changeId }
  }, TRANSACTION_OPTIONS)
}

export type ReorderOutcome =
  | { status: 'saved'; rules: FeedRule[]; changeId: string | null }
  | { status: 'stale' }

/**
 * Puts the rules in the order given. The list must name every rule exactly
 * once: an order built from a page that has since gone stale (a rule added or
 * deleted in another tab) is refused, rather than guessed at.
 */
export async function reorderFeedRules(orderedIds: string[], actor: string | null): Promise<ReorderOutcome> {
  return prisma.$transaction(async (tx): Promise<ReorderOutcome> => {
    await tx.$executeRaw`LOCK TABLE "gsf_feed_rules" IN SHARE ROW EXCLUSIVE MODE`
    const rules = await listFeedRules(tx)
    const known = new Set(rules.map((rule) => rule.id))
    if (orderedIds.length !== rules.length || new Set(orderedIds).size !== orderedIds.length || orderedIds.some((id) => !known.has(id))) {
      return { status: 'stale' }
    }
    const before: PositionSnapshot = rules.map((rule) => ({ id: rule.id, position: rule.position }))
    const after: PositionSnapshot = orderedIds.map((id, position) => ({ id, position }))
    const unchanged = before.every((entry, index) => entry.id === after[index]?.id && entry.position === after[index]?.position)
    if (unchanged) return { status: 'saved', rules, changeId: null }
    await writePositions(tx, after)
    const moved = rules.find((rule, index) => rule.id !== orderedIds[index])
    const summary = moved ? `Reordered the rules (moved ${quoted(moved.name)})` : 'Reordered the rules'
    const changeId = await log(tx, 'reorder', summary, before, after, actor)
    return { status: 'saved', rules: await listFeedRules(tx), changeId }
  }, TRANSACTION_OPTIONS)
}

// ----- The range attribute ---------------------------------------------------

export type RangeSnapshot = { rangeAttributeId: string | null }

export async function getRangeAttributeId(db: PrismaTransactionClient = prisma): Promise<string | null> {
  const rows = await db.$queryRaw<Array<{ rules_range_attribute_id: string | null }>>`
    SELECT "rules_range_attribute_id" FROM "gsf_settings" WHERE "id" = 'singleton'
  `
  return rows[0]?.rules_range_attribute_id?.trim() || null
}

export async function writeRangeAttributeId(tx: PrismaTransactionClient, value: string | null): Promise<void> {
  await tx.$executeRaw`
    UPDATE "gsf_settings" SET "rules_range_attribute_id" = ${value}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'
  `
}

/** Says which attribute is the shop's range, for the rules' Range field. */
export async function setRangeAttributeId(
  value: string | null,
  labels: { from: string | null; to: string | null },
  actor: string | null,
): Promise<{ changeId: string | null }> {
  const next = value?.trim() || null
  return prisma.$transaction(async (tx) => {
    const current = await getRangeAttributeId(tx)
    if (current === next) return { changeId: null }
    await writeRangeAttributeId(tx, next)
    const summary = next
      ? `Set the range attribute to ${quoted(labels.to ?? 'another attribute')}`
      : `Stopped using ${quoted(labels.from ?? 'an attribute')} as the range`
    const before: RangeSnapshot = { rangeAttributeId: current }
    const after: RangeSnapshot = { rangeAttributeId: next }
    const changeId = await log(tx, 'range', summary, before, after, actor)
    return { changeId }
  }, TRANSACTION_OPTIONS)
}
