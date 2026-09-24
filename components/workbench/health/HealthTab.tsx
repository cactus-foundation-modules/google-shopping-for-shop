'use client'

// The workbench's Health sub-tab: what Google is unhappy about, and whether it
// managed to read the feed at all.
//
// Two very different questions on one screen, on purpose. Everything else in
// this module reports on what WE would send Google; this is the only place
// that reports what Google did with it. A feed that has quietly stopped being
// fetched looks perfect from every other screen right up until the orders stop.
//
// Nothing here calls Google on load - the figures are what the daily check
// recorded. The two buttons are the only things that pick up the telephone,
// and each says which of the two calls it is making.
import { useCallback, useEffect, useState } from 'react'
import { workbenchCss } from '@/modules/google-shopping-for-shop/components/workbench/workbench-css'
import { healthCss } from '@/modules/google-shopping-for-shop/components/workbench/health/health-css'
import { formatCount, formatDateTime, plural } from '@/modules/google-shopping-for-shop/components/workbench/format'
import {
  checkFeedFetch,
  explainItem,
  fetchHealth,
  refreshItemIssues,
  type ExplainOutcome,
  type FeedCheckResult,
  type HealthQueryParams,
  type HealthReport,
} from '@/modules/google-shopping-for-shop/components/workbench/health/api'
import { LiveUpdatesPanel } from '@/modules/google-shopping-for-shop/components/workbench/health/LiveUpdatesPanel'
import { AdsPanel } from '@/modules/google-shopping-for-shop/components/workbench/health/AdsPanel'
import {
  FETCH_STATE_LABELS,
  FETCH_UNAVAILABLE_COPY,
  SEVERITY_LABELS,
  attributeLabel,
  issueCodeLabel,
  type IssueSeverity,
} from '@/modules/google-shopping-for-shop/lib/health/types'

type Props = {
  /** Opens the Products tab narrowed to the items one of Google's codes is
   *  open against, where the title, price and template all sit together. */
  onShowProducts: (code: string) => void
}

type Notice = { tone: 'ok' | 'error' | 'info'; text: string }

const PER_PAGE = 50

const SEVERITY_TONE: Record<IssueSeverity, string> = {
  disapproved: 'badge-error',
  demoted: 'badge-warning',
  pending: 'badge-info',
  unknown: 'badge-default',
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/** Google's product_view report gives an item issue a code and a field and
 *  nothing else, so this is everything the DAILY check knows about one.
 *
 *  Google's fuller wording - description, detail, documentation link - lives
 *  on accounts.products (ProductStatus.itemLevelIssues), one API call per
 *  product. Far too many to make for a catalogue on a schedule, which is why
 *  "Explain this" fetches it for one item at a time, when asked. */
function reasonText(issue: { code: string; attribute: string }): string {
  const field = attributeLabel(issue.attribute)
  return field ? `${issueCodeLabel(issue.code)} (${field})` : issueCodeLabel(issue.code)
}

/**
 * What Google said about one item, once asked.
 *
 * Three outcomes, three different things to draw, and none of them is a blank
 * box or a spinner nobody takes down:
 *   ok         Google's own words, per issue, with its help link.
 *   no-words   Google answered and had nothing to add. Said plainly - the one
 *              thing we must never do here is invent an explanation.
 *   unavailable  we could not find out, and why, in the route's own English.
 */
function ExplainPanel({ outcome, busy, onRefresh }: { outcome: ExplainOutcome | undefined; busy: boolean; onRefresh: () => void }) {
  // Nothing asked for yet: the button itself says it is working, so there is
  // nothing to draw here.
  if (!outcome) return null

  // Asking AGAIN. The old answer stays put, dimmed, rather than vanishing and
  // reappearing - the words are almost always the same ones, and a panel that
  // blinks out draws far more attention than the change deserves.
  if (busy) {
    return (
      <div className="gsh-explain is-asking" aria-busy>
        <span className="gsh-explain-head">Asking Google again…</span>
        {outcome.status === 'ok'
          ? outcome.issues.map((issue) => (
            <span key={`${issue.code}-${issue.attribute}`} className="gsh-explain-issue">
              <span className="gsh-explain-code">{issueCodeLabel(issue.code)}</span>
              {issue.description && <span className="gsh-explain-text">{issue.description}</span>}
            </span>
          ))
          : <span className="gsh-explain-text">{outcome.message}</span>}
      </div>
    )
  }

  if (outcome.status === 'unavailable') {
    // Not everything in here is a failure. "Nothing to explain" is a correct
    // refusal and "asked a moment ago" is the brake working, so neither gets
    // a heading that reads like something went wrong.
    const correct = outcome.reason === 'nothing-to-explain' || outcome.reason === 'just-asked'
    const heading = outcome.reason === 'nothing-to-explain'
      ? 'Nothing to explain'
      : outcome.reason === 'just-asked'
        ? 'Just asked'
        : 'Google could not be asked'
    return (
      <div className={`gsh-explain ${correct ? 'is-quiet' : 'is-bad'}`}>
        <span className="gsh-explain-head">{heading}</span>
        <span className="gsh-explain-text">{outcome.message}</span>
      </div>
    )
  }

  if (outcome.status === 'no-words') {
    return (
      <div className="gsh-explain is-quiet">
        <span className="gsh-explain-head">Nothing further from Google</span>
        <span className="gsh-explain-text">{outcome.message}</span>
      </div>
    )
  }

  return (
    <div className="gsh-explain">
      <span className="gsh-explain-head">In Google&apos;s own words</span>
      {outcome.issues.map((issue) => (
        <span key={`${issue.code}-${issue.attribute}`} className="gsh-explain-issue">
          <span className="gsh-explain-code">
            {issueCodeLabel(issue.code)}
            {attributeLabel(issue.attribute) && <span className="gsw-muted"> · {attributeLabel(issue.attribute)}</span>}
          </span>
          {issue.description && <span className="gsh-explain-text">{issue.description}</span>}
          {/* Google's longer sentence, and usually the one saying what to do.
              Left out when it merely repeats the short one. */}
          {issue.detail && issue.detail !== issue.description && <span className="gsh-explain-detail">{issue.detail}</span>}
          {issue.documentationUrl && (
            <span className="gsh-explain-detail">
              <a href={issue.documentationUrl} target="_blank" rel="noreferrer">What Google says about this</a>
            </span>
          )}
        </span>
      ))}
      <span className="gsh-explain-foot">
        <span>
          {outcome.fromCache ? 'Asked' : 'Asked just now,'} {formatDateTime(outcome.checkedAt)}
        </span>
        <button type="button" className="gsw-linkish" onClick={onRefresh}>Ask Google again</button>
      </span>
    </div>
  )
}

export function HealthTab({ onShowProducts }: Props) {
  const [report, setReport] = useState<HealthReport | null>(null)
  const [loadError, setLoadError] = useState('')
  const [query, setQuery] = useState<HealthQueryParams>({ page: 1, perPage: PER_PAGE, code: '', severity: '' })
  const [busy, setBusy] = useState<'items' | 'feed' | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  // Google's words per item, and which item is mid-call. Keyed by item id so
  // several rows can be open at once and each knows its own state; the
  // in-flight id is what disables that row's button, so a double press cannot
  // become two Merchant API calls.
  const [explained, setExplained] = useState<Record<string, ExplainOutcome>>({})
  const [explaining, setExplaining] = useState<string | null>(null)

  const load = useCallback(async (next: HealthQueryParams) => {
    try {
      setReport(await fetchHealth(next))
      setLoadError('')
    } catch (error) {
      setLoadError(messageOf(error, 'Could not load the health figures'))
    }
  }, [])

  // Fetches on mount and whenever the filters or the page move. No disable
  // needed: every setState inside load() runs after an await, so none of them
  // happens during the effect itself.
  useEffect(() => {
    void load(query)
  }, [load, query])

  const narrow = (patch: Partial<HealthQueryParams>) => setQuery((held) => ({ ...held, page: 1, ...patch }))

  async function runItemRefresh() {
    setBusy('items')
    setNotice(null)
    try {
      const result = await refreshItemIssues()
      // An empty answer is not an all clear. Google returns no rows at all
      // while an account is reprocessing after a feed change, so nothing was
      // changed and nothing below has moved.
      const turnedDown = result.disapprovedItems ?? 0
      setNotice(result.issuesSkipped
        ? {
          tone: 'info',
          text: 'Google had nothing to say about your products just now, which usually means it is still working through a recent '
            + 'change. Nothing below has been altered. Try again in a little while.',
        }
        : {
          tone: turnedDown > 0 ? 'info' : 'ok',
          text: turnedDown > 0
            ? `Google reported on ${plural(result.products, 'item')} and is turning ${formatCount(turnedDown)} of them down.`
            : `Google reported on ${plural(result.products, 'item')} and is not turning any of them down.`,
        })
      await load(query)
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not refresh what Google says about your items') })
    } finally {
      setBusy(null)
    }
  }

  async function runFeedCheck() {
    setBusy('feed')
    setNotice(null)
    try {
      const result: FeedCheckResult = await checkFeedFetch()
      setNotice(result.status === 'ok'
        ? {
          tone: result.fetch.state === 'failed' ? 'error' : 'ok',
          text: `Google's last read of your feed: ${FETCH_STATE_LABELS[result.fetch.state].toLowerCase()}.`,
        }
        : { tone: 'error', text: result.message })
      await load(query)
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not check the feed with Google') })
    } finally {
      setBusy(null)
    }
  }

  async function runExplain(itemId: string, force = false) {
    // One call at a time across the whole list. The button is disabled while
    // this is set, so this guard is belt and braces against a double event.
    if (explaining !== null) return
    setExplaining(itemId)
    try {
      const outcome = await explainItem(itemId, force)
      setExplained((held) => ({ ...held, [itemId]: outcome }))
    } catch (error) {
      // Never leave the spinner up. A thrown error is the route failing
      // rather than Google refusing, and it gets the same plain treatment.
      setExplained((held) => ({
        ...held,
        [itemId]: { status: 'unavailable', reason: 'error', message: messageOf(error, 'Could not ask Google about that item') },
      }))
    } finally {
      setExplaining(null)
    }
  }

  const totals = report?.totals
  const feed = report?.feed
  const filtered = query.code !== '' || query.severity !== ''

  return (
    <div className="gsh">
      <style>{workbenchCss}{healthCss}</style>

      <div className="gsh-head">
        <div>
          <h2 className="gsw-title">Health</h2>
          <p className="gsw-lede">
            What Google makes of your products, and whether it managed to read your feed. Checked once a day on its own; the buttons
            here ask again now.
          </p>
        </div>
        <div className="gsh-actions">
          <button type="button" className="btn btn-sm" disabled={busy !== null || !report?.can.refresh} onClick={() => void runItemRefresh()}>
            {busy === 'items' ? 'Asking Google…' : 'Check my products'}
          </button>
          <button type="button" className="btn btn-sm" disabled={busy !== null || !report?.can.refresh} onClick={() => void runFeedCheck()}>
            {busy === 'feed' ? 'Asking Google…' : 'Check the feed'}
          </button>
        </div>
      </div>

      {report && !report.can.refresh && (
        <p className="gsw-message is-info">
          {report.can.credentials
            ? 'Fill in your Merchant Center account number on the Google Shopping settings tab and these checks can run.'
            : 'Save a Google service-account key on the Google Shopping settings tab and these checks can run.'}
        </p>
      )}

      {notice && <p className={`gsw-message is-${notice.tone}`}>{notice.text}</p>}
      {loadError !== '' && <p className="gsw-message is-error">{loadError}</p>}

      {/* --- What Google is unhappy about --------------------------------- */}
      {totals && (
        <div className="gsw-tiles">
          {([
            ['Products with a problem', totals.itemsAffected, 'any', totals.itemsAffected > 0 ? 'warn' : 'good'],
            ['Turned down', totals.itemsBySeverity.disapproved, 'disapproved', totals.itemsBySeverity.disapproved > 0 ? 'bad' : undefined],
            ['Shown less often', totals.itemsBySeverity.demoted, 'demoted', totals.itemsBySeverity.demoted > 0 ? 'warn' : undefined],
            ['Still being checked', totals.itemsBySeverity.pending, 'pending', undefined],
          ] as const).map(([label, value, severity, tone]) => {
            const active = severity === 'any' ? query.severity === '' && query.code === '' : query.severity === severity
            return (
              <button
                key={label}
                type="button"
                className={`gsw-tile${active ? ' is-active' : ''}`}
                aria-pressed={active}
                onClick={() => narrow(severity === 'any'
                  ? { severity: '', code: '' }
                  : { severity: query.severity === severity ? '' : severity })}
              >
                <span className="gsw-tile-label">{label}</span>
                <span className={`gsw-tile-value${tone ? ` is-${tone}` : ''}`}>{formatCount(value)}</span>
              </button>
            )
          })}
        </div>
      )}

      {report && (
        <p className="gsw-status">
          {report.checkedAt
            ? <>Last asked Google about your products <strong>{formatDateTime(report.checkedAt)}</strong>. {plural(totals?.openTotal ?? 0, 'open problem')} across {plural(totals?.itemsAffected ?? 0, 'product')}.</>
            // Never "all clear" from an empty table: nobody has asked.
            : <>Google has not been asked about your products yet, so there is nothing to show. That is not the same as nothing being wrong.</>}
        </p>
      )}

      {/* --- The feed fetch panel ----------------------------------------- */}
      <section className={`gsh-panel${feed?.status?.state === 'failed' ? ' is-bad' : ''}`} aria-label="Google's last read of your feed">
        <h3 className="gsh-panel-title">Google&apos;s last read of your feed</h3>
        {!feed?.status && (
          <p className="gsh-panel-note">
            {report?.can.refresh
              ? 'Not checked yet. Press "Check the feed" and Cactus will find your feed at Google and ask how the last read went.'
              : FETCH_UNAVAILABLE_COPY[report?.can.credentials ? 'no-merchant-id' : 'no-credentials']}
          </p>
        )}
        {feed?.status && (
          <>
            <div className="gsh-facts">
              <span>State <strong>{FETCH_STATE_LABELS[feed.status.state]}</strong></span>
              <span>
                Read by Google{' '}
                <strong>{feed.status.uploadedAt ? formatDateTime(feed.status.uploadedAt) : 'never'}</strong>
              </span>
              <span>We asked <strong>{formatDateTime(feed.status.checkedAt)}</strong></span>
            </div>
            <div className="gsh-facts">
              {/* Null is "Google did not say", which is not zero. */}
              <span>Items taken <strong>{feed.status.itemsTotal === null ? 'not said' : formatCount(feed.status.itemsTotal)}</strong></span>
              <span>New <strong>{feed.status.itemsCreated === null ? 'not said' : formatCount(feed.status.itemsCreated)}</strong></span>
              <span>Updated <strong>{feed.status.itemsUpdated === null ? 'not said' : formatCount(feed.status.itemsUpdated)}</strong></span>
            </div>
            <div className="gsh-facts">
              <span>
                Google&apos;s feed{' '}
                <strong>{feed.status.displayName || feed.dataSourceId}</strong>
                {feed.origin === 'setting' ? ' (you chose this one)' : ' (found by matching your feed address)'}
              </span>
            </div>
            {feed.status.fetchUri && (
              <div className="gsh-facts"><span>Address Google reads <code>{feed.status.fetchUri}</code></span></div>
            )}
            {feed.status.issues.length > 0 && (
              <ul className="gsh-issues">
                {feed.status.issues.map((issue) => (
                  <li key={`${issue.code}-${issue.title}`} className="gsh-issue">
                    <span className="gsh-issue-title">
                      <span className={`badge ${issue.severity === 'error' ? 'badge-error' : 'badge-warning'}`}>
                        {issue.severity === 'error' ? 'Error' : 'Warning'}
                      </span>{' '}
                      {issue.title}
                      {issue.count > 0 && <> - {plural(issue.count, 'item')}</>}
                    </span>
                    {issue.description && <span className="gsh-issue-detail">{issue.description}</span>}
                    {issue.documentationUri && (
                      <span className="gsh-issue-detail">
                        <a href={issue.documentationUri} target="_blank" rel="noreferrer">What Google says about this</a>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {/* --- Live price and stock updates --------------------------------- */}
      {/* Its own component: this tab is already two screens in one, and the
          live updates are a third question with their own buttons, their own
          failure modes and their own alert. */}
      <LiveUpdatesPanel />

      {/* Google Ads: a different account, a different sign-in, its own panel. */}
      <AdsPanel />

      {/* --- The worst reasons -------------------------------------------- */}
      {report && report.topCodes.length > 0 && (
        <section className="gsh-panel" aria-label="What Google is unhappy about">
          <h3 className="gsh-panel-title">What Google is unhappy about</h3>
          <p className="gsh-panel-note">
            Google&apos;s daily report gives a reason and the field it is about, and no more than that. Merchant Center spells each
            one out in full, and every product below links straight to its page there.
          </p>
          <ul className="gsh-codes">
            {report.topCodes.map((code) => (
              <li key={code.code} className={`gsh-code${query.code === code.code ? ' is-active' : ''}`}>
                <span className="gsh-code-name">
                  <span className={`badge ${SEVERITY_TONE[code.severity]}`}>{SEVERITY_LABELS[code.severity]}</span>{' '}
                  {issueCodeLabel(code.code)}
                  {attributeLabel(code.attribute) && <span className="gsw-muted"> · {attributeLabel(code.attribute)}</span>}
                  <span className="gsw-muted gsw-small"> · since {formatDateTime(code.since)}</span>
                </span>
                <span className="gsh-code-count">{formatCount(code.items)}</span>
                <span className="gsh-code-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => narrow({ code: query.code === code.code ? '' : code.code })}
                  >
                    {query.code === code.code ? 'Show all' : 'List them'}
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onShowProducts(code.code)}>
                    Open in Products
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* --- The items themselves ------------------------------------------ */}
      {report && (
        <div className="gsw-card">
          <div className="gsw-card-head">
            <strong>
              {filtered ? 'Matching products' : 'Products with a problem'}
              <span className="gsw-muted"> · {formatCount(report.items.total)}</span>
            </strong>
            {filtered && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => narrow({ code: '', severity: '' })}>Clear filters</button>
            )}
          </div>

          {report.items.rows.length === 0 && (
            <div className="gsh-empty">
              <strong>{report.checkedAt ? 'Nothing to report' : 'Nothing asked for yet'}</strong>
              {report.checkedAt
                ? filtered ? 'No product matches that filter.' : 'Google has not raised anything against your products.'
                : 'Press "Check my products" and Google will be asked.'}
            </div>
          )}

          {report.items.rows.map((item) => (
            <div key={item.itemId} className="gsh-item">
              <span className="gsh-item-title">
                <span className={`badge ${SEVERITY_TONE[item.worstSeverity]}`}>{SEVERITY_LABELS[item.worstSeverity]}</span>{' '}
                {item.title || 'A product Google has not named'}
              </span>
              <span className="gsh-item-id">{item.itemId}</span>
              <span className="gsh-item-reasons">
                {item.issues.map((issue) => (
                  <span key={`${issue.code}-${issue.attribute}`} className="badge badge-default" title={`Google's own code: ${issue.code}`}>
                    {reasonText(issue)}
                  </span>
                ))}
              </span>
              <span className="gsh-item-links">
                <span className="gsw-muted gsw-small">Since {formatDateTime(item.since)}</span>
                {item.merchantCentreUrl && <a href={item.merchantCentreUrl} target="_blank" rel="noreferrer">Open in Merchant Center</a>}
              </span>
              <span className="gsh-item-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  // Disabled for every row while any call is in flight: this
                  // is one Merchant API request per press, and the account's
                  // quota is shared with the daily check.
                  disabled={explaining !== null}
                  aria-busy={explaining === item.itemId}
                  onClick={() => void runExplain(item.itemId)}
                >
                  {explaining === item.itemId ? 'Asking Google…' : explained[item.itemId] ? 'Explain this again' : 'Explain this'}
                </button>
                {explaining === item.itemId && <span className="gsw-spinner" role="status" aria-label="Asking Google" />}
              </span>
              <ExplainPanel
                outcome={explained[item.itemId]}
                busy={explaining === item.itemId}
                onRefresh={() => void runExplain(item.itemId, true)}
              />
            </div>
          ))}

          {report.items.pageCount > 1 && (
            <div className="gsw-pager">
              <span className="gsw-muted gsw-small">Page {report.items.page} of {report.items.pageCount}</span>
              <span className="gsw-pager-controls">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={report.items.page <= 1}
                  onClick={() => setQuery((held) => ({ ...held, page: Math.max(1, held.page - 1) }))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={report.items.page >= report.items.pageCount}
                  onClick={() => setQuery((held) => ({ ...held, page: held.page + 1 }))}
                >
                  Next
                </button>
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
