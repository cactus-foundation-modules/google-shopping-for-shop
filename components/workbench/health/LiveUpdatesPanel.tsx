'use client'

// The Health tab's live price and stock panel.
//
// The one screen in this module that reports on something the site does to
// Google unprompted, so it is written to be readable when it is going wrong:
// every state says what it is, none of them says "done" unless the run actually
// finished, and "we could not find out" never borrows the words for "all well".
//
// Nothing here calls Google on load. The three buttons are the only things that
// pick up the telephone, and each says which call it is making.
import { useCallback, useEffect, useState } from 'react'
import { formatCount, formatDateTime, formatMoney, plural } from '@/modules/google-shopping-for-shop/components/workbench/format'
import { ChangeHistory } from '@/modules/google-shopping-for-shop/components/workbench/feed-rules/ChangeHistory'
import { fetchLog, undoLogEntry, type LogEntry } from '@/modules/google-shopping-for-shop/components/workbench/feed-rules/api'
import {
  checkLiveUpdatesSetup,
  fetchLiveUpdates,
  runLiveUpdatesNow,
  runLiveUpdatesSetup,
  setLiveUpdates,
  unlinkLiveUpdates,
  type LiveUpdatesView,
  type SetupPlan,
} from '@/modules/google-shopping-for-shop/components/workbench/health/push-api'
import { GOOGLE_AVAILABILITY, type GoogleAvailability, type PushSnapshot } from '@/modules/google-shopping-for-shop/lib/push/types'

type Notice = { tone: 'ok' | 'error' | 'info'; text: string }
type Busy = 'check' | 'setup' | 'unlink' | 'send' | 'switch' | null

/** The change log area this panel writes to, and the only one it lists. */
const LOG_AREAS = ['live-updates']

/** Google's enum in the words a shop owner uses. */
const AVAILABILITY_LABELS: Record<GoogleAvailability, string> = {
  IN_STOCK: 'In stock',
  OUT_OF_STOCK: 'Out of stock',
  PREORDER: 'Pre-order',
  BACKORDER: 'On backorder',
}

function availabilityLabel(value: string): string {
  return (GOOGLE_AVAILABILITY as readonly string[]).includes(value)
    ? AVAILABILITY_LABELS[value as GoogleAvailability]
    : value
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/** One price and availability, in one line. */
function SnapshotLine({ snapshot }: { snapshot: PushSnapshot }) {
  return (
    <>
      {formatMoney(snapshot.price, snapshot.currency)}
      {snapshot.salePrice !== undefined && <> (on offer at {formatMoney(snapshot.salePrice, snapshot.currency)})</>}
      {' · '}
      {availabilityLabel(snapshot.availability)}
    </>
  )
}

/** What the last run came to, said plainly.
 *
 *  The one thing this must never do is read "done" for a run that started and
 *  never came back. A stalled run and a finished one look identical from a
 *  count of items sent, and only the stamps can tell them apart. */
function LastRunLine({ view }: { view: LiveUpdatesView }) {
  const run = view.lastRun
  if (run.running) return <>A send is under way now.</>
  if (run.stalled) {
    return (
      <>
        A send started {run.startedAt ? formatDateTime(run.startedAt) : 'a while ago'} and never came back. Nothing here knows how far it
        got - the next run will pick up whatever is still waiting.
      </>
    )
  }
  if (!run.finishedAt) return <>Nothing has been sent yet.</>
  const words = run.status === 'ok'
    ? 'went through'
    : run.status === 'part' ? 'went through in part' : 'did not go through'
  return (
    <>
      Last send {words}, {formatDateTime(run.finishedAt)}: {plural(run.sent, 'product')} sent
      {run.removed > 0 && <>, {plural(run.removed, 'product')} taken back out</>}
      {run.failed > 0 && <>, {formatCount(run.failed)} refused</>}.
      {run.lastError && <> Google said: {run.lastError}</>}
    </>
  )
}

export function LiveUpdatesPanel() {
  const [view, setView] = useState<LiveUpdatesView | null>(null)
  const [plan, setPlan] = useState<SetupPlan | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [loadError, setLoadError] = useState('')
  const [log, setLog] = useState<LogEntry[] | null>(null)
  const [logError, setLogError] = useState('')
  const [undoingId, setUndoingId] = useState<string | null>(null)

  const loadLog = useCallback(async () => {
    try {
      setLog(await fetchLog(LOG_AREAS))
      setLogError('')
    } catch (error) {
      setLogError(messageOf(error, 'Could not load recent changes'))
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- first fetch on mount; every setState in loadLog runs after an await
    void loadLog()
  }, [loadLog])

  const undo = useCallback(async (entry: LogEntry) => {
    setUndoingId(entry.id)
    setNotice(null)
    try {
      const result = await undoLogEntry(entry.id)
      // The handler's own sentence where it has one: on a skip it is the only
      // place the reason exists, and a generic line in its place would throw
      // away the one useful thing the undo worked out.
      if (result.status === 'undone') {
        setNotice({
          tone: result.restored > 0 ? 'ok' : 'info',
          text: result.message ?? (result.restored > 0 ? 'Put back.' : 'Nothing was put back.'),
        })
        setView(await fetchLiveUpdates())
      } else {
        setNotice({ tone: 'info', text: 'That change cannot be undone from here.' })
      }
      await loadLog()
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not undo that change') })
    } finally {
      setUndoingId(null)
    }
  }, [loadLog])

  useEffect(() => {
    const controller = new AbortController()
    fetchLiveUpdates(controller.signal)
      .then(setView)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setLoadError(messageOf(error, 'Could not read the live update figures'))
      })
    return () => controller.abort()
  }, [])

  const check = useCallback(async () => {
    setBusy('check')
    setNotice(null)
    try {
      const next = await checkLiveUpdatesSetup()
      setPlan(next)
      if (next.blockers.length > 0) setNotice({ tone: 'info', text: next.blockers[0] ?? '' })
      else if (next.behind) {
        setNotice({
          tone: 'error',
          text: 'Your main feed is connected to this site but reads its own prices first, so nothing sent from here is reaching a '
            + 'shopper. Press "Put it back in front" to fix it.',
        })
      } else if (next.steps.length === 0) {
        setNotice({ tone: 'ok', text: 'Merchant Center is set up and taking prices from this site, ahead of the feed itself.' })
      }
      // The panel's own "connected" is a stored value; what Check just learned
      // is the live answer, so it wins until the next reload.
      setView(await fetchLiveUpdates().catch(() => view))
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not ask Merchant Center what it holds') })
    } finally {
      setBusy(null)
    }
  }, [view])

  const setUp = useCallback(async () => {
    setBusy('setup')
    setNotice(null)
    try {
      const { outcome, liveUpdates } = await runLiveUpdatesSetup()
      setView(liveUpdates)
      if (outcome.status === 'ready') {
        setPlan(null)
        setNotice(outcome.confirmed
          ? { tone: 'ok', text: 'Merchant Center is set up. Switch the updates on below and your prices start going straight over.' }
          : { tone: 'info', text: 'It was sent, but Google’s reply could not be read back. Press Check to see what is there now.' })
      } else {
        setNotice({ tone: outcome.status === 'blocked' ? 'info' : 'error', text: outcome.message })
      }
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not set the live updates up') })
    } finally {
      setBusy(null)
      void loadLog()
    }
  }, [loadLog])

  const unlink = useCallback(async () => {
    setBusy('unlink')
    setNotice(null)
    try {
      const { outcome, liveUpdates } = await unlinkLiveUpdates()
      setView(liveUpdates)
      setPlan(null)
      setNotice(outcome.status === 'ready'
        ? { tone: 'ok', text: 'Your main feed is no longer taking prices from this site. The extra feed is still there, so this can be switched back on at any time.' }
        : { tone: outcome.status === 'blocked' ? 'info' : 'error', text: outcome.message })
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not unlink the live updates') })
    } finally {
      setBusy(null)
      void loadLog()
    }
  }, [loadLog])

  const send = useCallback(async (sweep: boolean) => {
    setBusy('send')
    setNotice(null)
    try {
      const { outcome, liveUpdates } = await runLiveUpdatesNow(sweep)
      setView(liveUpdates)
      if (outcome.status === 'skipped') {
        setNotice({ tone: 'info', text: outcome.message })
      } else {
        const { sent, removed, failed, unchanged, leftQueued } = outcome.summary
        const parts: string[] = []
        if (sent > 0) parts.push(`${plural(sent, 'product')} sent`)
        if (removed > 0) parts.push(`${plural(removed, 'product')} taken back out`)
        if (unchanged > 0) parts.push(`${formatCount(unchanged)} already up to date`)
        if (failed > 0) parts.push(`${formatCount(failed)} refused`)
        if (leftQueued > 0) parts.push(`${formatCount(leftQueued)} still waiting for the next run`)
        setNotice({
          tone: failed > 0 ? 'error' : 'ok',
          text: parts.length > 0 ? `${parts.join(', ')}.` : 'Nothing needed sending.',
        })
      }
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not send your latest prices') })
    } finally {
      setBusy(null)
      void loadLog()
    }
  }, [loadLog])

  const toggle = useCallback(async (enabled: boolean) => {
    setBusy('switch')
    setNotice(null)
    try {
      setView(await setLiveUpdates({ enabled }))
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not change that') })
    } finally {
      setBusy(null)
    }
  }, [])

  if (loadError !== '') {
    return (
      <section className="gsh-panel is-bad" aria-label="Live price and stock updates">
        <h3 className="gsh-panel-title">Live price and stock updates</h3>
        <p className="gsh-panel-note">{loadError}</p>
      </section>
    )
  }
  if (!view) return null

  const missing = [
    view.ready.credentials ? null : 'a Google service-account key',
    view.ready.merchantId ? null : 'your Merchant Center account number',
    view.ready.feedLabel ? null : 'your feed label',
  ].filter((item): item is string => item !== null)

  const working = view.enabled && view.feedEnabled && view.setUp && view.linked
  const trouble = view.failed > 0 || view.differs > 0 || view.lastRun.stalled

  return (
    <section className={`gsh-panel${trouble ? ' is-bad' : working ? ' is-good' : ''}`} aria-label="Live price and stock updates">
      <h3 className="gsh-panel-title">Live price and stock updates</h3>
      <p className="gsh-panel-note">
        Google reads your feed on its own schedule, usually about once a day, and never at the moment you drop a price or sell the last
        one. With this on, a changed price or stock level goes straight over within a couple of minutes, and the rest of the listing -
        photos, description, delivery - carries on coming from the feed as before. A bulk edit of hundreds of products goes in batches,
        so the first few hundred are quick and the tail can take up to an hour.
      </p>

      {missing.length > 0 && (
        <p className="gsw-message is-info">
          Fill in {missing.join(', ')} on the Google Shopping settings tab, and this can be set up.
        </p>
      )}

      {!view.feedEnabled && (
        <p className="gsw-message is-info">
          Your Google Shopping feed is switched off, so there are no listings to keep up to date and nothing is being sent. Switch the
          feed back on and this picks up where it left off.
        </p>
      )}

      {notice && <p className={`gsw-message is-${notice.tone}`}>{notice.text}</p>}

      {/* --- Where we are ------------------------------------------------- */}
      <div className="gsh-facts">
        <span>
          Merchant Center{' '}
          <strong>
            {!view.setUp
              ? 'not set up'
              : view.linked ? 'set up and connected' : 'set up, but your main feed is not taking from it'}
          </strong>
        </span>
        <span>Sending <strong>{view.enabled ? 'on' : 'off'}</strong></span>
        <span>Waiting to go <strong>{formatCount(view.queued)}</strong></span>
        <span>Being kept up to date <strong>{formatCount(view.tracked)}</strong></span>
      </div>

      {view.setUp && !view.linked && (
        <p className="gsw-message is-info">
          The extra feed exists at Merchant Center but your main feed is not taking prices from it, so nothing sent would reach a
          shopper - and nothing is being sent while that is true. Press Set it up again to connect the two.
        </p>
      )}

      {view.linked && (
        <p className="gsh-panel-note gsw-small">
          &ldquo;Set up and connected&rdquo; is what was recorded when the connection was made, not a fresh answer from Google. If you
          have changed your feeds at Merchant Center since, press Check Merchant Center - that is the only thing here that asks.
        </p>
      )}

      <p className="gsw-status"><LastRunLine view={view} /></p>

      <p className="gsw-status">
        {view.lastCheck.checkedAt
          ? <>
            Last checked against Google {formatDateTime(view.lastCheck.checkedAt)}: {plural(view.lastCheck.checked, 'product')} looked at,{' '}
            {view.lastCheck.differs === 0
              ? 'all showing what this site sent'
              : `${formatCount(view.lastCheck.differs)} showing something different`}.
          </>
          // Never "all agree" from an empty table: nobody has looked.
          : <>Nothing has been checked against Google yet, which is not the same as everything agreeing.</>}
      </p>

      {view.unconfirmed > 0 && (
        <p className="gsw-message is-info">
          {plural(view.unconfirmed, 'product was', 'products were')} sent and Google&apos;s reply could not be read back, so nothing here
          can say for certain they arrived. The hourly check settles them.
        </p>
      )}

      {/* --- Buttons ------------------------------------------------------ */}
      <div className="gsh-actions">
        <button type="button" className="btn btn-sm" disabled={busy !== null || missing.length > 0} onClick={() => void check()}>
          {busy === 'check' ? 'Asking Google…' : 'Check Merchant Center'}
        </button>
        {(!view.linked || plan?.behind) && (
          <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null || missing.length > 0} onClick={() => void setUp()}>
            {busy === 'setup'
              ? 'Setting up…'
              // Different words for a different job: nothing needs creating, the
              // order needs putting back.
              : plan?.behind ? 'Put it back in front' : 'Set it up'}
          </button>
        )}
        {view.linked && (
          <>
            <button
              type="button"
              className={`btn btn-sm${view.enabled ? '' : ' btn-primary'}`}
              disabled={busy !== null}
              onClick={() => void toggle(!view.enabled)}
            >
              {busy === 'switch' ? 'Saving…' : view.enabled ? 'Stop sending' : 'Start sending'}
            </button>
            <button type="button" className="btn btn-sm" disabled={busy !== null || !view.enabled} onClick={() => void send(false)}>
              {busy === 'send' ? 'Sending…' : 'Send what is waiting'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void unlink()}>
              {busy === 'unlink' ? 'Unlinking…' : 'Disconnect from Merchant Center'}
            </button>
          </>
        )}
      </div>

      {/* --- What Check found --------------------------------------------- */}
      {plan && (plan.steps.length > 0 || plan.blockers.length > 0) && (
        <div className="gsh-issue">
          <span className="gsh-issue-title">
            {plan.blockers.length > 0 ? 'Not yet' : plan.behind ? 'Pressing "Put it back in front" would' : 'Pressing "Set it up" would'}
          </span>
          <ul className="gsh-issues">
            {(plan.blockers.length > 0 ? plan.blockers : plan.steps).map((line) => (
              <li key={line} className="gsh-issue-detail">{line}</li>
            ))}
          </ul>
          {plan.primary && (
            <span className="gsh-issue-detail">
              Your main feed at Merchant Center is <strong>{plan.primary.displayName || plan.primary.id}</strong>.
            </span>
          )}
        </div>
      )}

      {/* --- Refusals ------------------------------------------------------ */}
      {view.failures.length > 0 && (
        <>
          <p className="gsh-panel-note">
            <strong>Google would not take these.</strong> They are tried again on every run, so a passing problem sorts itself out; a
            standing one needs the reason below dealing with.
          </p>
          <ul className="gsh-issues">
            {view.failures.map((failure) => (
              <li key={failure.itemId} className="gsh-issue">
                <span className="gsh-issue-title">
                  <span className="badge badge-error">Refused</span> <SnapshotLine snapshot={failure.snapshot} />
                </span>
                <span className="gsh-issue-detail">{failure.message}</span>
                <span className="gsh-item-links">
                  <span className="gsw-muted gsw-small">{failure.itemId} · {formatDateTime(failure.failedAt)}</span>
                  {failure.merchantCentreUrl && (
                    <a href={failure.merchantCentreUrl} target="_blank" rel="noreferrer">Open in Merchant Center</a>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* --- Disagreements -------------------------------------------------- */}
      {view.disagreements.length > 0 && (
        <>
          <p className="gsh-panel-note">
            <strong>Google is showing something else.</strong> These were sent and taken, and the hourly check found Merchant Center
            holding a different figure. Both sides are below; they are sent again on the next run.
          </p>
          <ul className="gsh-issues">
            {view.disagreements.map((row) => (
              <li key={row.itemId} className="gsh-issue">
                <span className="gsh-issue-title">
                  <span className="badge badge-warning">Different</span> This site sent <SnapshotLine snapshot={row.sent} />
                </span>
                <span className="gsh-issue-detail">
                  {row.google
                    ? <>Google is showing <SnapshotLine snapshot={row.google} /></>
                    : <>Google is not showing this product at all.</>}
                </span>
                <span className="gsh-item-links">
                  <span className="gsw-muted gsw-small">{row.itemId} · {formatDateTime(row.checkedAt)}</span>
                  {row.merchantCentreUrl && (
                    <a href={row.merchantCentreUrl} target="_blank" rel="noreferrer">Open in Merchant Center</a>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <ChangeHistory
        entries={log}
        error={logError}
        undoingId={undoingId}
        onUndo={(entry) => void undo(entry)}
        onRetry={() => void loadLog()}
        label="Recent live-update activity"
        emptyText="Nothing yet. Setting this up, connecting it, disconnecting it and every send are listed here."
      />
    </section>
  )
}
