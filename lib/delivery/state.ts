// The delivery sync's own bookkeeping: which Merchant Center services this
// site put there, when the two were last compared and what came of it.
//
// Kept out of getGsfSettings deliberately. That row is read on every feed
// build, and the last comparison is a lump of jsonb nothing in the feed has any
// use for; SELECTing it on the hot path would cost a catalogue-sized feed a
// pointless read of the whole blob.
import { prisma, type PrismaTransactionClient } from '@/lib/db/prisma'
import type { DeliveryDiff } from '@/modules/google-shopping-for-shop/lib/delivery/diff'

export type DeliverySyncState = {
  /** Merchant Center service names this site last pushed. Anything not in
   *  here belongs to somebody else and is never touched. */
  managedServices: string[]
  /** Null means the comparison has never run, which is NOT "they agree". */
  checkedAt: Date | null
  differences: number | null
  /** The last comparison in full, stale by definition. */
  lastDiff: DeliveryDiff | null
  pushedAt: Date | null
}

type Row = {
  delivery_managed_services: unknown
  delivery_checked_at: Date | null
  delivery_differences: number | null
  delivery_last_diff: unknown
  delivery_pushed_at: Date | null
}

function readNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((name): name is string => typeof name === 'string' && name.trim() !== '')
}

// Our own jsonb, but written by whichever version of this module was installed
// when it was written. Checked rather than cast: a comparison shaped by an
// older build must leave the tab empty, not throw while drawing it.
function readDiff(value: unknown): DeliveryDiff | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (typeof row.comparedAt !== 'string' || !Array.isArray(row.services)) return null
  if (typeof row.differences !== 'number') return null
  return value as DeliveryDiff
}

export async function readDeliveryState(): Promise<DeliverySyncState> {
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT "delivery_managed_services", "delivery_checked_at", "delivery_differences",
           "delivery_last_diff", "delivery_pushed_at"
    FROM "gsf_settings" WHERE "id" = 'singleton'
  `
  const row = rows[0]
  if (!row) return { managedServices: [], checkedAt: null, differences: null, lastDiff: null, pushedAt: null }
  return {
    managedServices: readNames(row.delivery_managed_services),
    checkedAt: row.delivery_checked_at,
    differences: row.delivery_differences === null ? null : Number(row.delivery_differences),
    lastDiff: readDiff(row.delivery_last_diff),
    pushedAt: row.delivery_pushed_at,
  }
}

/** Remembers a comparison, so the tab can open on it without ringing Google. */
export async function recordComparison(diff: DeliveryDiff, db: PrismaTransactionClient = prisma): Promise<void> {
  await db.$executeRaw`
    UPDATE "gsf_settings"
    SET "delivery_checked_at" = ${new Date(diff.comparedAt)},
        "delivery_differences" = ${diff.differences},
        "delivery_last_diff" = ${JSON.stringify(diff)}::jsonb,
        "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = 'singleton'
  `
}

/** Remembers what this site now owns at Merchant Center. Written inside the
 *  same transaction as the change-log entry, so a push cannot be recorded
 *  without its snapshot or the other way about. */
export async function recordPush(
  managedServices: string[],
  pushedAt: Date,
  db: PrismaTransactionClient = prisma,
): Promise<void> {
  await db.$executeRaw`
    UPDATE "gsf_settings"
    SET "delivery_managed_services" = ${JSON.stringify([...new Set(managedServices)])}::jsonb,
        "delivery_pushed_at" = ${pushedAt},
        "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = 'singleton'
  `
}
