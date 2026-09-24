// Holding a report's rows just long enough to write them, and no longer.
//
// A quarter of daily figures for a real catalogue is hundreds of thousands of
// rows, and reading them all into an array before the first one is written is
// how a report import runs a serverless function out of memory. So rows are
// gathered a day at a time and each day is written as soon as the reader has
// moved past it.
//
// That is safe because the query asks for `ORDER BY date ASC`: once a page
// carries a row for the 5th, no later page can carry one for the 4th, so the
// 4th is complete and can go. Only the newest day seen so far is held back,
// because the next page may carry more of it.
//
// Pure apart from the flush it is handed, which is the point - the awkward part
// is testable without a database.
import { mergeRows } from '@/modules/google-shopping-for-shop/lib/performance/parse'
import type { PerformanceRow } from '@/modules/google-shopping-for-shop/lib/performance/types'

export type FlushFn = (rows: PerformanceRow[]) => Promise<void>

export class DayAccumulator {
  /** day -> key within that day -> row. A Map of Maps rather than one flat map
   *  keyed on a joined string, so flushing a day is dropping one entry rather
   *  than a scan of the lot. */
  private readonly days = new Map<string, Map<string, PerformanceRow>>()

  /** The newest day any row has mentioned. Everything older than this is
   *  complete, because the query is ordered by date ascending. */
  private newestDay: string | null = null

  private written = 0

  constructor(private readonly flush: FlushFn) {}

  /** How many rows have actually been written out. */
  get rowsWritten(): number {
    return this.written
  }

  /** One page of parsed rows. Writes out every day that is now complete. */
  async addPage(rows: readonly PerformanceRow[]): Promise<void> {
    for (const row of rows) {
      if (this.newestDay === null || row.day > this.newestDay) this.newestDay = row.day
      let day = this.days.get(row.day)
      if (!day) {
        day = new Map<string, PerformanceRow>()
        this.days.set(row.day, day)
      }
      const key = `${row.itemId}\u0000${row.method}`
      const existing = day.get(key)
      day.set(key, existing ? mergeRows(existing, row) : row)
    }
    await this.writeDays((day) => this.newestDay !== null && day < this.newestDay)
  }

  /** Everything still held, written out. Called once the last page is in. */
  async finish(): Promise<void> {
    await this.writeDays(() => true)
  }

  private async writeDays(ready: (day: string) => boolean): Promise<void> {
    // Sorted, so history is written oldest first and a run cut short in the
    // middle leaves a contiguous block behind it rather than a sieve.
    for (const day of [...this.days.keys()].sort()) {
      if (!ready(day)) continue
      const rows = this.days.get(day)
      this.days.delete(day)
      if (!rows || rows.size === 0) continue
      const list = [...rows.values()]
      await this.flush(list)
      this.written += list.length
    }
  }
}
