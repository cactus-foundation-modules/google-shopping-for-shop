// When a jump in disapprovals is worth interrupting someone about.
//
// Its own file, and pure, so the rule can be read and tested without dragging
// in the notification table, the email sender and half of Prisma behind it.
// lib/health/alerts.ts is what acts on the answer.

export type SpikeCheck = {
  /** Items with at least one disapproving issue, now. */
  disapproved: number
  /** The same figure at the previous check, or null when there was none. */
  previous: number | null
  /** The setting. 0 switches the alert off entirely. */
  threshold: number
}

/**
 * A spike is a RISE of at least the threshold since the last check.
 *
 * Not "more than N are disapproved": a catalogue with two hundred permanently
 * disapproved oddities would then raise the same alert every single day, and
 * an alert that is always on is an alert nobody reads.
 *
 * A first check has nothing to compare against and never fires. An account
 * with a standing problem would otherwise alert on the day the feature was
 * switched on, about something that had been true for months.
 */
export function isDisapprovalSpike(input: SpikeCheck): boolean {
  if (input.threshold <= 0) return false
  if (input.previous === null) return false
  return input.disapproved - input.previous >= input.threshold
}
