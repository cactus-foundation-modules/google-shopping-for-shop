// Which days to ask Google for, and in what order.
//
// Pure, so the awkward part of the import - "where had we got to, and what does
// Google still owe us?" - is decided by a function with no database and no
// clock in it, and can be tested by saying what day it is.
//
// Two facts shape all of this:
//
//  1. Google revises the most recent days after the fact. Conversions are
//     attributed to the day of the CLICK, and a sale three days after a click
//     lands on the click's day, changing a figure we already read. So the
//     newest few days are re-read on every run, for ever, and the cursor is
//     never allowed past them.
//
//  2. A quarter of daily figures for a real catalogue is hundreds of thousands
//     of rows, and a module route has sixty seconds. So the work is cut into
//     windows and the run stops when its budget is spent, leaving the cursor
//     where the last WHOLE window ended. The next run picks it up.
import { addDays, daysBetween, maxDay, minDay } from '@/modules/google-shopping-for-shop/lib/performance/days'

/** How many recent days are always re-read, however far the cursor has got.
 *
 *  Three: Google's own help puts conversion attribution at up to a few days,
 *  and a day re-read for nothing costs one page of a report. A day NOT re-read
 *  when it should have been is permanently short, and nothing would ever say
 *  so. */
export const REVISION_DAYS = 3

/** Days per query. Small enough that one window is a handful of pages even on
 *  a large catalogue, large enough that a 90 day backfill is a dozen windows
 *  rather than ninety. Tuning, not policy - which is why it is a constant here
 *  and not a setting on a screen. */
export const WINDOW_DAYS = 7

export type PlanInput = {
  /** Today, from the caller, so this function has no clock of its own. */
  today: string
  /** The cursor: the last day imported and settled. Null before the first run. */
  importedThrough: string | null
  /** How far back a first run reaches. */
  backfillDays: number
}

export type ImportPlan = {
  /** The windows to fetch, oldest first. Empty when there is nothing to do. */
  windows: Array<{ from: string; to: string }>
  /** The whole span the windows cover, for the screens to describe. Null when
   *  there is nothing to do. */
  span: { from: string; to: string } | null
  /** True while the plan is still working through history rather than topping
   *  up the last few days. */
  backfilling: boolean
}

/**
 * The windows this run should ask for.
 *
 * Oldest first, deliberately: a run that gets cut short should leave a
 * contiguous block of history behind it with a cursor that means what it says,
 * not a scattering of recent days with a hole where last month goes.
 */
export function planImport(input: PlanInput): ImportPlan {
  const backfillDays = Math.max(1, Math.trunc(input.backfillDays))
  // The oldest day worth holding at all. A backfill window that was widened
  // later reaches further back on the next run, which is the point of it.
  const earliest = addDays(input.today, -(backfillDays - 1))
  // Never past this: everything newer is still being revised.
  const settled = addDays(input.today, -REVISION_DAYS)

  const from = input.importedThrough === null
    ? earliest
    // maxDay against `earliest`, so a cursor left behind by a much wider
    // backfill setting does not send us back through months nobody wants any
    // more. minDay against the revision line, so the unsettled days are always
    // re-read however far ahead the cursor is.
    : maxDay(earliest, minDay(addDays(input.importedThrough, 1), addDays(settled, 1)))

  const to = input.today
  if (daysBetween(from, to) < 0) return { windows: [], span: null, backfilling: false }

  const windows: Array<{ from: string; to: string }> = []
  let cursor = from
  while (daysBetween(cursor, to) >= 0) {
    const end = minDay(addDays(cursor, WINDOW_DAYS - 1), to)
    windows.push({ from: cursor, to: end })
    cursor = addDays(end, 1)
  }

  return {
    windows,
    span: { from, to },
    // More than the unsettled tail plus a day: this run is still catching up.
    backfilling: daysBetween(from, to) > REVISION_DAYS,
  }
}

/**
 * Where the cursor goes after a run got through `windows` of the plan.
 *
 * The cursor may only ever name a day Google has stopped revising, so it is
 * capped at today minus the revision window however far the import actually
 * reached. A run that completed the whole plan and a run that stopped half way
 * both leave a cursor that means "everything up to here is imported and
 * settled" - which is the only thing the next run reads it as.
 */
export function cursorAfter(input: { today: string; completed: Array<{ from: string; to: string }>; previous: string | null }): string | null {
  const last = input.completed[input.completed.length - 1]
  if (!last) return input.previous
  const settled = addDays(input.today, -REVISION_DAYS)
  const reached = minDay(last.to, settled)
  // Never backwards: a run whose windows all sat inside the revision tail has
  // learned nothing new about settled history.
  if (input.previous !== null && reached <= input.previous) return input.previous
  return reached
}
