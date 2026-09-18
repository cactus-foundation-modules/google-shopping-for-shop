// Title template writes that leave a trail. Every save from the workbench - one
// row or twenty thousand - goes through here: it writes only the items that
// actually change, records what each held before as one batch, and can put a
// batch back.
//
// Undo is deliberately conservative: it restores an item only while the item
// still holds what the batch gave it. Anything edited since belongs to whoever
// edited it, and quietly overwriting their work to honour an older undo would
// be the very accident the log exists to prevent.
import { Prisma } from '@prisma/client'
import { prisma, type PrismaTransactionClient } from '@/lib/db/prisma'
import { upsertTitleTemplates, type TitleTemplateUpdate } from '@/modules/google-shopping-for-shop/lib/title-templates'

/** A recorded save, newest first in listings. */
export type TitleTemplateBatch = {
  id: string
  summary: string
  itemCount: number
  createdBy: string | null
  createdAt: Date
  undoneAt: Date | null
}

export type AppliedTitleChanges = {
  /** The recorded batch, or null when nothing changed and nothing was recorded. */
  batchId: string | null
  changed: number
  unchanged: number
  /** Ids that are not products (deleted since the list was loaded), left out. */
  missing: number
}

export type UndoOutcome =
  | { status: 'undone'; restored: number; skipped: number; batchId: string | null }
  | { status: 'not-found' }
  | { status: 'already-undone' }

type BatchRow = {
  id: string
  summary: string
  item_count: number
  created_by: string | null
  created_at: Date
  undone_at: Date | null
}

// Four bind parameters a log row; 2,500 rows keeps a statement well clear of
// Postgres's 65,535-parameter ceiling.
const LOG_CHUNK = 2500

// The window the log keeps. Whichever limit bites first wins, and the newest
// batch always survives however large it is, so the save just made can always
// be undone.
const KEEP_BATCHES = 50
const KEEP_ITEM_ROWS = 100_000

// A whole-catalogue save is tens of thousands of rows. Prisma's default 5s
// transaction timeout would kill it half way; this stays under the 60s every
// module route runs within.
const TRANSACTION_OPTIONS = { timeout: 50_000, maxWait: 10_000 } as const

function normalisedTemplate(template: string | null | undefined): string | null {
  return template?.trim() || null
}

async function existingProducts(db: PrismaTransactionClient, itemIds: string[]): Promise<Set<string>> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "shp_products" WHERE "id" = ANY(${itemIds}::text[])
  `
  return new Set(rows.map((row) => row.id))
}

async function currentTemplates(db: PrismaTransactionClient, itemIds: string[]): Promise<Map<string, string>> {
  if (itemIds.length === 0) return new Map()
  const rows = await db.$queryRaw<Array<{ item_id: string; title_template: string }>>`
    SELECT "item_id", "title_template"
    FROM "gsf_title_templates"
    WHERE "item_id" = ANY(${itemIds}::text[])
  `
  return new Map(rows.map((row) => [row.item_id, row.title_template]))
}

type LoggedChange = { itemId: string; previous: string | null; next: string | null }

async function recordBatch(db: PrismaTransactionClient, changes: LoggedChange[], summary: string, createdBy: string | null): Promise<string> {
  const [batch] = await db.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "gsf_title_template_batches" ("summary", "item_count", "created_by")
    VALUES (${summary}, ${changes.length}, ${createdBy})
    RETURNING "id"
  `
  if (!batch) throw new Error('Could not record the title change')
  for (let start = 0; start < changes.length; start += LOG_CHUNK) {
    const values = changes
      .slice(start, start + LOG_CHUNK)
      .map((change) => Prisma.sql`(${batch.id}, ${change.itemId}, ${change.previous}, ${change.next})`)
    await db.$executeRaw`
      INSERT INTO "gsf_title_template_batch_items" ("batch_id", "item_id", "previous_template", "new_template")
      VALUES ${Prisma.join(values)}
    `
  }
  return batch.id
}

async function pruneLog(db: PrismaTransactionClient): Promise<void> {
  await db.$executeRaw`
    DELETE FROM "gsf_title_template_batches"
    WHERE "id" IN (
      SELECT "id" FROM (
        SELECT "id",
               row_number() OVER (ORDER BY "created_at" DESC, "id" DESC) AS "position",
               sum("item_count") OVER (ORDER BY "created_at" DESC, "id" DESC ROWS UNBOUNDED PRECEDING) AS "running_items"
        FROM "gsf_title_template_batches"
      ) "ranked"
      WHERE "position" > 1
        AND ("position" > ${KEEP_BATCHES} OR "running_items" > ${KEEP_ITEM_ROWS})
    )
  `
}

/** Diffs the wanted templates against what is stored, writes the difference and
 *  logs it as one batch, all in one transaction. `summarise` is handed the
 *  number that actually changed, so the log never claims more than it did. */
export async function applyTitleTemplateChanges(
  updates: TitleTemplateUpdate[],
  meta: { summarise: (changed: number) => string; createdBy: string | null },
): Promise<AppliedTitleChanges> {
  const wanted = new Map<string, string | null>()
  for (const update of updates) wanted.set(update.itemId, normalisedTemplate(update.titleTemplate))
  if (wanted.size === 0) return { batchId: null, changed: 0, unchanged: 0, missing: 0 }

  return prisma.$transaction(async (tx): Promise<AppliedTitleChanges> => {
    const ids = [...wanted.keys()]
    // One after the other: a transaction is one connection, so parallel reads
    // on it only queue anyway.
    const products = await existingProducts(tx, ids)
    const stored = await currentTemplates(tx, ids)
    const changes: LoggedChange[] = []
    let unchanged = 0
    for (const [itemId, next] of wanted) {
      if (!products.has(itemId)) continue
      const previous = stored.get(itemId) ?? null
      if (previous === next) unchanged++
      else changes.push({ itemId, previous, next })
    }
    const missing = wanted.size - products.size
    if (changes.length === 0) return { batchId: null, changed: 0, unchanged, missing }

    await upsertTitleTemplates(changes.map((change) => ({ itemId: change.itemId, titleTemplate: change.next })), tx)
    const batchId = await recordBatch(tx, changes, meta.summarise(changes.length), meta.createdBy)
    await pruneLog(tx)
    return { batchId, changed: changes.length, unchanged, missing }
  }, TRANSACTION_OPTIONS)
}

/** Puts a batch back, as a batch of its own - so an undo can itself be undone. */
export async function undoTitleTemplateBatch(batchId: string, createdBy: string | null): Promise<UndoOutcome> {
  return prisma.$transaction(async (tx): Promise<UndoOutcome> => {
    // Locked, so two presses of Undo cannot both restore the same batch.
    const [batch] = await tx.$queryRaw<BatchRow[]>`
      SELECT "id", "summary", "item_count", "created_by", "created_at", "undone_at"
      FROM "gsf_title_template_batches"
      WHERE "id" = ${batchId}
      FOR UPDATE
    `
    if (!batch) return { status: 'not-found' }
    if (batch.undone_at) return { status: 'already-undone' }

    const logged = await tx.$queryRaw<Array<{ item_id: string; previous_template: string | null; new_template: string | null }>>`
      SELECT "item_id", "previous_template", "new_template"
      FROM "gsf_title_template_batch_items"
      WHERE "batch_id" = ${batchId}
    `
    const stored = await currentTemplates(tx, logged.map((row) => row.item_id))
    const restorable: LoggedChange[] = []
    for (const row of logged) {
      const current = stored.get(row.item_id) ?? null
      if (current === row.new_template) restorable.push({ itemId: row.item_id, previous: current, next: row.previous_template })
    }

    let undoBatchId: string | null = null
    if (restorable.length > 0) {
      await upsertTitleTemplates(restorable.map((change) => ({ itemId: change.itemId, titleTemplate: change.next })), tx)
      undoBatchId = await recordBatch(tx, restorable, `Undid "${batch.summary}"`, createdBy)
    }
    await tx.$executeRaw`
      UPDATE "gsf_title_template_batches" SET "undone_at" = CURRENT_TIMESTAMP WHERE "id" = ${batchId}
    `
    await pruneLog(tx)
    return { status: 'undone', restored: restorable.length, skipped: logged.length - restorable.length, batchId: undoBatchId }
  }, TRANSACTION_OPTIONS)
}

export async function listTitleTemplateBatches(limit: number): Promise<TitleTemplateBatch[]> {
  const rows = await prisma.$queryRaw<BatchRow[]>`
    SELECT "id", "summary", "item_count", "created_by", "created_at", "undone_at"
    FROM "gsf_title_template_batches"
    ORDER BY "created_at" DESC, "id" DESC
    LIMIT ${limit}
  `
  return rows.map((row) => ({
    id: row.id,
    summary: row.summary,
    itemCount: row.item_count,
    createdBy: row.created_by,
    createdAt: row.created_at,
    undoneAt: row.undone_at,
  }))
}
