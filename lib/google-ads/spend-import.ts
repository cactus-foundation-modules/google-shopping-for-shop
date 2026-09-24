// The daily import of what the Google Ads side of Shopping actually cost.
//
// Runs from the daily cron and from the Reports tab's own button. It reads and
// writes nothing at Google's end - `googleAds:search` is a query - so the only
// thing gating it is the owner having switched Google Ads on at all.
//
// It borrows the planner, the cursor and the day arithmetic from the Merchant
// Center import next door (lib/performance/plan.ts), because the two have the
// same two problems: Google revises the most recent few days after the fact, so
// they are re-read for ever; and a quarter of daily figures is more rows than a
// sixty-second route can hold, so the work is cut into windows and the cursor
// only ever advances past a window that finished.
//
// What it does NOT borrow is the call itself. Google Ads pages differently
// (`pageToken` only - sending `pageSize` is an error), answers in a different
// shape, and puts its money in millionths of the ACCOUNT'S currency, which has
// to be asked for separately because nothing in the spend report says what it
// is.
//
// NOTHING HERE HAS BEEN RUN AGAINST A REAL GOOGLE ADS ACCOUNT.
import { getGsfSettings, recordAdsAccount } from '@/modules/google-shopping-for-shop/lib/settings'
import { googleAdsCredentialsFromEnv } from '@/modules/google-shopping-for-shop/lib/google-ads/credentials'
import { searchAds, searchAdsPages } from '@/modules/google-shopping-for-shop/lib/google-ads/client'
import { ADS_ACCOUNT_QUERY, adsSpendQuery } from '@/modules/google-shopping-for-shop/lib/google-ads/query'
import { parseAdsAccount, parseAdsSpendRow, type AdsSpendRow } from '@/modules/google-shopping-for-shop/lib/google-ads/parse'
import {
  pruneAdsSpend,
  readAdsRun,
  recordAdsSpendCheck,
  writeAdsSpendRows,
} from '@/modules/google-shopping-for-shop/lib/google-ads/store'
import type { AdsSkipReason } from '@/modules/google-shopping-for-shop/lib/google-ads/types'
import { addDays, todayUtc } from '@/modules/google-shopping-for-shop/lib/performance/days'
import { cursorAfter, planImport } from '@/modules/google-shopping-for-shop/lib/performance/plan'

/** How long one run may spend asking Google before it stops and leaves the rest
 *  for next time. Checked BETWEEN windows only: a half-written window has told
 *  us nothing the cursor can be moved on, so it is never abandoned part way. A
 *  run therefore overshoots this by up to one window, which is expected rather
 *  than a slip - one window always completes before the budget is looked at.
 *
 *  Ten seconds, and it is small ON PURPOSE. Do not read it as timidity and
 *  raise it. The ceiling is NOT this route's sixty seconds:
 *
 *    - The cron dispatcher wakes at MOST every 30 minutes. The schedule is
 *      `DISPATCH_SCHEDULE` in lib/cron/vercel-file.ts, and vercel.json is
 *      GENERATED from it - editing that file alone is reverted on the install's
 *      next update. A site with a faster job gets a faster tick, see
 *      `dispatchScheduleForInterval`. Each wake gives every due job on the whole
 *      site ONE 54-second working tick between them (maxDuration 60 less a 6s
 *      reserve), run one after another.
 *    - The daily job this runs in is picked up on the same tick as every hourly
 *      job on the site, and it sorts to the FRONT of it: the dispatcher runs
 *      longest-waiting first, and it has waited twenty-four hours against their
 *      one.
 *    - So whatever this spends comes straight off the jobs behind it, including
 *      this module's own hourly price and stock push, which is deferred to the
 *      next wake: half an hour at the default tick, less on a faster one. It
 *      was a full hour until the dispatcher went half-hourly in September 2026.
 *
 *  That change makes a deferral CHEAPER. It is not permission to raise this
 *  number. A shorter wait is a smaller penalty for starving the queue, not a
 *  reason to starve it: the tick is still ~54 seconds, every due job still
 *  shares it, and this still sorts to the front of it. Ten here, and fifteen in
 *  the performance import, were the right call at an hourly tick and are the
 *  right call at a half-hourly one.
 *
 *  This one is the smaller of the two deliberately: it runs LAST in the daily
 *  route, after the four Merchant Center jobs, so it takes what is left rather
 *  than taking it off them. Spend is also a day in arrears at Google's end and
 *  revised afterwards, so a backfill spread over more nights loses nothing that
 *  a faster one would have caught. It resumes from its own cursor. */
const BUDGET_MS = 10_000

export type SpendImportOutcome =
  | {
      status: 'ok'
      from: string
      to: string
      /** Rows written. A day re-read counts again, because it was written again. */
      rows: number
      windows: number
      windowsDone: number
      /** True while history is still being caught up. */
      backfilling: boolean
      /** Days dropped by the retention setting. */
      pruned: number
      /** The account currency every cost is denominated in, as Google reported
       *  it. Null where Google did not say, in which case the screens say the
       *  currency is not known rather than guessing at one. */
      currency: string | null
      checkedAt: Date
    }
  | { status: 'skipped'; reason: AdsSkipReason }

export type SpendImportOptions = {
  /** Today, for tests. Defaults to the real one. */
  today?: string
  /** Wall-clock budget in milliseconds. */
  budgetMs?: number
  /** A clock, for tests. */
  now?: () => number
  /** Request options handed to the client - 0 backoff in tests. */
  retryBaseMs?: number
  attempts?: number
}

/**
 * The account's currency and timezone, refreshed and recorded.
 *
 * Asked once per run rather than per window. Both are needed to say anything
 * honest about the figures: the currency is what `cost_micros` is denominated
 * in, and the timezone is what Google's `segments.date` means - neither is ours
 * to assume, and a shop advertising in euros shown a pound sign would be a
 * quiet lie on every screen.
 */
export async function refreshAdsAccount(customerId: string, options: SpendImportOptions = {}): Promise<string | null> {
  const request = {
    ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
    ...(options.retryBaseMs === undefined ? {} : { retryBaseMs: options.retryBaseMs }),
  }
  const rows = await searchAds(customerId, ADS_ACCOUNT_QUERY, request)
  const account = parseAdsAccount(rows[0])
  await recordAdsAccount({ currency: account.currency, timeZone: account.timeZone, checkedAt: new Date() })
  return account.currency
}

export async function importAdsSpend(options: SpendImportOptions = {}): Promise<SpendImportOutcome> {
  const settings = await getGsfSettings()

  // The ways out that are nobody's fault. None of them is a failure, so none of
  // them records one - and none of them is allowed to leave a stale success
  // stamp looking like a fresh fetch either, which is why the stamp is only
  // ever written at the end.
  if (!settings.adsEnabled) return { status: 'skipped', reason: 'off' }
  if (!settings.adsSpendImportEnabled) return { status: 'skipped', reason: 'spend-off' }
  const credentials = googleAdsCredentialsFromEnv()
  if (!credentials) return { status: 'skipped', reason: 'no-credentials' }

  const today = options.today ?? todayUtc()
  const clock = options.now ?? (() => Date.now())
  const budgetMs = options.budgetMs ?? BUDGET_MS
  const startedAt = clock()

  const run = await readAdsRun()
  const plan = planImport({
    today,
    importedThrough: run.spendImportedThrough,
    backfillDays: settings.adsSpendBackfillDays,
  })
  if (plan.windows.length === 0 || !plan.span) return { status: 'skipped', reason: 'nothing-to-do' }

  const request = {
    ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
    ...(options.retryBaseMs === undefined ? {} : { retryBaseMs: options.retryBaseMs }),
  }

  const completed: Array<{ from: string; to: string }> = []
  let rowsWritten = 0
  let currency: string | null = settings.adsCurrency

  /** Everything that has been written by now, and where the cursor may honestly
   *  be said to have reached. Used by both endings. */
  const cursor = () => cursorAfter({ today, completed, previous: run.spendImportedThrough })

  try {
    // Before the windows, so a currency change is picked up before any row is
    // written with the old one. Its own failure is the run's failure: a spend
    // figure with no currency on it is not a figure anybody can act on.
    currency = await refreshAdsAccount(credentials.customerId, options)

    for (const window of plan.windows) {
      // Between windows only.
      if (completed.length > 0 && clock() - startedAt > budgetMs) break

      // A fresh buffer per window. One that had already taken half of a failed
      // attempt's pages would add the retry's rows to them and double a day.
      let written = 0
      await searchAdsPages(credentials.customerId, adsSpendQuery(window), async (page) => {
        const parsed: AdsSpendRow[] = []
        for (const row of page) {
          const spend = parseAdsSpendRow(row)
          if (spend) parsed.push(spend)
        }
        if (parsed.length > 0) {
          await writeAdsSpendRows(parsed, currency)
          written += parsed.length
        }
      }, request)
      rowsWritten += written
      completed.push(window)
    }
  } catch (error) {
    // Whatever was read IS in the table, so the cursor is moved to say so - but
    // the run DIED, so the success stamp stays exactly where it was and the
    // failure is recorded beside it. Without this the tab would go on saying
    // "last fetched just now" about a fetch that never finished.
    await recordAdsSpendCheck({
      outcome: 'failed',
      checkedAt: new Date(),
      importedThrough: cursor(),
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }

  const checkedAt = new Date()
  await recordAdsSpendCheck({ outcome: 'ok', checkedAt, importedThrough: cursor() })

  // After the write, and only when the owner asked for pruning at all. A
  // retention window of 0 means "keep the lot".
  let pruned = 0
  if (settings.adsSpendRetentionDays > 0) {
    pruned = await pruneAdsSpend(addDays(today, -settings.adsSpendRetentionDays))
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
    pruned,
    currency,
    checkedAt,
  }
}
