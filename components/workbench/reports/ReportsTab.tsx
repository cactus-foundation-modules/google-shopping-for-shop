'use client'

// The workbench's Reports sub-tab, and the first thing anyone sees when they
// open Google Shopping.
//
// Everything on this screen is GOOGLE'S FIGURE, not the shop's. Google counts
// an impression and a click its own way, publishes them about a day late, and
// revises the most recent few days afterwards. The screen says all of that out
// loud, because the alternative is an owner comparing these numbers with their
// own analytics, finding they disagree, and trusting neither.
//
// Three refusals worth noticing in the code below:
//
//   - Nothing calls Google on load. The figures are read from our own tables;
//     the refresh button is the only thing that picks up the telephone.
//   - A day with nothing brought in is never drawn as a zero, in the chart or
//     in a total.
//   - A conversion figure Google does not report is shown as "Google does not
//     report this", never as nought. Paid rows never carry one - that is
//     Google's rule, not a fault here - and an owner who read a confident 0
//     would conclude their ads sold nothing.
import { useCallback, useEffect, useState } from 'react'
import { workbenchCss } from '@/modules/google-shopping-for-shop/components/workbench/workbench-css'
import { reportsCss } from '@/modules/google-shopping-for-shop/components/workbench/reports/reports-css'
import { formatCount, formatDateTime, formatMoney, plural } from '@/modules/google-shopping-for-shop/components/workbench/format'
import { TrendChart, type TrendMetric } from '@/modules/google-shopping-for-shop/components/workbench/reports/TrendChart'
import { BestSellersPanel } from '@/modules/google-shopping-for-shop/components/workbench/reports/BestSellersPanel'
import { LiveTrackingPanel } from '@/modules/google-shopping-for-shop/components/workbench/reports/LiveTrackingPanel'
import { AdsSpendPanel } from '@/modules/google-shopping-for-shop/components/workbench/reports/AdsSpendPanel'
import { ReportSettings } from '@/modules/google-shopping-for-shop/components/workbench/reports/ReportSettings'
import {
  DEFAULT_REPORT_QUERY,
  fetchReport,
  refreshReports,
  saveReportSettings,
  type PerformanceReport,
  type ReportQueryParams,
  type ReportSettingsPatch,
} from '@/modules/google-shopping-for-shop/components/workbench/reports/api'
import {
  IMPORT_SKIP_COPY,
  PRODUCT_SORTS,
  REPORT_RANGES,
  REPORT_RANGE_LABELS,
  type PerformanceTotals,
  type ProductSort,
  type ReportRange,
} from '@/modules/google-shopping-for-shop/lib/performance/types'
import { BEST_SELLERS_SKIP_COPY } from '@/modules/google-shopping-for-shop/lib/best-sellers/types'

type Notice = { tone: 'ok' | 'error' | 'info'; text: string }

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

const SORT_LABELS: Record<ProductSort, string> = {
  clicks: 'Clicks',
  impressions: 'Times shown',
  ctr: 'Click rate',
  conversions: 'Sales',
}

/** A rate as a percentage, or the honest absence of one. An impression count
 *  of zero has no rate - it is not nought per cent. */
function formatRate(rate: number | null): string {
  return rate === null ? 'no answer' : `${(rate * 100).toFixed(2)}%`
}

/** One figure in a headline column. `absent` is the sentence shown instead of
 *  a number when Google does not report the thing at all. */
function Figure({ label, value, absent }: { label: string; value: string | null; absent?: string }) {
  return (
    <div className="gsr-figure">
      <span className="gsr-figure-label">{label}</span>
      <span className={`gsr-figure-value${value === null ? ' is-absent' : ''}`}>
        {value ?? absent ?? 'not reported'}
      </span>
    </div>
  )
}

function TotalsColumn({ title, series, totals }: { title: string; series: 'organic' | 'ads'; totals: PerformanceTotals }) {
  return (
    <div className="gsr-column">
      <span className="gsr-column-head">
        <span className={`gsr-swatch is-${series}`} aria-hidden="true" />
        {title}
      </span>
      <div className="gsr-figures">
        <Figure label="Times shown" value={formatCount(totals.impressions)} />
        <Figure label="Clicks" value={formatCount(totals.clicks)} />
        <Figure label="Click rate" value={formatRate(totals.clickThroughRate)} />
        <Figure
          label="Sales"
          value={totals.conversions === null ? null : formatCount(Math.round(totals.conversions))}
          absent={series === 'ads' ? 'Google reports sales for free listings only' : 'not reported'}
        />
        <Figure
          label="Sales value"
          value={totals.conversionValue === null ? null : formatMoney(totals.conversionValue, totals.conversionCurrency ?? 'GBP')}
          absent={series === 'ads' ? 'free listings only' : 'not reported'}
        />
      </div>
    </div>
  )
}

export function ReportsTab() {
  const [query, setQuery] = useState<ReportQueryParams>(DEFAULT_REPORT_QUERY)
  const [report, setReport] = useState<PerformanceReport | null>(null)
  const [metric, setMetric] = useState<TrendMetric>('clicks')
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState<'refresh' | 'settings' | null>(null)

  const load = useCallback(async (next: ReportQueryParams, signal?: AbortSignal) => {
    try {
      // The await sits inside the setState call rather than a line above it,
      // the same way the Health and Delivery tabs do it: it is what makes
      // plain to a reader and to the lint rule that nothing here sets state
      // synchronously while an effect is running.
      setReport(await fetchReport(next, signal))
      setLoadError('')
    } catch (error) {
      if (signal?.aborted) return
      setLoadError(messageOf(error, 'Could not load the Google figures'))
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch per query; every setState in load() runs after an await
    void load(query, controller.signal)
    return () => controller.abort()
  }, [load, query])

  function narrow(patch: Partial<ReportQueryParams>) {
    // Any change other than the page itself goes back to page one: staying on
    // page nine of a list that just became three pages long strands the owner
    // on an empty screen.
    setQuery((held) => ({ ...held, ...patch, ...(patch.page === undefined ? { page: 1 } : {}) }))
  }

  async function runRefresh() {
    setBusy('refresh')
    setNotice(null)
    try {
      const outcome = await refreshReports()
      const lines: string[] = []

      if (outcome.performance.status === 'ok') {
        const done = outcome.performance
        lines.push(
          done.backfilling
            ? `Brought in ${plural(done.rows, 'figure')} up to ${done.to}. Still catching up on earlier days - ${done.windowsDone} of ${done.windows} batches done, and the rest follows on the next check.`
            : `Brought in ${plural(done.rows, 'figure')} up to ${done.to}.`,
        )
        if (!done.conversions) {
          lines.push('Google would not report sales for this account, so those columns stay empty.')
        }
        if (done.pruned > 0) lines.push(`Dropped ${plural(done.pruned, 'old figure')} past the keeping window.`)
      } else if (outcome.performance.status === 'skipped') {
        lines.push(IMPORT_SKIP_COPY[outcome.performance.reason])
      } else {
        lines.push(outcome.performance.message)
      }

      if (outcome.bestSellers.status === 'ok') {
        const sellers = outcome.bestSellers
        if (sellers.unavailable) {
          lines.push('Google would not give best sellers rankings for this account.')
        } else {
          lines.push(`Brought in ${plural(sellers.rows, 'ranking')}.`)
          // A refusal on SOME categories is a per-category answer, and saying
          // which ones is the difference between a short list and a mystery.
          if (sellers.refusedCategories.length > 0) {
            const named = sellers.refusedCategories.filter((id) => id !== '')
            lines.push(named.length > 0
              ? `Google does not rank ${named.length === 1 ? 'category' : 'categories'} ${named.join(', ')}, so nothing came back for ${named.length === 1 ? 'that one' : 'those'}.`
              : 'Google would not answer one of the requests, so part of the list is missing.')
          }
          if (sellers.pruned > 0) lines.push(`Dropped ${plural(sellers.pruned, 'old ranking')} past the keeping window.`)
        }
      } else if (outcome.bestSellers.status === 'skipped') {
        // Switched off is the usual answer here and is not worth shouting
        // about, so it only gets a line when something else went wrong too.
        if (outcome.bestSellers.reason !== 'switched-off') lines.push(BEST_SELLERS_SKIP_COPY[outcome.bestSellers.reason])
      } else {
        lines.push(outcome.bestSellers.message)
      }

      const failed = outcome.performance.status === 'failed'
      setNotice({ tone: failed ? 'error' : 'ok', text: lines.join(' ') })
      await load(query)
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not fetch the Google figures') })
    } finally {
      setBusy(null)
    }
  }

  async function saveSettings(patch: ReportSettingsPatch) {
    setBusy('settings')
    setNotice(null)
    try {
      setReport(await saveReportSettings(patch))
      setNotice({ tone: 'ok', text: 'Saved.' })
      // Re-read with the query actually on screen: the save answers with the
      // default range, which is not necessarily the one being looked at.
      await load(query)
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not save those settings') })
    } finally {
      setBusy(null)
    }
  }

  const totals = report?.totals
  const state = report?.state

  return (
    <div className="gsr">
      <style>{workbenchCss}{reportsCss}</style>

      <div className="gsr-head">
        <div>
          <h2 className="gsw-title">Reports</h2>
          <p className="gsw-lede">
            Google&apos;s own figures for your products: what it showed, what people clicked, and what came of it. Free listings and
            paid ads are kept apart. Brought in once a day; Google publishes these about a day late and keeps adjusting the most
            recent few days, so today and yesterday always read low.
          </p>
        </div>
        <div className="gsr-actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy !== null || !report?.can.refresh}
            onClick={() => void runRefresh()}
          >
            {busy === 'refresh' ? 'Asking Google…' : 'Fetch now'}
          </button>
        </div>
      </div>

      {report && !report.can.refresh && (
        <p className="gsw-message is-info">
          {report.can.credentials
            ? 'Fill in your Merchant Center account number on the Google Shopping settings tab and these figures can be fetched.'
            : 'Save a Google service-account key on the Google Shopping settings tab and these figures can be fetched.'}
        </p>
      )}

      {notice && <p className={`gsw-message is-${notice.tone}`}>{notice.text}</p>}
      {loadError !== '' && <p className="gsw-message is-error">{loadError}</p>}

      {state?.failedAt && (
        // A failed run leaves the success stamp where it was, so this is the
        // only thing that says the last attempt died. It gets its own line,
        // above the status, because "we could not fetch" is not a footnote to
        // "here are your figures".
        <p className="gsw-message is-error">
          The last attempt to fetch Google&apos;s figures failed on {formatDateTime(state.failedAt)}
          {state.lastError ? <>: {state.lastError}</> : null}
          {' '}What is shown below is whatever was already brought in.
        </p>
      )}

      {state && (
        <p className="gsw-status">
          {state.checkedAt
            ? <>
                Last fetched from Google <strong>{formatDateTime(state.checkedAt)}</strong>.
                {state.heldFrom && state.heldTo
                  ? <> Figures held for <strong>{state.heldFrom}</strong> to <strong>{state.heldTo}</strong>.</>
                  : <> No figures held yet.</>}
                {state.backfilling && <> Still catching up on earlier days; the rest arrives over the next few checks.</>}
              </>
            // Never a tidy zero from an empty table: nobody has asked. With
            // a failure above, "not been asked yet" on its own reads as a
            // contradiction, so the two are joined into one sentence.
            : state.failedAt
              ? <>Nothing has been brought in yet - the attempt above is the only one there has been.</>
              : <>Google has not been asked for these figures yet, so there is nothing to show. That is not the same as nothing having happened.</>}
        </p>
      )}

      {/* --- Range ------------------------------------------------------- */}
      <div className="gsr-range">
        <span className="gsw-chips-label">Showing</span>
        {REPORT_RANGES.map((range) => (
          <button
            key={range}
            type="button"
            className={`gsw-chip${query.range === range ? ' is-active' : ''}`}
            aria-pressed={query.range === range}
            onClick={() => narrow({ range: range as ReportRange })}
          >
            {REPORT_RANGE_LABELS[range]}
          </button>
        ))}
        {query.range === 'custom' && (
          <span className="gsr-dates">
            <label htmlFor="gsr-from">From</label>
            <input
              id="gsr-from"
              type="date"
              value={query.from}
              max={report?.today ?? undefined}
              onChange={(event) => narrow({ from: event.target.value })}
            />
            <label htmlFor="gsr-to">to</label>
            <input
              id="gsr-to"
              type="date"
              value={query.to}
              max={report?.today ?? undefined}
              onChange={(event) => narrow({ to: event.target.value })}
            />
          </span>
        )}
      </div>

      {/* --- Headline figures -------------------------------------------- */}
      {totals && report && (
        <section className="gsr-panel" aria-label="Headline figures from Google">
          <h3 className="gsr-panel-title">
            {report.range.from === report.range.to
              ? `Google's figures for ${report.range.from}`
              : `Google's figures for ${report.range.from} to ${report.range.to}`}
          </h3>
          <p className="gsr-panel-note">
            These are Google&apos;s counts, not this site&apos;s. They run about a day behind and the newest days are still being
            adjusted, so do not read too much into the last two.
          </p>
          <div className="gsr-columns">
            <TotalsColumn title="Free listings" series="organic" totals={totals.organic} />
            <TotalsColumn title="Paid ads" series="ads" totals={totals.ads} />
          </div>
          {/* Google can file a click under a marketing method this version has
              never heard of - it has renamed these before. Such a click is in
              neither column above but IS in the product table below, so the
              two would not add up and nothing would say why. Said here, and
              only when there is something to say. */}
          {totals.all.clicks > totals.organic.clicks + totals.ads.clicks && (
            <p className="gsr-panel-note">
              Google also reported {plural(totals.all.clicks - totals.organic.clicks - totals.ads.clicks, 'click')} under a kind
              of listing this version does not recognise yet. They are not in either column above, but they are counted in the
              product table below, so the two will not quite agree.
            </p>
          )}
          {state?.conversionsAvailable === false && (
            <p className="gsr-panel-note">
              Google turned down the request for sales figures
              {state.conversionsCheckedAt ? <> on {formatDateTime(state.conversionsCheckedAt)}</> : null}, so those two columns
              stay empty. Everything else is unaffected. That is not taken as final: the daily check asks again after a month,
              and <strong>Fetch now</strong> asks again straight away.
            </p>
          )}
        </section>
      )}

      {/* --- Trend -------------------------------------------------------- */}
      {report && report.trend.length > 0 && (
        <section className="gsr-panel" aria-label="Day by day">
          <div className="gsr-head">
            <h3 className="gsr-panel-title">Day by day</h3>
            <div className="gsr-actions">
              {(['clicks', 'impressions'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`gsw-chip${metric === option ? ' is-active' : ''}`}
                  aria-pressed={metric === option}
                  onClick={() => setMetric(option)}
                >
                  {option === 'clicks' ? 'Clicks' : 'Times shown'}
                </button>
              ))}
            </div>
          </div>
          <TrendChart days={report.trend} metric={metric} />
        </section>
      )}

      {/* --- Per product -------------------------------------------------- */}
      {report && (
        <section className="gsr-panel" aria-label="Product by product">
          <div className="gsr-head">
            <h3 className="gsr-panel-title">Product by product</h3>
            <div className="gsr-actions">
              <div className="gsw-search">
                <input
                  type="search"
                  value={query.search}
                  placeholder="Search by title or item number"
                  aria-label="Search the products Google reported on"
                  onChange={(event) => narrow({ search: event.target.value })}
                />
              </div>
            </div>
          </div>
          <p className="gsr-panel-note">
            Free listings and paid ads added together, for every item Google reported on in this period - including items that
            have since left your feed. The typical price is Google&apos;s own benchmark for the same product elsewhere, from the
            daily check.
          </p>

          {report.products.rows.length === 0 ? (
            <div className="gsr-empty">
              <strong>Nothing to show for these dates</strong>
              {state?.checkedAt
                ? 'Either Google reported nothing in this period, or these days have not been brought in yet.'
                : 'Nothing has been fetched from Google yet.'}
            </div>
          ) : (
            <div className="gsr-table-wrap">
              <table className="gsr-table">
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    {PRODUCT_SORTS.map((sort) => (
                      <th key={sort} scope="col" className="is-number">
                        <button
                          type="button"
                          className={`gsr-sort${query.sort === sort ? ' is-active' : ''}`}
                          aria-pressed={query.sort === sort}
                          onClick={() => narrow({ sort })}
                        >
                          {SORT_LABELS[sort]}
                          {query.sort === sort && <span aria-hidden="true">↓</span>}
                        </button>
                      </th>
                    ))}
                    <th scope="col" className="is-number">Typical price</th>
                  </tr>
                </thead>
                <tbody>
                  {report.products.rows.map((row) => (
                    <tr key={row.itemId}>
                      <td>
                        {row.merchantCentreUrl
                          ? <a className="gsr-item-title" href={row.merchantCentreUrl} target="_blank" rel="noreferrer">{row.title ?? row.itemId}</a>
                          : <span className="gsr-item-title">{row.title ?? row.itemId}</span>}
                        <span className="gsr-item-id">{row.itemId}</span>
                      </td>
                      <td className="is-number">{formatCount(row.clicks)}</td>
                      <td className="is-number">{formatCount(row.impressions)}</td>
                      <td className="is-number">{formatRate(row.clickThroughRate)}</td>
                      <td className="is-number">
                        {row.conversions === null
                          ? <span className="gsr-absent">not reported</span>
                          : formatCount(Math.round(row.conversions))}
                      </td>
                      <td className="is-number">
                        {row.benchmarkAmount === null
                          ? <span className="gsr-absent">not given</span>
                          : formatMoney(row.benchmarkAmount, row.benchmarkCurrency ?? 'GBP')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {report.products.pageCount > 1 && (
            <div className="gsr-actions">
              <button
                type="button"
                className="btn btn-sm"
                disabled={report.products.page <= 1}
                onClick={() => narrow({ page: report.products.page - 1 })}
              >
                Previous
              </button>
              <span className="gsw-small gsw-muted">
                Page {formatCount(report.products.page)} of {formatCount(report.products.pageCount)}, {plural(report.products.total, 'product')}
              </span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={report.products.page >= report.products.pageCount}
                onClick={() => narrow({ page: report.products.page + 1 })}
              >
                Next
              </button>
            </div>
          )}
        </section>
      )}

      {/* This site's OWN count, under Google's and visibly apart from it. The
          two never agree; see the panel's own note for why. */}
      <LiveTrackingPanel query={{ range: query.range, from: query.from, to: query.to }} />

      {/* And what the paid half of it all cost, from Google Ads - a different
          account, a different sign-in, and so a panel of its own. */}
      <AdsSpendPanel query={{ range: query.range, from: query.from, to: query.to }} />

      {report && <BestSellersPanel bestSellers={report.bestSellers} />}

      {report && (
        <ReportSettings
          settings={report.settings}
          busy={busy === 'settings'}
          onSave={(patch) => void saveSettings(patch)}
        />
      )}
    </div>
  )
}
