'use client'

// This site's own count of Google traffic, sitting under Google's.
//
// The reason it is a separate panel with its own border and its own standing
// caption, rather than two more columns in the figures above: the two counts
// will never agree, and an owner who reads them as one set of numbers will
// conclude that one of them is broken. Google counts a click when it hands the
// visitor over; this counts a landing when the page actually ran in their
// browser. Everything in between - a back button pressed too early, an ad
// blocker, a browser refusing the request - is a difference, and the caption
// says so in as many words.
//
// What is never drawn:
//   - a conversion rate over landings that could never convert. A visitor who
//     declined marketing is counted and cannot be joined to a sale, so the rate
//     divides by the landings that COULD, and the screen says how many that was.
//   - money the shop has not confirmed. A sale the shopper has seen but the
//     bank has not settled shows as pending, not as revenue.
//   - a tidy zero for a site that has never recorded anything. "Nothing has
//     been counted yet" and "nothing happened in these dates" are different
//     sentences, and both get said.
import { useCallback, useEffect, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { formatCount, formatDateTime, formatMoney, plural } from '@/modules/google-shopping-for-shop/components/workbench/format'
import { formatDuration } from '@/modules/google-shopping-for-shop/components/workbench/reports/duration'
import {
  fetchAttributedOrder,
  fetchLiveReport,
  saveTrackingSettings,
  type AttributedOrderView,
  type LiveReport,
  type ReportQueryParams,
  type TrackingSettingsPatch,
} from '@/modules/google-shopping-for-shop/components/workbench/reports/api'

/** Often enough to feel live on a screen somebody is watching, slow enough that
 *  a tab left open all afternoon is not a load on the database. Paused while
 *  the tab is hidden and caught up the moment it comes back - the same pattern
 *  core's notification bell uses. */
const POLL_INTERVAL_MS = 20_000

type RangeQuery = Pick<ReportQueryParams, 'range' | 'from' | 'to'>

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function formatRate(rate: number | null): string {
  return rate === null ? 'no answer yet' : `${(rate * 100).toFixed(1)}%`
}

function SourceColumn({ title, source, totals, currency }: {
  title: string
  source: 'free' | 'paid'
  totals: LiveReport['totals']['free']
  currency: string
}) {
  return (
    <div className="gsr-column">
      <span className="gsr-column-head">
        <span className={`gsl-dot is-${source}`} aria-hidden="true" />
        {title}
      </span>
      <div className="gsr-figures">
        <div className="gsr-figure">
          <span className="gsr-figure-label">Landings</span>
          <span className="gsr-figure-value">{formatCount(totals.landings)}</span>
        </div>
        <div className="gsr-figure">
          <span className="gsr-figure-label">Sales</span>
          <span className="gsr-figure-value">{formatCount(totals.orders)}</span>
        </div>
        <div className="gsr-figure">
          <span className="gsr-figure-label">Revenue</span>
          <span className="gsr-figure-value">{formatMoney(totals.revenue, currency)}</span>
        </div>
        <div className="gsr-figure">
          <span className="gsr-figure-label">Sale rate</span>
          <span className={`gsr-figure-value${totals.conversionRate === null ? ' is-absent' : ''}`}>
            {formatRate(totals.conversionRate)}
          </span>
        </div>
      </div>
    </div>
  )
}

function OrderDetail({ view, orderHref }: { view: AttributedOrderView; orderHref: string }) {
  const landed = view.click.variantName
    ? `${view.click.productName} - ${view.click.variantName}`
    : view.click.productName
  return (
    <div className="gsl-detail">
      <dl>
        <div>
          <dt>Landed on</dt>
          <dd>{landed}</dd>
        </div>
        <div>
          <dt>Arrived</dt>
          <dd>{formatDateTime(view.click.landedAt)}</dd>
        </div>
        <div>
          <dt>Came from</dt>
          <dd>{view.click.source === 'paid' ? 'A paid ad' : 'A free listing'}</dd>
        </div>
        <div>
          <dt>Time to buy</dt>
          <dd>{formatDuration(view.secondsToPurchase)}</dd>
        </div>
        <div>
          <dt>Order value</dt>
          <dd>
            {view.value === null || view.currency === null
              ? 'Not settled yet'
              : formatMoney(view.value, view.currency)}
          </dd>
        </div>
      </dl>
      <p className="gsr-panel-note">
        <a href={orderHref}>Open order {view.orderNumber}</a>
      </p>
      <div>
        <dt className="gsr-figure-label">What was bought</dt>
        {view.boughtItems.length === 0 ? (
          <p className="gsr-panel-note">Nothing is recorded against this order.</p>
        ) : (
          <ul className="gsl-bought">
            {view.boughtItems.map((item, index) => (
              <li key={`${item.productId ?? 'gone'}-${index}`}>
                {item.name}
                {item.quantity > 1 ? ` x ${formatCount(item.quantity)}` : ''}
                {/* Said plainly rather than left for the reader to spot: an ad
                    that sold something else is still a sale, and it is one of
                    the more useful things on this screen. */}
                {item.productId && item.productId !== view.click.productId && item.productId !== view.click.variantId
                  ? ' (not what they landed on)'
                  : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export function LiveTrackingPanel({ query }: { query: RangeQuery }) {
  const adminPath = useAdminPath()
  const [report, setReport] = useState<LiveReport | null>(null)
  const [loadError, setLoadError] = useState('')
  const [savingSettings, setSavingSettings] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const [openOrder, setOpenOrder] = useState<string | null>(null)
  const [orderView, setOrderView] = useState<AttributedOrderView | null>(null)
  const [orderError, setOrderError] = useState('')
  const [retentionDraft, setRetentionDraft] = useState('')

  // The range is read off its three parts rather than the object it arrives in:
  // the parent builds that object fresh on every render, so depending on it
  // would restart the poll below on every keystroke somewhere else on the tab.
  const { range, from, to } = query

  const load = useCallback(async (span: RangeQuery, signal?: AbortSignal) => {
    try {
      const next = await fetchLiveReport(span, signal)
      if (signal?.aborted) return
      setReport(next)
      setLoadError('')
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) return
      setLoadError(messageOf(error, "Could not load this site's own figures"))
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch per range; every setState in load() runs after an await
    void load({ range, from, to }, controller.signal)
    return () => controller.abort()
  }, [load, range, from, to])

  // Polling stops while the tab is hidden and catches up the moment it comes
  // back, so a workbench left open in a background tab is not quietly asking
  // the database a question every twenty seconds all week.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null
    const tick = () => void load({ range, from, to })
    const start = () => { if (timer === null) timer = setInterval(tick, POLL_INTERVAL_MS) }
    const stop = () => { if (timer !== null) { clearInterval(timer); timer = null } }
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') {
        tick()
        start()
      } else {
        stop()
      }
    }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [load, range, from, to])

  const saveSettings = useCallback(async (patch: TrackingSettingsPatch) => {
    setSavingSettings(true)
    setSettingsError('')
    try {
      setReport(await saveTrackingSettings(patch))
    } catch (error) {
      setSettingsError(messageOf(error, 'Could not save that'))
    } finally {
      setSavingSettings(false)
    }
  }, [])

  const openSale = useCallback(async (orderId: string) => {
    if (openOrder === orderId) {
      setOpenOrder(null)
      setOrderView(null)
      return
    }
    setOpenOrder(orderId)
    setOrderView(null)
    setOrderError('')
    try {
      setOrderView(await fetchAttributedOrder(orderId))
    } catch (error) {
      setOrderError(messageOf(error, 'Could not load that sale'))
    }
  }, [openOrder])

  const totals = report?.totals
  const settings = report?.settings

  return (
    <section className="gsl-panel" aria-label="This site's own figures">
      <div className="gsr-head">
        <h3 className="gsr-panel-title">What this site counted</h3>
        <span className="gsl-source">Updated every 20 seconds</span>
      </div>

      <p className="gsl-banner">
        These are <strong>this site&apos;s own</strong> figures, counted here as people arrive - not Google&apos;s. The two will not
        match, and neither is wrong: Google counts a click the moment it hands somebody over, while this counts a landing once the
        page has actually opened in their browser. A visitor who changes their mind on the way, blocks scripts, or never finishes
        loading is a click to Google and nothing at all here. Expect this column to read a little lower.
      </p>

      {loadError !== '' && <p className="gsw-message is-error">{loadError}</p>}
      {settingsError !== '' && <p className="gsw-message is-error">{settingsError}</p>}

      {settings && !settings.trackingEnabled && (
        <p className="gsw-message is-info">
          Counting visits is switched off, so nothing new is being recorded. Anything below is what was counted while it was on.
        </p>
      )}
      {settings?.cloudflareMismatch && (
        <p className="gsw-message is-error">
          This site is served through Cloudflare, but Cactus has not been told so - and while that is the case these counts will
          be badly wrong, not slightly. Everyone arriving through the same Cloudflare location looks like one person here, so
          visits are merged together and most of them are never counted at all. Switch <strong>My traffic goes through
          Cloudflare</strong> on in Settings, General, Speed and the figures from then on will be right.
        </p>
      )}
      {settings?.keyMissing && (
        <p className="gsw-message is-error">
          This site has no security key set, and without one there is no honest way to tell two visitors apart - so nothing is
          being counted at all. Your host will know what to do about that.
        </p>
      )}
      {settings?.trackingEnabled && !settings.linkTaggingEnabled && (
        <p className="gsr-panel-note">
          Free listings are not being tagged, so a visit from one of them looks exactly like somebody typing your address in.
          Until you switch tagging on below, only paid clicks - which Google labels itself - are counted here.
        </p>
      )}

      {report && totals && (
        <>
          <div className="gsr-columns">
            <SourceColumn title="Free listings" source="free" totals={totals.free} currency={report.currency} />
            <SourceColumn title="Paid ads" source="paid" totals={totals.paid} currency={report.currency} />
          </div>
          <p className="gsr-panel-note">
            {report.range.from === report.range.to
              ? `Counted on ${report.range.from}. `
              : `Counted between ${report.range.from} and ${report.range.to}. `}
            {totals.all.attributable === 0
              ? 'None of these visitors agreed to marketing cookies, so none of them could be joined to a sale. Landings are counted for everyone; sales are only ever joined for people who said yes.'
              : `${plural(totals.all.attributable, 'of these visitors')} agreed to marketing cookies, which is the only way a sale can be traced back to the visit. The sale rate is worked out over those, not over every landing - the rest were never able to count.`}
          </p>
        </>
      )}

      {/* --- The live feed ------------------------------------------------ */}
      {report && (
        <div>
          <h4 className="gsr-panel-title">Who has just arrived</h4>
          {report.recent.length === 0 ? (
            <div className="gsr-empty">
              <strong>Nothing counted in these dates</strong>
              {report.firstLandingAt
                ? `The first visit counted here was on ${formatDateTime(report.firstLandingAt)}. Try a wider range.`
                : 'Nothing has been counted yet. That is not the same as nobody having visited.'}
            </div>
          ) : (
            <div className="gsl-feed">
              {report.recent.map((landing) => (
                <div key={landing.id}>
                  <div className="gsl-row">
                    <span className="gsl-when">{formatDateTime(landing.landedAt)}</span>
                    <span className={`gsl-dot is-${landing.source}`} aria-hidden="true" />
                    <span className="gsl-what">
                      {landing.productName}
                      {landing.variantName && <span className="gsl-variant">{landing.variantName}</span>}
                    </span>
                    <span className="gsl-badge">{landing.source === 'paid' ? 'Paid ad' : 'Free listing'}</span>
                    {landing.order ? (
                      <>
                        <span className={`gsl-badge ${landing.order.confirmedAt ? 'is-sold' : 'is-pending'}`}>
                          {landing.order.confirmedAt
                            ? `Bought ${landing.order.value === null ? '' : formatMoney(landing.order.value, landing.order.currency ?? report.currency)}`.trim()
                            : 'Bought, payment not settled'}
                        </span>
                        <button
                          type="button"
                          className="gsl-open"
                          aria-expanded={openOrder === landing.order.orderId}
                          onClick={() => void openSale(landing.order?.orderId ?? '')}
                        >
                          {landing.order.orderNumber}
                        </button>
                      </>
                    ) : (
                      <span className="gsl-badge">{landing.consented ? 'No sale yet' : 'Cannot be traced'}</span>
                    )}
                  </div>
                  {landing.order && openOrder === landing.order.orderId && (
                    orderError !== ''
                      ? <p className="gsw-message is-error">{orderError}</p>
                      : orderView
                        ? <OrderDetail view={orderView} orderHref={`/${adminPath}/shop/orders/${orderView.orderId}`} />
                        : <p className="gsr-panel-note">Fetching that sale...</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* --- Settings ------------------------------------------------------ */}
      {settings && (
        <div className="gsr-settings">
          <h4 className="gsr-panel-title">Settings</h4>
          <div className="gsr-setting">
            <label>
              <input
                type="checkbox"
                checked={settings.linkTaggingEnabled}
                disabled={savingSettings}
                onChange={(event) => void saveSettings({ linkTaggingEnabled: event.target.checked })}
              />{' '}
              Label the links you send to Google
            </label>
            <p className="gsr-setting-note">
              Adds a marker to the address of every product Google lists, so a visit from a free listing can be told apart from
              anyone else arriving at the same page. It is the only way free listings can be counted at all. Anything else
              measuring this site will see the marker too.
            </p>
          </div>
          <div className="gsr-setting">
            <label>
              <input
                type="checkbox"
                checked={settings.trackingEnabled}
                disabled={savingSettings}
                onChange={(event) => void saveSettings({ trackingEnabled: event.target.checked })}
              />{' '}
              Count visits from Google
            </label>
            <p className="gsr-setting-note">
              Records which product somebody landed on and whether they came from a free listing or a paid one. Nobody is
              identified: a visit is only ever joined to an order for someone who has agreed to marketing cookies, and everyone
              else is counted with nothing attached to them.
            </p>
            <p className="gsr-setting-note">
              <strong>If your site sits behind Cloudflare</strong>, switch <strong>My traffic goes through Cloudflare</strong> on
              in Settings, General, Speed before you rely on anything here. Without it every visitor arriving through the same
              Cloudflare location looks like the same person, so visits are merged and the counts come out far too low with
              nothing on this screen to say why.
            </p>
          </div>
          <div className="gsr-setting">
            <label htmlFor="gsl-retention">Keep the figures for</label>
            <input
              id="gsl-retention"
              type="number"
              min={0}
              max={3650}
              value={retentionDraft === '' ? String(settings.retentionDays) : retentionDraft}
              disabled={savingSettings}
              onChange={(event) => setRetentionDraft(event.target.value)}
              onBlur={() => {
                if (retentionDraft === '') return
                const days = Number(retentionDraft)
                setRetentionDraft('')
                if (Number.isFinite(days) && days !== settings.retentionDays) void saveSettings({ retentionDays: Math.round(days) })
              }}
            />
            <span>days</span>
            <p className="gsr-setting-note">
              400 days is thirteen months, so last year&apos;s same month is still there to compare with. 0 keeps everything.
              Old visits are cleared out by the daily check, not the moment you change this - so a slip of the finger can be put
              right before anything goes.
            </p>
          </div>
        </div>
      )}
    </section>
  )
}
