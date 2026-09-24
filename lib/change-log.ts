// The workbench's change log: write one, list them, put one back.
//
// Every area of the workbench that changes something the owner might regret
// writes a line here with a before and an after, and registers an undo that
// knows how to read its own snapshot back. The log itself knows nothing about
// feed rules or delivery settings - it holds jsonb and hands it back to whoever
// wrote it.
//
// Undo is conservative, the way the title template log is: an area's handler
// decides what is still safe to restore, and anything changed since is left to
// whoever changed it. Quietly overwriting somebody's work to honour an older
// undo is the accident the log exists to prevent.
//
// The title template batches (lib/title-template-changes.ts) stay where they
// are: one save there is thousands of rows with a per-row before, which is a
// different shape of problem and already solved.
import { prisma, type PrismaTransactionClient } from '@/lib/db/prisma'

/** The parts of the workbench that write here. A new area adds itself to this
 *  list and registers a handler; nothing else has to change. */
export const CHANGE_LOG_AREAS = ['feed-rules', 'shipping', 'products', 'settings', 'live-updates', 'google-ads'] as const
export type ChangeLogArea = (typeof CHANGE_LOG_AREAS)[number]

export function isChangeLogArea(value: unknown): value is ChangeLogArea {
  return typeof value === 'string' && (CHANGE_LOG_AREAS as readonly string[]).includes(value)
}

export type ChangeLogEntry = {
  id: string
  area: ChangeLogArea
  action: string
  summary: string
  /** Whatever the area recorded. Its own undo is the only thing that reads it. */
  before: unknown
  after: unknown
  createdBy: string | null
  createdAt: Date
  undoneAt: Date | null
}

export type RecordChangeInput = {
  area: ChangeLogArea
  action: string
  summary: string
  before?: unknown
  after?: unknown
  createdBy: string | null
}

/** What an area's undo did. `skipped` is the count it declined to touch because
 *  the world had moved on, which the UI says out loud. */
export type UndoResult = {
  restored: number
  skipped: number
  /** Overrides the default "Undid ..." line on the entry the undo itself writes. */
  summary?: string
}

export type UndoContext = {
  entry: ChangeLogEntry
  actor: string | null
  /** The undo runs inside the same transaction as the log update, so a handler
   *  that fails leaves the entry un-undone rather than half-undone. */
  tx: PrismaTransactionClient
}

export type UndoHandler = (context: UndoContext) => Promise<UndoResult>

export type UndoOutcome =
  | {
    status: 'undone'
    restored: number
    skipped: number
    entryId: string | null
    /** The handler's own sentence about what it did, or declined to do.
     *
     *  Carried out here because on a SKIP it has nowhere else to go: nothing
     *  is restored, so no new log entry is written, and the reason - "that
     *  send never finished", "a later send has happened since" - was being
     *  thrown away and replaced by one generic line for every possible cause.
     *  An area that takes the trouble to say why it declined should have that
     *  reach the person who pressed the button. */
    message?: string
  }
  | { status: 'not-found' }
  | { status: 'already-undone' }
  | { status: 'not-undoable' }

// How much history each area keeps. Per area rather than overall, so a busy
// area cannot push a quiet one's history out.
const KEEP_PER_AREA = 200

// And an outer limit in days, so a shop that changes one thing a year does not
// carry a snapshot from three owners ago.
const KEEP_DAYS = 400

// Actions that are never pruned by the per-area cap.
//
// An area can write two quite different kinds of entry: a one-off that set
// something up and whose Undo is the only way back, and a routine one that
// happens every few minutes. Counting them together means the routine ones push
// the one-off out - the live updates could prune away the record of how the
// Merchant Center link was made inside a day of ordinary sending, taking its
// Undo with it.
//
// So a milestone is exempt from the COUNT and not from the age limit. An area
// marks one by naming its action here; there is deliberately nothing per-area
// about it, because an action name that means "I set something up" means the
// same thing wherever it is written.
const MILESTONE_ACTIONS = ['link', 'unlink', 'create-source'] as const

// Stage-sized undos call out to Google from inside the transaction (a delivery
// settings push, say), which Prisma's default 5s timeout would cut off half
// way. Same limits as the title template log, inside the 60s every module
// route runs within.
const TRANSACTION_OPTIONS = { timeout: 50_000, maxWait: 10_000 } as const

// Handlers register themselves when their module is imported; the undo route
// imports lib/change-log-handlers.ts, which imports every area that has one.
const handlers = new Map<ChangeLogArea, UndoHandler>()

/** Teaches the log how to put one area's changes back. Called at import time by
 *  the area itself, so the log never has to know what areas exist. */
export function registerUndoHandler(area: ChangeLogArea, handler: UndoHandler): void {
  handlers.set(area, handler)
}

export function canUndoArea(area: ChangeLogArea): boolean {
  return handlers.has(area)
}

type Row = {
  id: string
  area: string
  action: string
  summary: string
  before: unknown
  after: unknown
  created_by: string | null
  created_at: Date
  undone_at: Date | null
}

function toEntry(row: Row): ChangeLogEntry {
  return {
    id: row.id,
    // The column is plain text so a new area needs no migration; a row written
    // by a version that knew an area this one does not is still readable, and
    // simply has no handler.
    area: row.area as ChangeLogArea,
    action: row.action,
    summary: row.summary,
    before: row.before,
    after: row.after,
    createdBy: row.created_by,
    createdAt: row.created_at,
    undoneAt: row.undone_at,
  }
}

/** jsonb wants a JSON document or NULL; `undefined` is neither. */
function asJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value)
}

async function insert(db: PrismaTransactionClient, input: RecordChangeInput): Promise<string> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "gsf_change_log" ("area", "action", "summary", "before", "after", "created_by")
    VALUES (
      ${input.area},
      ${input.action},
      ${input.summary},
      ${asJson(input.before)}::jsonb,
      ${asJson(input.after)}::jsonb,
      ${input.createdBy}
    )
    RETURNING "id"
  `
  const id = rows[0]?.id
  if (!id) throw new Error('Could not record that change')
  return id
}

/** Drops the entries past either limit, newest per area kept. The newest entry
 *  in an area always survives, so the change just made can always be undone. */
export async function pruneChangeLog(db: PrismaTransactionClient = prisma): Promise<number> {
  const milestones = [...MILESTONE_ACTIONS]
  return db.$executeRaw`
    DELETE FROM "gsf_change_log"
    WHERE "id" IN (
      SELECT "id" FROM (
        SELECT "id",
               "created_at",
               -- Milestones are numbered apart from everything else, so a busy
               -- area's routine entries cannot count them out of existence.
               row_number() OVER (
                 PARTITION BY "area", ("action" = ANY(${milestones}::text[]))
                 ORDER BY "created_at" DESC, "id" DESC
               ) AS "position",
               ("action" = ANY(${milestones}::text[])) AS "milestone"
        FROM "gsf_change_log"
      ) "ranked"
      WHERE "position" > 1
        AND ((NOT "milestone" AND "position" > ${KEEP_PER_AREA}::int)
             -- Cast because make_interval takes its arguments by name, and a
             -- bare placeholder there leaves Postgres unable to work out what
             -- type it is meant to be.
             OR "created_at" < CURRENT_TIMESTAMP - make_interval(days => ${KEEP_DAYS}::int))
    )
  `
}

/** Writes one entry and returns its id. Pass `db` to join a transaction the
 *  caller has already opened, so the change and its log entry land together. */
export async function recordChange(input: RecordChangeInput, db?: PrismaTransactionClient): Promise<string> {
  if (db) return insert(db, input)
  return prisma.$transaction(async (tx) => {
    const id = await insert(tx, input)
    await pruneChangeLog(tx)
    return id
  }, TRANSACTION_OPTIONS)
}

/**
 * Rewrites one entry's `after` snapshot and its summary.
 *
 * For a change made in two steps, where the second step is somebody else's
 * system: the entry is written BEFORE the call, so a crash leaves a record of
 * what was attempted, and amended after it with what actually happened. An
 * area's undo can then refuse an entry that never got its confirmation.
 *
 * Deliberately not a general-purpose update. Nothing may rewrite `before` -
 * that is the thing being preserved.
 */
export async function amendChange(
  id: string,
  input: { summary: string; after: unknown },
  db: PrismaTransactionClient = prisma,
): Promise<void> {
  await db.$executeRaw`
    UPDATE "gsf_change_log"
    SET "summary" = ${input.summary}, "after" = ${asJson(input.after)}::jsonb
    WHERE "id" = ${id}
  `
}

/** The log, newest first. One area's, or all of them. */
export async function listChanges(options: { area?: ChangeLogArea; limit: number }): Promise<ChangeLogEntry[]> {
  const limit = Math.min(Math.max(1, Math.trunc(options.limit)), 500)
  const rows = options.area
    ? await prisma.$queryRaw<Row[]>`
        SELECT "id", "area", "action", "summary", "before", "after", "created_by", "created_at", "undone_at"
        FROM "gsf_change_log"
        WHERE "area" = ${options.area}
        ORDER BY "created_at" DESC, "id" DESC
        LIMIT ${limit}
      `
    : await prisma.$queryRaw<Row[]>`
        SELECT "id", "area", "action", "summary", "before", "after", "created_by", "created_at", "undone_at"
        FROM "gsf_change_log"
        ORDER BY "created_at" DESC, "id" DESC
        LIMIT ${limit}
      `
  return rows.map(toEntry)
}

export async function getChange(id: string): Promise<ChangeLogEntry | null> {
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT "id", "area", "action", "summary", "before", "after", "created_by", "created_at", "undone_at"
    FROM "gsf_change_log"
    WHERE "id" = ${id}
  `
  const row = rows[0]
  return row ? toEntry(row) : null
}

/**
 * Puts one entry back, using whatever handler its area registered.
 *
 * The row is locked first, so two presses of Undo cannot both restore the same
 * change. The undo is itself recorded as a new entry, so an undo can be undone.
 */
export async function undoChange(id: string, actor: string | null): Promise<UndoOutcome> {
  return prisma.$transaction(async (tx): Promise<UndoOutcome> => {
    const rows = await tx.$queryRaw<Row[]>`
      SELECT "id", "area", "action", "summary", "before", "after", "created_by", "created_at", "undone_at"
      FROM "gsf_change_log"
      WHERE "id" = ${id}
      FOR UPDATE
    `
    const row = rows[0]
    if (!row) return { status: 'not-found' }
    if (row.undone_at) return { status: 'already-undone' }

    const entry = toEntry(row)
    const handler = handlers.get(entry.area)
    if (!handler) return { status: 'not-undoable' }

    const result = await handler({ entry, actor, tx })
    await tx.$executeRaw`
      UPDATE "gsf_change_log" SET "undone_at" = CURRENT_TIMESTAMP WHERE "id" = ${id}
    `

    let entryId: string | null = null
    if (result.restored > 0) {
      entryId = await insert(tx, {
        area: entry.area,
        action: 'undo',
        summary: result.summary ?? `Undid "${entry.summary}"`,
        // The undo swaps them round: what the change made is what it took away.
        before: entry.after,
        after: entry.before,
        createdBy: actor,
      })
    }
    await pruneChangeLog(tx)
    return {
      status: 'undone',
      restored: result.restored,
      skipped: result.skipped,
      entryId,
      ...(result.summary ? { message: result.summary } : {}),
    }
  }, TRANSACTION_OPTIONS)
}
