// The daily import of Google's own performance figures.
//
// Runs from the daily cron and from the Reports tab's own refresh button. What
// it has to cope with:
//
//  - Volume. One row per offer per day per marketing method over a quarter is
//    hundreds of thousands of rows, and a module route has sixty seconds. So
//    the work is cut into windows (lib/performance/plan.ts), pages are written
//    as they arrive (lib/performance/accumulate.ts), and the run stops when its
//    budget is spent with the cursor left at the end of the last WHOLE window.
//
//  - Revision. Google attributes a conversion to the day of the CLICK, days
//    later, so the newest few days change after we have read them. They are
//    re-read every run for ever, and the upsert makes that free.
//
//  - Not knowing what the account can be asked for. Google's reference says
//    conversions are free-listing-only and does not say what an account that
//    cannot have them at all is answered with. So the query asks, and a 400 is
//    answered by asking the same window again WITHOUT them: if that works, they
//    were the cause, whatever Google called them (withConversionFallback). If
//    it does not, the original error is thrown rather than swallowed.
//    Remembering the refusal is NOT a one-way latch: see shouldAskForConversions.
//
// NOTHING HERE HAS BEEN RUN AGAINST A REAL MERCHANT CENTER ACCOUNT. Every
// field name, type and enum is checked against Google's published discovery
// document, and every unexpected answer degrades to "we do not know" rather
// than to a number.
import { getGsfSettings, recordPerformanceCheck } from '@/modules/google-shopping-for-shop/lib/settings'
import { searchReportPages } from '@/modules/google-shopping-for-shop/lib/google/client'
import { hasGoogleCredentials } from '@/modules/google-shopping-for-shop/lib/google/credentials'
import { GoogleApiError } from '@/modules/google-shopping-for-shop/lib/google/errors'
import { ALERT_KEYS, isAlertUp, setPerformanceImportAlert } from '@/modules/google-shopping-for-shop/lib/health/alerts'
import { addDays, todayUtc } from '@/modules/google-shopping-for-shop/lib/performance/days'
import { cursorAfter, planImport } from '@/modules/google-shopping-for-shop/lib/performance/plan'
import { performanceQuery } from '@/modules/google-shopping-for-shop/lib/performance/query'
import { parsePerformanceRow, type ProductPerformanceResult } from '@/modules/google-shopping-for-shop/lib/performance/parse'
import { DayAccumulator } from '@/modules/google-shopping-for-shop/lib/performance/accumulate'
import { prunePerformance, writePerformanceRows } from '@/modules/google-shopping-for-shop/lib/performance/store'
import type { ImportSkipReason, PerformanceRow } from '@/modules/google-shopping-for-shop/lib/performance/types'

/** How long one run may spend asking Google before it stops and leaves the
 *  rest for next time. Checked between windows, never mid-window: a half-written
 *  window would leave the cursor lying. A run therefore overshoots this by up to
 *  one window, which is expected rather than a slip - the check is
 *  `completed.length > 0 && elapsed > budgetMs`, so one window always happens
 *  first.
 *
 *  Fifteen seconds, and it is small ON PURPOSE. Do not read it as timidity and
 *  raise it. The ceiling is NOT this route's sixty seconds:
 *
 *    - The cron dispatcher wakes at MOST every 30 minutes. The schedule is
 *      `DISPATCH_SCHEDULE` in lib/cron/vercel-file.ts, and vercel.json is
 *      GENERATED from it - editing that file alone is reverted on the install's
 *      next update. A site with a faster job gets a faster tick, see
 *      `dispatchScheduleForInterval`. Each wake gives every due job on the whole
 *      site ONE 54-second working tick between them (maxDuration 60 less a 6s
 *      reserve), run one after another.
 *    - The daily job this sits in is picked up on the same tick as every hourly
 *      job on the site, and it sorts to the FRONT of it: the dispatcher runs
 *      longest-waiting first, and this has waited twenty-four hours against
 *      their one.
 *    - So whatever this spends comes straight off the jobs behind it, including
 *      this module's own hourly price and stock push, which is deferred to the
 *      next wake: half an hour at the default tick, less on a faster one. It
 *      was a full hour until the dispatcher went half-hourly in September 2026.
 *
 *  That change makes a deferral CHEAPER. It is not permission to raise this
 *  number. A shorter wait is a smaller penalty for starving the queue, not a
 *  reason to starve it: the tick is still ~54 seconds, every due job still
 *  shares it, and this still sorts to the front of it. Fifteen and the spend
 *  import's ten were the right call at an hourly tick and are the right call at
 *  a half-hourly one.
 *
 *  With the Ads spend import's ten seconds, that is twenty-five of the
 *  fifty-four on a backfill night, which leaves the match refresh, the feed
 *  check, the delivery check, the prune and the hourly queue room to run. A
 *  backfill just takes more nights, and that costs nothing: this resumes from
 *  its own cursor. */
const BUDGET_MS = 15_000

/** Rows per page. Google defaults to 1,000 and coerces anything above 100,000.
 *  Ten thousand is a handful of round trips for a real catalogue's day without
 *  making any single response enormous. */
const PAGE_SIZE = 10_000

/** How long a refusal of the conversion metrics is believed before the daily
 *  check quietly asks again.
 *
 *  A month, because the alternative was worse in both directions: never asking
 *  again turns one bad afternoon into a permanent claim about somebody's
 *  account, and asking every day spends a wasted query a day for ever on an
 *  account that genuinely cannot have them. */
const CONVERSION_RETRY_DAYS = 30

/** Whether to include the conversion metrics in this run's query.
 *
 *  Pure, and exported, because it is the rule that stopped a transient 400 on
 *  a first run from telling an owner for ever that Google refuses them sales
 *  figures. Three ways to a yes:
 *
 *   - Nobody has ever found out (null). Ask.
 *   - Google said yes last time. Ask.
 *   - Google said no, but the owner has just pressed "Fetch now", or the no is
 *     older than CONVERSION_RETRY_DAYS. A press of that button IS the owner
 *     saying try again, which is the whole reason it is there.
 */
export function shouldAskForConversions(input: {
  available: boolean | null
  checkedAt: Date | null
  manual: boolean
  now: Date
}): boolean {
  if (input.available !== false) return true
  if (input.manual) return true
  // A false with no stamp on it was written by a version before the stamp
  // existed, or by a path that did not record one. Treat it as due.
  if (input.checkedAt === null) return true
  return input.now.getTime() - input.checkedAt.getTime() >= CONVERSION_RETRY_DAYS * 86_400_000
}

/**
 * One attempt, and one fallback WITHOUT the conversion metrics.
 *
 * This replaces reading Google's error text for the word "conversion", which
 * made the whole fallback hostage to how Google words a sentence. The proof is
 * behavioural and needs no wording at all:
 *
 *   - the long query fails with a 400;
 *   - the same window, asked again WITHOUT the conversion metrics, succeeds;
 *   - therefore those metrics were the cause, whatever Google called them.
 *
 * If the short query fails too, the conversion fields were not the problem, so
 * the ORIGINAL error is thrown - the one that describes what actually went
 * wrong, rather than the second-order complaint from a query nobody asked for.
 *
 * Only a 400 is worth a second try. A 403 is an access level, a 429 is a rate
 * limit and a 500 is Google having a moment; none of them is fixed by sending
 * fewer fields, and the client has already retried the ones worth retrying.
 *
 * `mayRetry` is the second half of the same care. A complaint about which
 * FIELDS were selected arrives on page one, because the query is identical on
 * every page; a 400 on page three is far more likely a spent page token or a
 * passing fault. Retrying there and succeeding - because the fault cleared,
 * not because the fields changed - would record "this account cannot have
 * sales figures" for something entirely unrelated. So the caller passes a
 * predicate that is false once any page has been accepted.
 *
 * Pure apart from the attempt and the predicate it is handed, which is the
 * point.
 */
export async function withConversionFallback<T>(
  attempt: (withConversions: boolean) => Promise<T>,
  withConversions: boolean,
  mayRetry: () => boolean = () => true,
): Promise<{ result: T; conversionsRefused: boolean }> {
  try {
    return { result: await attempt(withConversions), conversionsRefused: false }
  } catch (error) {
    if (!withConversions || !(error instanceof GoogleApiError) || error.status !== 400) throw error
    if (!mayRetry()) throw error
    let result: T
    try {
      result = await attempt(false)
    } catch {
      throw error
    }
    return { result, conversionsRefused: true }
  }
}

export type ImportOutcome =
  | {
      status: 'ok'
      /** Days actually asked for and written, oldest first. */
      from: string
      to: string
      /** Rows written. A day re-read counts again, because it was written again. */
      rows: number
      /** Windows the plan held, and how many this run got through. Unequal
       *  means the budget ran out and the next run carries on. */
      windows: number
      windowsDone: number
      /** True while history is still being caught up. */
      backfilling: boolean
      /** False when this run ended up without the conversion metrics: either
       *  Google refused them here, or a refusal recorded earlier is still
       *  fresh enough to be believed. Never a permanent verdict. */
      conversions: boolean
      /** True when this run actually put the question to Google, so the
       *  screen can tell "we asked and were told no" from "we did not ask
       *  this time". */
      conversionsAsked: boolean
      /** Days dropped by the retention setting. */
      pruned: number
      checkedAt: Date
    }
  | { status: 'skipped'; reason: ImportSkipReason }

/** Whether the import could even be attempted. */
export function canImportPerformance(): boolean {
  return hasGoogleCredentials()
}

export type ImportOptions = {
  /** True when a person pressed "Fetch now". The only thing it changes is
   *  that a previously refused conversions query is tried again - that press
   *  IS the owner saying try again. */
  manual?: boolean
  /** Today, for tests. Defaults to the real one. */
  today?: string
  /** Wall-clock budget in milliseconds. */
  budgetMs?: number
  /** A clock, for tests. */
  now?: () => number
}

export async function importPerformance(options: ImportOptions = {}): Promise<ImportOutcome> {
  const settings = await getGsfSettings()

  // The notice comes DOWN here, ahead of every guard below, and not after the
  // window loop where it used to live.
  //
  // All four early returns - switched off, no key, no account number, nothing
  // to do - come before the loop, so a clear that sat after it could never be
  // reached by any of them. The way that bites: the import fails, the notice
  // goes up, the owner decides they would rather not be nagged and switches
  // the import off, and from then on every run returns at 'switched-off'
  // before the clear. The notice then sits in the bell for ever, with no way
  // down except switching the thing back on and getting a clean run.
  //
  // Three of those four are "not running" and the fourth is a healthy run, so
  // none of them is a failure and all four belong on this side of the guards.
  //
  // `alertWasUp` is read BEFORE the clear and carried to the failure path: it
  // is what stops a run that fails again from emailing about it a second time.
  const alertWasUp = await isAlertUp(ALERT_KEYS.performanceImport)
  if (alertWasUp) await setPerformanceImportAlert({ failed: false })

  if (!settings.performanceImportEnabled) return { status: 'skipped', reason: 'switched-off' }
  if (!hasGoogleCredentials()) return { status: 'skipped', reason: 'no-credentials' }
  if (!settings.merchantId) return { status: 'skipped', reason: 'no-merchant-id' }

  const today = options.today ?? todayUtc()
  const clock = options.now ?? (() => Date.now())
  const budgetMs = options.budgetMs ?? BUDGET_MS
  const startedAt = clock()

  const plan = planImport({
    today,
    importedThrough: settings.performanceImportedThrough,
    backfillDays: settings.performanceBackfillDays,
  })
  if (plan.windows.length === 0 || !plan.span) return { status: 'skipped', reason: 'nothing-to-do' }

  // Whether to ask for the conversion metrics at all - see the rule above. A
  // refusal is remembered, but it expires and a press of Fetch now overrides
  // it, so an account is never permanently written off on one bad answer.
  const askedForConversions = shouldAskForConversions({
    available: settings.performanceConversionsAvailable,
    checkedAt: settings.performanceConversionsCheckedAt,
    manual: options.manual === true,
    now: new Date(clock()),
  })
  let withConversions = askedForConversions
  let conversionsRefused = false

  // Narrowed once here rather than asserted at each use: the guard above has
  // already established it, and an `as string` further down would survive a
  // later edit that removed the guard.
  const merchantId = settings.merchantId

  const completed: Array<{ from: string; to: string }> = []
  let rowsWritten = 0

  /** One window, read and written. A FRESH accumulator each time, including on
   *  the retry below: an accumulator that had already taken half of a failed
   *  attempt's pages would add the retry's rows to them and double a day's
   *  clicks. */
  const runWindow = async (window: { from: string; to: string }, conversions: boolean, progress: { pages: number }) => {
    const accumulator = new DayAccumulator(async (rows: PerformanceRow[]) => {
      await writePerformanceRows(rows)
    })
    try {
      await searchReportPages<ProductPerformanceResult>(
        merchantId,
        performanceQuery({ from: window.from, to: window.to, withConversions: conversions }),
        async (results) => {
          // Counted before anything is parsed: the question is whether Google
          // accepted the query at all, not whether the page held usable rows.
          progress.pages++
          const parsed: PerformanceRow[] = []
          for (const result of results) {
            const row = parsePerformanceRow(result)
            if (row) parsed.push(row)
          }
          await accumulator.addPage(parsed)
        },
        { pageSize: PAGE_SIZE },
      )
      await accumulator.finish()
    } finally {
      // Counted whether or not the window finished: these rows are in the
      // table either way, and the number on the screen should say so.
      rowsWritten += accumulator.rowsWritten
    }
  }

  for (const window of plan.windows) {
    // Between windows only. A window that is half written has told us nothing
    // we can move the cursor on, so it is never abandoned part way.
    if (completed.length > 0 && clock() - startedAt > budgetMs) break

    // Per window, so the predicate below asks about THIS window's first page
    // rather than about something that happened last Tuesday.
    const progress = { pages: 0 }
    try {
      const attempt = await withConversionFallback(
        (conversions) => runWindow(window, conversions, progress),
        withConversions,
        () => progress.pages === 0,
      )
      if (attempt.conversionsRefused) {
        // Proven by behaviour: the same window went through without them.
        withConversions = false
        conversionsRefused = true
      }
    } catch (error) {
      // The windows already completed are in the table and the cursor should
      // say so - but the run DIED, so the success stamp stays where it was and
      // the failure is recorded instead. Without this the tab would go on
      // saying "last fetched just now" about a fetch that never finished.
      await recordPerformanceCheck({
        outcome: 'failed',
        checkedAt: new Date(),
        importedThrough: cursorAfter({ today, completed, previous: settings.performanceImportedThrough }),
        conversionsAvailable: conversionsRefused ? false : settings.performanceConversionsAvailable,
        conversionsLearned: conversionsRefused,
        error: error instanceof Error ? error.message : String(error),
      })
      await setPerformanceImportAlert({
        failed: true,
        ...(error instanceof Error ? { message: error.message } : {}),
        // What it was BEFORE the clear at the top of this run, so a second
        // failing day raises the same notice without a second email.
        alreadyUp: alertWasUp,
      })
      throw error
    }
    completed.push(window)
  }

  const checkedAt = new Date()
  await recordPerformanceCheck({
    outcome: 'ok',
    checkedAt,
    importedThrough: cursorAfter({ today, completed, previous: settings.performanceImportedThrough }),
    // Only ever written when we learned something: a run that never asked for
    // conversions (because a previous refusal is still fresh) must not
    // re-assert what it did not test.
    conversionsAvailable: conversionsRefused ? false : withConversions ? true : settings.performanceConversionsAvailable,
    // And the stamp only moves when the question was actually put. That is
    // what makes the refusal expire rather than stand for ever.
    conversionsLearned: askedForConversions,
  })

  // After the write, and only when the owner asked for pruning at all. A
  // retention window of 0 means "keep the lot".
  let pruned = 0
  if (settings.performanceRetentionDays > 0) {
    pruned = await prunePerformance(addDays(today, -settings.performanceRetentionDays))
  }

  const last = completed[completed.length - 1]
  return {
    status: 'ok',
    from: plan.span.from,
    to: last?.to ?? plan.span.from,
    rows: rowsWritten,
    windows: plan.windows.length,
    windowsDone: completed.length,
    backfilling: plan.backfilling && completed.length < plan.windows.length,
    conversions: withConversions,
    conversionsAsked: askedForConversions,
    pruned,
    checkedAt,
  }
}
