// Feed-only title templates: the database half. Rendering lives in
// lib/title-template-render.ts, which the browser can import as well.
import { Prisma } from '@prisma/client'
import { prisma, type PrismaTransactionClient } from '@/lib/db/prisma'

/** One owner decision about one item: a template to send, or null to go back to
 *  the item's ordinary feed title. */
export type TitleTemplateUpdate = { itemId: string; titleTemplate: string | null }

// Rows per INSERT: 2,500 at two bind parameters a row keeps a statement far
// below Postgres's 65,535-parameter ceiling, and a whole-catalogue save to a
// handful of round trips.
const WRITE_CHUNK = 2500

export async function getTitleTemplatesForItems(itemIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(itemIds)].filter(Boolean)
  const map = new Map<string, string>()
  if (ids.length === 0) return map
  // One array parameter rather than one parameter per id: a catalogue-sized
  // IN list is tens of thousands of binds and has a hard ceiling.
  const rows = await prisma.$queryRaw<Array<{ item_id: string; title_template: string }>>`
    SELECT "item_id", "title_template"
    FROM "gsf_title_templates"
    WHERE "item_id" = ANY(${ids}::text[])
  `
  for (const row of rows) map.set(row.item_id, row.title_template)
  return map
}

/** Every stored template, for callers that want the whole set anyway. Cheaper
 *  than an id list the size of the catalogue. */
export async function getAllTitleTemplates(): Promise<Map<string, string>> {
  const rows = await prisma.$queryRaw<Array<{ item_id: string; title_template: string }>>`
    SELECT "item_id", "title_template" FROM "gsf_title_templates"
  `
  return new Map(rows.map((row) => [row.item_id, row.title_template]))
}

/** Writes each update: a template upserts, null or blank deletes. Last one wins
 *  when an item appears twice. Pass a transaction client to write inside one;
 *  lib/title-template-changes.ts does, so the change log and the write agree. */
export async function upsertTitleTemplates(updates: TitleTemplateUpdate[], db: PrismaTransactionClient = prisma): Promise<void> {
  const unique = new Map<string, string | null>()
  for (const update of updates) unique.set(update.itemId, update.titleTemplate?.trim() || null)
  if (unique.size === 0) return

  const deletes = [...unique.entries()].filter(([, title]) => title == null).map(([id]) => id)
  if (deletes.length > 0) {
    await db.$executeRaw`
      DELETE FROM "gsf_title_templates"
      WHERE "item_id" = ANY(${deletes}::text[])
    `
  }

  const writes = [...unique.entries()].filter((entry): entry is [string, string] => entry[1] != null)
  for (let start = 0; start < writes.length; start += WRITE_CHUNK) {
    const values = writes.slice(start, start + WRITE_CHUNK).map(([id, title]) => Prisma.sql`(${id}, ${title})`)
    await db.$executeRaw`
      INSERT INTO "gsf_title_templates" ("item_id", "title_template")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("item_id") DO UPDATE SET
        "title_template" = EXCLUDED."title_template",
        "updated_at" = CURRENT_TIMESTAMP
    `
  }
}
