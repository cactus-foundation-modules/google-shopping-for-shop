// The owner's own say on whether a product or a variation goes to Google:
// follow the feed rules, always send it, or never send it.
//
// Stored on gsf_product_data.feed_choice, one row per product id - a
// variation's row is keyed by its own product id. Every change is written to
// the workbench change log (area 'products') in the same transaction, and can
// be undone from there.
//
// The old `excluded` column is kept in step (true exactly when the choice is
// "never"), so a backup restored into an older version of the module still
// keeps out what the owner kept out.
import { prisma, type PrismaTransactionClient } from '@/lib/db/prisma'
import { pruneChangeLog, recordChange, registerUndoHandler, type UndoHandler } from '@/modules/google-shopping-for-shop/lib/change-log'
import { asFeedChoice, FEED_CHOICES, type FeedChoice } from '@/modules/google-shopping-for-shop/lib/types'

export type FeedChoiceEntry = { productId: string; choice: FeedChoice }

/** The action the change log records these under. */
export const FEED_CHOICE_ACTION = 'feed-choice'

const TRANSACTION_OPTIONS = { timeout: 50_000, maxWait: 10_000 } as const

/** Each id's stored choice; ids with no row are 'rules'. */
export async function getFeedChoices(productIds: string[], db: PrismaTransactionClient = prisma): Promise<Map<string, FeedChoice>> {
  const ids = [...new Set(productIds)].filter(Boolean)
  const map = new Map<string, FeedChoice>(ids.map((id) => [id, 'rules']))
  if (ids.length === 0) return map
  const rows = await db.$queryRaw<Array<{ product_id: string; feed_choice: string }>>`
    SELECT "product_id", "feed_choice" FROM "gsf_product_data" WHERE "product_id" = ANY(${ids}::text[])
  `
  for (const row of rows) map.set(row.product_id, asFeedChoice(row.feed_choice))
  return map
}

async function writeChoices(entries: FeedChoiceEntry[], db: PrismaTransactionClient): Promise<void> {
  for (const choice of FEED_CHOICES) {
    const ids = entries.filter((entry) => entry.choice === choice).map((entry) => entry.productId)
    if (ids.length === 0) continue
    // Inserted from shp_products rather than from the id list, so an id that
    // is not a product (deleted since the page loaded) is skipped rather than
    // tripping the foreign key and failing the whole save.
    await db.$executeRaw`
      INSERT INTO "gsf_product_data" ("product_id", "feed_choice", "excluded", "updated_at")
      SELECT p."id", ${choice}, ${choice === 'exclude'}, CURRENT_TIMESTAMP
      FROM "shp_products" p WHERE p."id" = ANY(${ids}::text[])
      ON CONFLICT ("product_id") DO UPDATE SET
        "feed_choice" = EXCLUDED."feed_choice",
        "excluded" = EXCLUDED."excluded",
        "updated_at" = CURRENT_TIMESTAMP
    `
  }
}

export type SetFeedChoicesResult = { changed: number; changeId: string | null }

/**
 * Sets each product's choice and logs what changed as one entry. Entries
 * already at the wanted choice are left alone and not logged; when nothing
 * changes at all, nothing is written and `changeId` is null.
 *
 * Pass `db` to join a transaction the caller already holds (the product
 * editor saves the typed-in fields and the choice together).
 */
export async function setFeedChoices(
  entries: FeedChoiceEntry[],
  meta: { summary: string; createdBy: string | null },
  db?: PrismaTransactionClient,
): Promise<SetFeedChoicesResult> {
  const run = async (tx: PrismaTransactionClient): Promise<SetFeedChoicesResult> => {
    // Only ids that are products: one deleted since the page loaded is left
    // out of the write AND the log, so the log never records a change that
    // did not happen.
    const asked = [...new Set(entries.map((entry) => entry.productId))]
    const real = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "shp_products" WHERE "id" = ANY(${asked}::text[])
    `
    const known = new Set(real.map((row) => row.id))
    const wanted = new Map(entries.filter((entry) => known.has(entry.productId)).map((entry) => [entry.productId, entry.choice]))
    const ids = [...wanted.keys()]
    // Locks the rows that exist, so two saves of the same product cannot both
    // log a "before" that the other has already changed.
    await tx.$queryRaw`SELECT 1 FROM "gsf_product_data" WHERE "product_id" = ANY(${ids}::text[]) FOR UPDATE`
    const current = await getFeedChoices(ids, tx)
    const before: FeedChoiceEntry[] = []
    const after: FeedChoiceEntry[] = []
    for (const [productId, choice] of wanted) {
      const was = current.get(productId) ?? 'rules'
      if (was === choice) continue
      before.push({ productId, choice: was })
      after.push({ productId, choice })
    }
    if (after.length === 0) return { changed: 0, changeId: null }
    await writeChoices(after, tx)
    const changeId = await recordChange({
      area: 'products',
      action: FEED_CHOICE_ACTION,
      summary: meta.summary,
      before,
      after,
      createdBy: meta.createdBy,
    }, tx)
    await pruneChangeLog(tx)
    return { changed: after.length, changeId }
  }
  return db ? run(db) : prisma.$transaction(run, TRANSACTION_OPTIONS)
}

function readEntries(value: unknown): FeedChoiceEntry[] {
  if (!Array.isArray(value)) return []
  const entries: FeedChoiceEntry[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const { productId, choice } = raw as Record<string, unknown>
    if (typeof productId === 'string' && FEED_CHOICES.includes(choice as FeedChoice)) {
      entries.push({ productId, choice: choice as FeedChoice })
    }
  }
  return entries
}

/**
 * Puts each product back to the choice it had, but only where it still has the
 * choice this change gave it. Anything changed since is somebody's later
 * decision and is left alone, and counted as skipped.
 */
const undoFeedChoices: UndoHandler = async ({ entry, tx }) => {
  if (entry.action !== FEED_CHOICE_ACTION && entry.action !== 'undo') {
    throw new Error('That change cannot be undone from here')
  }
  const before = readEntries(entry.before)
  const after = new Map(readEntries(entry.after).map((row) => [row.productId, row.choice]))
  const ids = before.map((row) => row.productId)
  await tx.$queryRaw`SELECT 1 FROM "gsf_product_data" WHERE "product_id" = ANY(${ids}::text[]) FOR UPDATE`
  const current = await getFeedChoices(ids, tx)
  const restore: FeedChoiceEntry[] = []
  let skipped = 0
  for (const row of before) {
    if (current.get(row.productId) === after.get(row.productId)) restore.push(row)
    else skipped++
  }
  await writeChoices(restore, tx)
  return { restored: restore.length, skipped }
}

registerUndoHandler('products', undoFeedChoices)
