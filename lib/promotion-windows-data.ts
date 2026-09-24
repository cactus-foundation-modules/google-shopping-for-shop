// Reading and writing promotion windows. The decisions all live in
// lib/promotion-windows.ts; this file only fetches rows, saves rows, and hands
// the pure half a clock.

import { prisma } from '@/lib/db/prisma'
import {
  type PromotionWindow,
  freshWindow,
  promotionIdForRevision,
  resolveWindows,
} from '@/modules/google-shopping-for-shop/lib/promotion-windows'

type WindowRow = {
  base_key: string
  revision: number
  started_at: Date
  ends_at: Date
}

function toWindow(row: WindowRow): PromotionWindow {
  return {
    baseKey: row.base_key,
    revision: Number(row.revision),
    startsAt: row.started_at,
    endsAt: row.ends_at,
  }
}

async function save(windows: readonly PromotionWindow[]): Promise<void> {
  for (const w of windows) {
    // An upsert rather than an insert: a concurrent fetch of the other document
    // may have written the same row a moment ago, and the later write is the
    // one that has already been handed out as an id, so it wins.
    await prisma.$executeRaw`
      INSERT INTO "gsf_promotion_windows" ("base_key", "revision", "started_at", "ends_at", "last_seen_at", "updated_at")
      VALUES (${w.baseKey}, ${w.revision}, ${w.startsAt}, ${w.endsAt}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("base_key") DO UPDATE
      SET "revision" = EXCLUDED."revision",
          "started_at" = EXCLUDED."started_at",
          "ends_at" = EXCLUDED."ends_at",
          "last_seen_at" = CURRENT_TIMESTAMP,
          "updated_at" = CURRENT_TIMESTAMP
    `
  }
}

/**
 * The window every offer in this run should use, keyed by its derived base id.
 *
 * New offers get a window, offers whose window is nearly up get a new revision
 * (which is a new id, and therefore a promotion Google will accept), and
 * everything else gets back exactly what it had - which is the entire point:
 * sending the same start date every fetch is what stops Google refusing the
 * edit.
 *
 * Writes as a side effect, deliberately. The alternative is working the same
 * dates out twice from two different fetches minutes apart and hoping they
 * agree, which is how the two documents drift.
 */
export async function resolvePromotionWindows(
  baseKeys: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, PromotionWindow>> {
  if (baseKeys.length === 0) return new Map()

  const stored = await prisma.$queryRaw<WindowRow[]>`
    SELECT "base_key", "revision", "started_at", "ends_at"
    FROM "gsf_promotion_windows"
    WHERE "base_key" = ANY(${[...baseKeys]}::text[])
  `
  const { windows, toWrite } = resolveWindows(baseKeys, stored.map(toWindow), now)
  if (toWrite.length > 0) await save(toWrite)

  // A row the run did see, so "when did this offer last exist" stays answerable
  // even for the ones that needed no other change.
  await prisma.$executeRaw`
    UPDATE "gsf_promotion_windows" SET "last_seen_at" = CURRENT_TIMESTAMP
    WHERE "base_key" = ANY(${[...baseKeys]}::text[])
  `
  return windows
}

/** Every window on record, newest first, for the settings tab. */
export async function listPromotionWindows(): Promise<Array<PromotionWindow & { promotionId: string; lastSeenAt: Date }>> {
  const rows = await prisma.$queryRaw<Array<WindowRow & { last_seen_at: Date }>>`
    SELECT "base_key", "revision", "started_at", "ends_at", "last_seen_at"
    FROM "gsf_promotion_windows"
    ORDER BY "last_seen_at" DESC, "base_key" ASC
  `
  return rows.map((row) => {
    const window = toWindow(row)
    return { ...window, promotionId: promotionIdForRevision(window.baseKey, window.revision), lastSeenAt: row.last_seen_at }
  })
}

/**
 * Give one offer a brand-new id, now.
 *
 * For the case Google leaves no other way out of: an id that has stopped, or
 * that Google has left with no effective period, is dead for good, and the
 * documented fix is a new promotion with a new id. Nothing about the offer
 * changes - same money off, same minimum spend, same products - only what it is
 * called, so the next fetch of both documents creates it afresh.
 *
 * Returns the new id, or null when there is no such offer to reissue.
 */
export async function reissuePromotion(baseKey: string, now: Date = new Date()): Promise<string | null> {
  const rows = await prisma.$queryRaw<WindowRow[]>`
    SELECT "base_key", "revision", "started_at", "ends_at"
    FROM "gsf_promotion_windows" WHERE "base_key" = ${baseKey}
  `
  const current = rows[0]
  if (!current) return null
  const next = freshWindow(baseKey, Number(current.revision) + 1, now)
  await save([next])
  return promotionIdForRevision(next.baseKey, next.revision)
}
