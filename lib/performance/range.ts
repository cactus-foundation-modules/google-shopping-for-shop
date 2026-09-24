// What "last 7 days" actually means, in dates.
//
// Pure, and handed today rather than reading a clock, so a test can say what
// day it is.
//
// One thing worth saying out loud, because it is the difference between a
// believable screen and a baffling one: GOOGLE'S FIGURES RUN ABOUT A DAY
// BEHIND, and the most recent few days are still being revised. So "today"
// almost always reads as nothing at all, and yesterday reads low. The screens
// say this rather than leaving an owner to conclude their shop died overnight.
import { addDays, isDayString, maxDay, minDay } from '@/modules/google-shopping-for-shop/lib/performance/days'
import { isReportRange, type ReportRange } from '@/modules/google-shopping-for-shop/lib/performance/types'

export type ResolvedRange = {
  range: ReportRange
  from: string
  to: string
  /** Days in the span, inclusive. */
  days: number
}

export type RangeInput = {
  today: string
  range: string
  /** Only read on a custom range. */
  from?: string
  to?: string
  /** The oldest day we would ever hold, so a custom range cannot ask for a
   *  decade of a table that keeps thirteen months. */
  earliest?: string
}

/**
 * The days a chosen range covers.
 *
 * Everything falls back rather than failing: a hand-edited link with nonsense
 * in it should open the tab on the default range, not on an error page.
 */
export function resolveRange(input: RangeInput): ResolvedRange {
  const today = input.today
  const range: ReportRange = isReportRange(input.range) ? input.range : '30'
  const floor = input.earliest && isDayString(input.earliest) ? input.earliest : addDays(today, -3_650)

  if (range === 'custom') {
    const from = input.from && isDayString(input.from) ? input.from : addDays(today, -29)
    const to = input.to && isDayString(input.to) ? input.to : today
    // Dates the wrong way round are read as the span they describe rather than
    // refused: somebody picked the second date first, which is not an error.
    const start = maxDay(floor, minDay(from, to))
    const end = minDay(today, maxDay(from, to))
    // A range entirely in the future collapses to today rather than to a span
    // that ends before it starts.
    const safeStart = start <= end ? start : end
    return { range, from: safeStart, to: end, days: spanDays(safeStart, end) }
  }

  const back = range === 'today' ? 0 : Number(range) - 1
  const from = maxDay(floor, addDays(today, -back))
  return { range, from, to: today, days: spanDays(from, today) }
}

function spanDays(from: string, to: string): number {
  return Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1)
}

/** The same span, shifted back so it ends the day before this one starts. For
 *  "and how does that compare with the period before?". */
export function previousSpan(resolved: Pick<ResolvedRange, 'from' | 'to' | 'days'>): { from: string; to: string } {
  return { from: addDays(resolved.from, -resolved.days), to: addDays(resolved.from, -1) }
}
