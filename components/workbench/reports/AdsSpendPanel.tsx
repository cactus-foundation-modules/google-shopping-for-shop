'use client'

// The Reports tab's Google Ads panel: what the paid half of Shopping cost.
//
// Third of three panels, and deliberately a third panel rather than a money
// column bolted onto either of the others:
//
//   Google's figures    Merchant Center's count of free and paid clicks, with
//                       no money in it at all.
//   This site's figures landings and sales this site saw for itself.
//   This one            what Google Ads charged, and what that came to per
//                       sale this site can point at.
//
// THERE IS NO PROFIT FIGURE AND THERE IS NOT GOING TO BE ONE. The site knows
// what a product sold for and has no idea what it cost to buy, and a margin
// built on a guess is worse than no margin at all. Cost per sale is the honest
// version of the same question.
//
// The wrinkle this panel has to own: the spend is dated in Google Ads' own
// timezone, which Google chooses, and the sales are dated in this site's. Over
// a month that is an evening at each end; over "today" it can be most of the
// figure. So the panel says which is which rather than quietly presenting one
// number as though both halves agreed on when a day starts.
import { useCallback, useEffect, useState } from 'react'
import { formatCount, formatDateTime, formatMoney, plural } from '@/modules/google-shopping-for-shop/components/workbench/format'
import { fetchAdsReport, type AdsReport } from '@/modules/google-shopping-for-shop/components/workbench/reports/api'
import type { ReportQueryParams } from '@/modules/google-shopping-for-shop/components/workbench/reports/api'

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/** One figure in a headline column. `absent` is the sentence shown instead of a
 *  number when there is no answer to give - never a nought nobody earned. */
function Figure({ label, value, absent }: { label: string; value: string | null; absent?: string }) {
  return (
    <div className="gsr-figure">
      <span className="gsr-figure-label">{label}</span>
      <span className={`gsr-figure-value${value === null ? ' is-absent' : ''}`}>{value ?? absent ?? 'no answer'}</span>
    </div>
  )
}

type Props = { query: Pick<ReportQueryParams, 'range' | 'from' | 'to'> }

export function AdsSpendPanel({ query }: Props) {
  const [report, setReport] = useState<AdsReport | null>(null)
  const [loadError, setLoadError] = useState('')

  const load = useCallback(async (next: Props['query'], signal?: AbortSignal) => {
    try {
      // The await sits inside the setState call rather than a line above it,
      // the same way the other panels do it: it is what makes plain to a reader
      // and to the lint rule that nothing sets state synchronously inside an
      // effect.
      setReport(await fetchAdsReport(next, signal))
      setLoadError('')
    } catch (error) {
      if (signal?.aborted) return
      setLoadError(messageOf(error, 'Could not load what your ads cost'))
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch per query; every setState in load() runs after an await
    void load(query, controller.signal)
    return () => controller.abort()
  }, [load, query])

  if (loadError !== '') {
    return (
      <section className="gsr-panel" aria-label="What your ads cost">
        <h3 className="gsr-panel-title">What your ads cost</h3>
        <p className="gsw-message is-error">{loadError}</p>
      </section>
    )
  }
  if (!report) return null

  // Nothing switched on is not a failure and must not read like one.
  if (!report.settings.adsEnabled) {
    return (
      <section className="gsr-panel" aria-label="What your ads cost">
        <h3 className="gsr-panel-title">What your ads cost</h3>
        <p className="gsr-panel-note">
          Google Ads is switched off for this site, so there is nothing to show here.
          {report.can.credentials
            ? ' Switch it on from the Health tab and what your adverts cost will start coming in once a day.'
            : ' It has not been connected yet either - the Health tab lists exactly which details are still needed.'}
        </p>
      </section>
    )
  }

  // Deliberately NOT falling back to the shop's own currency. A shop that
  // advertises in euros shown a pound sign would be a quiet lie on the two
  // figures most likely to be acted on, and everything else in this panel
  // refuses to guess.
  const spendCurrency = report.spendCurrency
  const money = (amount: number): string | null => (spendCurrency === null ? null : formatMoney(amount, spendCurrency))
  const nothingHeld = report.state.rowsHeld === 0

  return (
    <section className="gsr-panel" aria-label="What your ads cost">
      <h3 className="gsr-panel-title">
        {report.range.from === report.range.to
          ? `What your ads cost on ${report.range.from}`
          : `What your ads cost, ${report.range.from} to ${report.range.to}`}
      </h3>
      <p className="gsr-panel-note">
        Straight from Google Ads. The cost per sale below divides that spend by the sales <strong>this site</strong> tied to a paid
        Google click - not by Google Ads&apos; own conversion count, which includes whatever else that account is tracking. There is
        no profit figure here on purpose: the site knows what things sold for and not what they cost to buy.
      </p>

      {report.state.failedAt && (
        <p className="gsw-message is-error">
          The last attempt to fetch these figures failed on {formatDateTime(report.state.failedAt)}
          {report.state.lastError ? <>: {report.state.lastError}</> : null}
          {' '}What is shown below is whatever was already brought in.
        </p>
      )}

      {nothingHeld ? (
        <div className="gsr-empty">
          <strong>Nothing has been brought in yet</strong>
          {report.state.checkedAt
            ? 'Google Ads reported no spend for these dates.'
            : 'Google Ads has not been asked what your adverts cost yet. That is not the same as them having cost nothing.'}
        </div>
      ) : (
        <>
          <div className="gsr-columns">
            <div className="gsr-column">
              <span className="gsr-column-head">Google Ads charged</span>
              <div className="gsr-figures">
                <Figure label="Spend" value={money(report.spend.cost)} absent={`${formatCount(report.spend.cost)} - currency not known`} />
                <Figure label="Clicks" value={formatCount(report.spend.clicks)} />
                <Figure label="Times shown" value={formatCount(report.spend.impressions)} />
              </div>
            </div>
            <div className="gsr-column">
              <span className="gsr-column-head">This site tied to a paid click</span>
              <div className="gsr-figures">
                <Figure label="Sales" value={formatCount(report.attributed.orders)} />
                <Figure label="Their value" value={formatMoney(report.attributed.revenue, report.attributed.currency)} />
                <Figure
                  label="Cost per sale"
                  value={report.costPerSale === null ? null : money(report.costPerSale)}
                  absent={report.costPerSale === null ? 'no sales to divide by' : 'currency not known'}
                />
              </div>
            </div>
          </div>

          {spendCurrency === null && (
            <p className="gsw-message is-info">
              Google Ads has not told this site which currency the account bills in, so the spend figures are shown as plain
              numbers rather than with a currency in front of them. Press <strong>Check the connection</strong> on the settings
              tab, or <strong>Fetch costs now</strong> on the Health tab, and it will ask again.
            </p>
          )}

          <p className="gsr-panel-note">
            The two columns count their days differently and always will: Google Ads dates its spend in
            {report.accountTimeZone ? <> the account&apos;s own timezone ({report.accountTimeZone})</> : <> its own timezone, which this site has not been told</>},
            and the sales are dated in this shop&apos;s. Over a month that is an evening at either end; over a single day it can be
            most of the difference. Only sales from shoppers who agreed to marketing can be tied to a click at all, so the sales
            column is a floor rather than a full count.
          </p>

          {report.items.rows.length > 0 && (
            <div className="gsr-table-wrap">
              <table className="gsr-table">
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col" className="is-number">Spend</th>
                    <th scope="col" className="is-number">Clicks</th>
                    <th scope="col" className="is-number">Times shown</th>
                    <th scope="col" className="is-number">Google&apos;s own sales count</th>
                  </tr>
                </thead>
                <tbody>
                  {report.items.rows.map((row) => (
                    <tr key={row.itemId}>
                      <td>
                        <span className="gsr-item-title">{row.title ?? row.itemId}</span>
                        <span className="gsr-item-id">{row.itemId}</span>
                      </td>
                      <td className="is-number">{money(row.cost) ?? formatCount(row.cost)}</td>
                      <td className="is-number">{formatCount(row.clicks)}</td>
                      <td className="is-number">{formatCount(row.impressions)}</td>
                      <td className="is-number">
                        {row.conversions === null
                          ? <span className="gsr-absent">not reported</span>
                          : formatCount(Math.round(row.conversions))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {report.items.total > report.items.shown && (
            <p className="gsr-panel-note">
              Showing the {plural(report.items.shown, 'product')} that cost the most, out of {formatCount(report.items.total)} with
              any spend against them in these dates.
            </p>
          )}
        </>
      )}

      <p className="gsw-status">
        {report.state.checkedAt
          ? <>Last fetched from Google Ads <strong>{formatDateTime(report.state.checkedAt)}</strong>.</>
          : <>Google Ads has not been asked for these figures yet.</>}
        {report.settings.spendImportEnabled
          ? <> Brought in once a day; Google publishes it about a day late.</>
          : <> The daily fetch is switched off on the Health tab, so this will not change on its own.</>}
      </p>
    </section>
  )
}
