// When a promotion runs for, and what it is called while it runs. Pure: no
// database, no clock of its own, nothing to mock. lib/promotion-windows-data.ts
// stores what comes back.
//
// Two rules of Google's shape everything here, and neither is negotiable:
//
//  - A promotion's start time cannot be changed once the promotion exists.
//    Send a different one and Google refuses the edit, reports "Promotion
//    invalid Update", and keeps the old promotion - or, worse, keeps it with no
//    effective period at all. So a start date is decided once and then left
//    alone for as long as that id lives.
//
//  - A promotion is capped at 183 days, and an id that has stopped can never be
//    revived. Together those mean a standing offer CANNOT be one id with an end
//    date that keeps moving: it has to become a new promotion, with a new id,
//    before the cap runs out. That is what a revision is.

/** How long one revision of a promotion runs. Short of Google's 183-day cap by
 *  enough that a fetch which slips by a few days still sends a legal window. */
export const PROMOTION_WINDOW_DAYS = 180

/** How long before the end a revision is replaced. It has to be comfortably
 *  longer than the gap between two fetches of the product source and the
 *  promotions source, because for that gap the two documents disagree about the
 *  id and the offer shows on nothing. Fourteen days of daily fetches is thirteen
 *  more chances than it needs. */
export const PROMOTION_RENEW_BEFORE_DAYS = 14

const DAY_MS = 24 * 60 * 60 * 1000

/** One offer's window, as stored. `baseKey` is the revision-independent id that
 *  lib/promotions.ts derives from the supplier and the amount. */
export type PromotionWindow = {
  baseKey: string
  revision: number
  startsAt: Date
  endsAt: Date
}

/**
 * The id actually sent to Google for a given revision.
 *
 * Revision 0 is the derived id unchanged, so a shop that never hits a burned id
 * or a renewal sees exactly what it saw before this existed. Above 0 the suffix
 * makes an id Google has never seen, which is the only thing it will accept
 * once the original has stopped.
 *
 * PURE and stable: the product source and the promotions source are fetched
 * separately, hours apart, and the only thing joining them is that both spell
 * this the same way from the same row.
 */
export function promotionIdForRevision(baseKey: string, revision: number): string {
  return revision > 0 ? `${baseKey}-r${revision}` : baseKey
}

/** The end of a window that starts at `startsAt`. */
export function windowEnd(startsAt: Date): Date {
  return new Date(startsAt.getTime() + PROMOTION_WINDOW_DAYS * DAY_MS)
}

/**
 * Whether this window is close enough to its end to be replaced.
 *
 * True once there are fewer than PROMOTION_RENEW_BEFORE_DAYS left, and true for
 * anything already past its end. Also true for a window that starts in the
 * future by more than one window's length, which can only be a clock that went
 * backwards or a row written by something else - either way the honest answer
 * is a fresh window rather than a date nobody can explain.
 */
export function needsRenewal(window: Pick<PromotionWindow, 'startsAt' | 'endsAt'>, now: Date): boolean {
  const remaining = window.endsAt.getTime() - now.getTime()
  if (remaining <= PROMOTION_RENEW_BEFORE_DAYS * DAY_MS) return true
  return window.startsAt.getTime() > now.getTime() + PROMOTION_WINDOW_DAYS * DAY_MS
}

/** A brand-new window for `baseKey` at revision `revision`, starting now. */
export function freshWindow(baseKey: string, revision: number, now: Date): PromotionWindow {
  return { baseKey, revision, startsAt: now, endsAt: windowEnd(now) }
}

/**
 * What every offer in this run should be called and when it runs, given the
 * rows already stored.
 *
 * Returns the windows to use AND the ones that have to be written back, so the
 * caller makes one decision about what to save rather than working it out
 * twice. An offer with no row is new; one whose window is nearly up is renewed
 * at the next revision, which is a different id and therefore a promotion
 * Google will accept.
 */
export function resolveWindows(
  baseKeys: readonly string[],
  stored: readonly PromotionWindow[],
  now: Date,
): { windows: Map<string, PromotionWindow>; toWrite: PromotionWindow[] } {
  const byKey = new Map(stored.map((w) => [w.baseKey, w]))
  const windows = new Map<string, PromotionWindow>()
  const toWrite: PromotionWindow[] = []

  for (const baseKey of baseKeys) {
    const existing = byKey.get(baseKey)
    if (!existing) {
      const created = freshWindow(baseKey, 0, now)
      windows.set(baseKey, created)
      toWrite.push(created)
      continue
    }
    if (needsRenewal(existing, now)) {
      const renewed = freshWindow(baseKey, existing.revision + 1, now)
      windows.set(baseKey, renewed)
      toWrite.push(renewed)
      continue
    }
    windows.set(baseKey, existing)
  }

  return { windows, toWrite }
}
