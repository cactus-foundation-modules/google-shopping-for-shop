// Calendar days, as strings, with no time of day anywhere near them.
//
// Pure. Every date in this part of the module is a 'YYYY-MM-DD' string rather
// than a Date, on purpose: Google reports a day in the Merchant Center
// account's own timezone and never says what that timezone is, so a JS Date
// would invite a midnight, an offset and a day that quietly shifts depending
// on where the server happens to be running. A string has no such opinions.
//
// The arithmetic goes through Date.UTC, which is the one place a Date is safe:
// UTC has no daylight saving, so adding a day is always adding 86,400,000.

/** Google's Date message: a year, a month and a day, each a plain number. */
export type GoogleDate = { year?: number; month?: number; day?: number }

const DAY_MS = 86_400_000

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** Whether a string is a calendar day we could work with. Rejects '2026-02-31'
 *  as well as '2026-13-01': the round trip through Date.UTC catches a day that
 *  does not exist rather than silently rolling it into March. */
export function isDayString(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = ISO_DAY.exec(value)
  if (!match) return false
  const [, year, month, day] = match
  const stamp = Date.UTC(Number(year), Number(month) - 1, Number(day))
  return Number.isFinite(stamp) && toDayString(stamp) === value
}

function toDayString(stamp: number): string {
  return new Date(stamp).toISOString().slice(0, 10)
}

/** The day a Google Date means, or null when it is not a whole one. Google uses
 *  a zero year or a zero day for partial dates (a birthday, a card expiry), and
 *  none of those is a day a report covers. */
export function dayFromGoogle(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const { year, month, day } = value as GoogleDate
  if (typeof year !== 'number' || typeof month !== 'number' || typeof day !== 'number') return null
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null
  const candidate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return isDayString(candidate) ? candidate : null
}

/** The day a Postgres DATE column came back as.
 *
 *  Prisma hands a DATE back as a JS Date at midnight UTC, so reading it in UTC
 *  gives the day that was stored. Reading it any other way does not: a server
 *  west of Greenwich would see the day before. */
export function dayFromDate(value: unknown): string | null {
  if (value instanceof Date) {
    const stamp = value.getTime()
    return Number.isFinite(stamp) ? toDayString(stamp) : null
  }
  return isDayString(value) ? value : null
}

/** A day as a Date at midnight UTC, which is what a DATE parameter wants. */
export function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

/** `day` moved by `days` (negative goes back). */
export function addDays(day: string, days: number): string {
  return toDayString(dayToDate(day).getTime() + days * DAY_MS)
}

/** How many days `to` is after `from`. Negative when it is before. */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayToDate(to).getTime() - dayToDate(from).getTime()) / DAY_MS)
}

export function minDay(a: string, b: string): string {
  return a <= b ? a : b
}

export function maxDay(a: string, b: string): string {
  return a >= b ? a : b
}

/** Today, in UTC.
 *
 *  Not the account's timezone, which we are never told - so this can be a day
 *  out either way. It does not matter, because the import re-reads the most
 *  recent days on every run and a day that arrived early or late is corrected
 *  the next time round. */
export function todayUtc(now: Date = new Date()): string {
  return toDayString(now.getTime())
}

/** Every day from `from` to `to`, inclusive, in order. Empty when `to` is
 *  before `from`. Bounded by `limit` so a nonsense range cannot build a list
 *  the length of a decade. */
export function daysInRange(from: string, to: string, limit = 1_000): string[] {
  const span = daysBetween(from, to)
  if (span < 0) return []
  const days: string[] = []
  for (let i = 0; i <= span && days.length < limit; i++) days.push(addDays(from, i))
  return days
}
