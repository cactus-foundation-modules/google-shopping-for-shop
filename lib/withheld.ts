// What the last feed build refused to publish, written down for the admin.
//
// Kept out of lib/settings.ts on purpose. That row is read on every feed
// request and every admin render; this is a list that only one writer produces
// and only one screen consumes, and folding it into the settings type would put
// a potentially long array in front of every caller that just wanted to know
// whether the feed is switched on.
//
// Why record it rather than work it out when asked: deciding what would be
// withheld means building the whole feed, which on a real catalogue is tens of
// megabytes and several thousand queries. The scheduled fetch already pays that
// cost, so it writes down what it found and the settings tab reads it back.
import { prisma } from '@/lib/db/prisma'
import type { FeedWithheldItem } from '@/modules/google-shopping-for-shop/lib/feed-data'

/** The stored report. `checkedAt` null means no feed has been fetched since this
 *  shipped - which is NOT the same as "nothing was withheld", and the tab says
 *  so rather than showing a reassuring zero it has not earned. */
export type WithheldReport = { items: FeedWithheldItem[]; checkedAt: Date | null }

const EMPTY: WithheldReport = { items: [], checkedAt: null }

/** Longest list worth keeping. A shop with more imageless products than this has
 *  a catalogue problem, not a feed problem, and the count still tells the truth
 *  because it is taken before the list is clipped. */
const MAX_STORED = 200

export async function recordWithheldItems(items: FeedWithheldItem[]): Promise<void> {
  // Deliberately not awaited by the feed route's response - see its caller. A
  // failure here must never cost Google its fetch: the feed is the product, and
  // a note for the admin is not worth a 500 to Merchant Center.
  await prisma.$executeRaw`
    UPDATE "gsf_settings"
    SET "withheld_items" = ${JSON.stringify({ total: items.length, items: items.slice(0, MAX_STORED) })}::jsonb,
        "withheld_at" = CURRENT_TIMESTAMP
    WHERE "id" = 'singleton'
  `
}

export async function getWithheldReport(): Promise<WithheldReport> {
  const rows = await prisma.$queryRaw<Array<{ withheld_items: unknown; withheld_at: Date | null }>>`
    SELECT "withheld_items", "withheld_at" FROM "gsf_settings" WHERE "id" = 'singleton'
  `
  const row = rows[0]
  if (!row || !row.withheld_at) return EMPTY
  // jsonb comes back already parsed, and can be any shape at all - it is a
  // column, not a contract. Anything unrecognised reads as "nothing recorded"
  // rather than throwing on a settings page.
  const stored = row.withheld_items
  if (!stored || typeof stored !== 'object' || !('items' in stored)) return { items: [], checkedAt: row.withheld_at }
  const list = (stored as { items?: unknown }).items
  if (!Array.isArray(list)) return { items: [], checkedAt: row.withheld_at }
  const items: FeedWithheldItem[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const { id, title, reason } = entry as Record<string, unknown>
    if (typeof id === 'string' && typeof title === 'string' && reason === 'no-image') {
      items.push({ id, title, reason })
    }
  }
  return { items, checkedAt: row.withheld_at }
}
