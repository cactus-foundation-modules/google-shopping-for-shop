'use client'

// The Health tab's Google Ads panel.
//
// Google Ads is a separate account from Merchant Center, with a separate
// sign-in, and this is the only screen that says so. It has to hold three quite
// different states apart without ever letting one borrow the other's words:
//
//   not connected   details are missing from the site's settings. Says which.
//                   Never an error - nothing is broken, it has not been set up.
//   connected, idle nothing has needed sending. A healthy state.
//   in trouble      Google is refusing, or the sales tracker turns out to be a
//                   PRIMARY one, which would double-count every ad sale.
//
// Nothing here calls Google on load. The four buttons are the only things that
// pick up the telephone, and each says which call it is making.
import { useCallback, useEffect, useId, useState } from 'react'
import { formatCount, formatDateTime, formatMoney, plural } from '@/modules/google-shopping-for-shop/components/workbench/format'
import { ADS_ENV_COPY, type AdsEnvVar } from '@/modules/google-shopping-for-shop/lib/google-ads/types'
import {
  ADS_ENV_FIELDS,
  adsEnvVarsToSave,
  describeAdsEnvSave,
  describeAdsEnvSaveFailure,
} from '@/modules/google-shopping-for-shop/lib/google-ads/env-save'
import {
  checkAdsConnection,
  connectAdsTracker,
  fetchAds,
  runAdsSpendFetch,
  runAdsUpload,
  saveAdsEnvVars,
  setAds,
  type AdsAccessReport,
  type AdsView,
} from '@/modules/google-shopping-for-shop/components/workbench/health/ads-api'

type Notice = { tone: 'ok' | 'error' | 'info'; text: string }
type Busy = 'check' | 'connect' | 'upload' | 'spend' | 'switch' | null

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/** Tokens, so the marks read the same in both themes. The word beside each one
 *  carries the meaning; the colour only helps it along. */
const TONE: Record<AdsAccessReport['probes'][number]['status'], { mark: string; colour: string; word: string }> = {
  ok: { mark: '✓', colour: 'var(--color-success)', word: 'Yes' },
  denied: { mark: '✕', colour: 'var(--color-danger)', word: 'No' },
  unknown: { mark: '?', colour: 'var(--color-text-muted)', word: 'Not known' },
}

/** What the last upload came to, said plainly.
 *
 *  The one thing this must never do is read "done" for a run that started and
 *  never came back. A stalled run and a finished one look identical from a
 *  count of sales sent, and only the stamps can tell them apart. */
function LastRunLine({ view }: { view: AdsView }) {
  const run = view.lastRun
  if (run.running) return <>A send is under way now.</>
  if (run.stalled) {
    return (
      <>
        A send started {run.startedAt ? formatDateTime(run.startedAt) : 'a while ago'} and never came back. Nothing here knows how far
        it got - the next run picks up whatever is still waiting.
      </>
    )
  }
  if (!run.finishedAt) return <>Nothing has been sent to Google Ads yet.</>
  const words = run.status === 'ok' ? 'went through' : run.status === 'part' ? 'went through in part' : 'did not go through'
  return (
    <>
      Last send {words}, {formatDateTime(run.finishedAt)}: {plural(run.uploaded, 'sale')} sent
      {run.failed > 0 && <>, {formatCount(run.failed)} refused</>}
      {run.skipped > 0 && <>, {formatCount(run.skipped)} left out</>}.
      {run.lastError && <> {run.lastError}</>}
    </>
  )
}

/** The sales tracker's state, in the three ways it can be. */
function TrackerLine({ view }: { view: AdsView }) {
  const tracker = view.conversionAction
  if (!tracker.resourceName) {
    return (
      <>
        No sales tracker has been set up at Google Ads yet. <strong>Set it up</strong> makes one called
        {' '}&ldquo;{tracker.managedName}&rdquo;, or reuses that one if it is already there.
      </>
    )
  }
  if (tracker.primary === true) {
    return (
      <>
        Google says &ldquo;{tracker.name ?? tracker.managedName}&rdquo; is a <strong>primary</strong> tracker, which would have every
        sale from an advert counted twice - once by the tag in the shopper&apos;s browser and once by this site. Nothing is being
        sent while that is the case. Press <strong>Set it up</strong> to put it right.
      </>
    )
  }
  if (tracker.primary === null) {
    return (
      <>
        Google has not said whether &ldquo;{tracker.name ?? tracker.managedName}&rdquo; is primary or secondary, and nothing is sent
        until it does. Press <strong>Set it up</strong> to ask again.
      </>
    )
  }
  return (
    <>
      Sending to &ldquo;{tracker.name ?? tracker.managedName}&rdquo;, which Google confirms is a <strong>secondary</strong> tracker
      {tracker.checkedAt ? <> (last checked {formatDateTime(tracker.checkedAt)}; it is checked again before every send)</> : null}.
      Secondary keeps these sales out of the figure your bidding uses, so nothing is counted twice alongside the tag in the
      shopper&apos;s browser.
      {' '}
      <strong>One thing to avoid:</strong> if you put this tracker inside a <em>custom conversion goal</em> on a campaign, Google
      bids on it anyway - custom goals ignore the secondary setting, and there is no way for this site to see that you have done
      it. Leave it out of your conversion goals and the figures stay honest.
    </>
  )
}

/**
 * Entering the Google Ads sign-in details, and saying where each one comes
 * from.
 *
 * Nothing here writes anything itself. Save posts to core's own environment
 * route, which is the only thing on the site allowed to hold a credential: it
 * checks the person is an administrator, refuses any name no installed module
 * declares, writes the rest to the hosting project and raises the "needs
 * redeploying" notice. This screen only says what came back.
 *
 * Two rules the boxes must never break:
 *
 *   never pre-filled  a value that is already saved is said to be saved, in
 *                     words, beside its box. It is never put INTO the box - a
 *                     secret in the page is a secret in every screenshot,
 *                     every browser's saved-password list and every copy of
 *                     the page source, and this site has no way of reading one
 *                     back anyway.
 *   blank means leave  an empty box changes nothing. That is how one detail is
 *                     replaced without retyping the other four.
 */
export function AdsCredentials({ view }: { view: AdsView }) {
  const idPrefix = useId()
  const [values, setValues] = useState<Partial<Record<AdsEnvVar, string>>>({})
  const [shown, setShown] = useState<Partial<Record<AdsEnvVar, boolean>>>({})
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<Notice | null>(null)
  // Null means "nobody has touched it": open while the details are missing,
  // tucked away once they are there.
  const [opened, setOpened] = useState<boolean | null>(null)
  const expanded = opened ?? !view.connected

  const save = useCallback(async () => {
    const vars = adsEnvVarsToSave(values)
    if (vars.length === 0) {
      setResult({ tone: 'info', text: 'Nothing was filled in, so nothing was saved.' })
      return
    }
    setSaving(true)
    setResult(null)
    const outcome = await saveAdsEnvVars(vars)
    setSaving(false)
    if (!outcome.ok) {
      setResult({ tone: 'error', text: describeAdsEnvSaveFailure(outcome.status, outcome.message) })
      return
    }
    // Emptied on the way out, so a saved secret is not left sitting in the page
    // behind a Show button.
    setValues({})
    setShown({})
    setResult({
      tone: outcome.skipped.length > 0 ? 'info' : 'ok',
      text: describeAdsEnvSave(outcome.written, outcome.skipped),
    })
  }, [values])

  return (
    <div className="gsw-creds">
      <button
        type="button"
        className="gsw-creds-summary"
        aria-expanded={expanded}
        onClick={() => setOpened(!expanded)}
      >
        {expanded ? 'Hide how to connect Google Ads' : 'How to connect Google Ads'}
      </button>

      {expanded && (
        <>
          <ol className="gsw-creds-steps">
            <li>
              In the Google Cloud console, under <strong>APIs and services</strong> then <strong>Credentials</strong>, make an
              OAuth client. That gives you a <strong>sign-in ID</strong> and a <strong>sign-in secret</strong>, which are the
              first two boxes below.
            </li>
            <li>
              Let that client read your Google Ads account, once. What comes back is the <strong>permission token</strong>. It
              is granted the one time and does not run out on its own.
            </li>
            <li>
              The <strong>account number</strong> is the ten-digit one at the top right of Google Ads. Dashes are fine - they
              are stripped out.
            </li>
            <li>
              If your Google Ads account sits underneath a <strong>manager account</strong>, put the manager&apos;s number in as
              well. If it stands on its own, leave that box empty.
            </li>
          </ol>

          {view.isAdmin ? (
            <form
              className="gsw-creds-form"
              onSubmit={(event) => {
                event.preventDefault()
                void save()
              }}
            >
              {ADS_ENV_FIELDS.map((key) => {
                const id = `${idPrefix}-${key}`
                const isShown = shown[key] === true
                return (
                  <div className="gsw-field" key={key}>
                    <label className="gsw-field-label" htmlFor={id}>
                      {ADS_ENV_COPY[key].label}
                      {!ADS_ENV_COPY[key].required && <span className="gsw-field-optional">only if you need it</span>}
                    </label>
                    <p className="gsw-field-where">{ADS_ENV_COPY[key].where}</p>
                    <div className="gsw-field-row">
                      <input
                        id={id}
                        type={isShown ? 'text' : 'password'}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={saving}
                        value={values[key] ?? ''}
                        placeholder={view.env[key] ? 'Leave empty to keep what is saved' : 'Not set yet'}
                        onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))}
                      />
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setShown((current) => ({ ...current, [key]: !isShown }))}
                      >
                        {isShown ? 'Hide' : 'Show'}
                      </button>
                      <span className={`gsw-field-state${view.env[key] ? ' is-set' : ''}`}>
                        {view.env[key] ? 'Already set' : 'Not set yet'}
                      </span>
                    </div>
                  </div>
                )
              })}

              <p className="gsw-field-where">
                Leave a box empty and that detail is left exactly as it is, so one of them can be replaced without retyping the
                rest. Whatever you save only reaches the running site on its next rebuild.
              </p>

              <div className="gsw-creds-actions">
                <button type="submit" className="btn btn-sm btn-primary" disabled={saving}>
                  {saving ? 'Saving…' : 'Save these details'}
                </button>
              </div>

              {result && <p className={`gsw-message is-${result.tone}`}>{result.text}</p>}
            </form>
          ) : (
            <p className="gsw-field-where">
              These have to be entered by an administrator, so there are no boxes here for you. Pass them to whoever looks after
              this site and they can put them in on this same screen.
            </p>
          )}
        </>
      )}
    </div>
  )
}

export function AdsPanel() {
  const [view, setView] = useState<AdsView | null>(null)
  const [access, setAccess] = useState<AdsAccessReport | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [loadError, setLoadError] = useState('')

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setView(await fetchAds(signal))
      setLoadError('')
    } catch (error) {
      if (signal?.aborted) return
      setLoadError(messageOf(error, 'Could not read the Google Ads figures'))
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- first fetch on mount; every setState in load() runs after an await
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const check = useCallback(async () => {
    setBusy('check')
    setNotice(null)
    try {
      setAccess(await checkAdsConnection())
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not check your Google Ads connection') })
    } finally {
      setBusy(null)
    }
  }, [])

  const connect = useCallback(async () => {
    setBusy('connect')
    setNotice(null)
    try {
      const { outcome, ads } = await connectAdsTracker()
      setView(ads)
      setNotice(outcome.status === 'ready'
        ? {
          tone: 'ok',
          text: outcome.created
            ? `Made a sales tracker at Google Ads called "${outcome.action.name ?? ads.conversionAction.managedName}", set to secondary. Switch the sending on below.`
            : `Connected to "${outcome.action.name ?? ads.conversionAction.managedName}"${outcome.madeSecondary ? ', and set it to secondary.' : '. Google confirms it is secondary.'}`,
        }
        : { tone: 'error', text: outcome.reason })
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not set up the Google Ads sales tracker') })
    } finally {
      setBusy(null)
    }
  }, [])

  const upload = useCallback(async () => {
    setBusy('upload')
    setNotice(null)
    try {
      const { outcome, ads } = await runAdsUpload()
      setView(ads)
      if (outcome.status === 'skipped') {
        setNotice({ tone: 'info', text: outcome.message })
      } else {
        const { uploaded, failed, skipped, leftWaiting } = outcome.summary
        const parts: string[] = []
        if (uploaded > 0) parts.push(`${plural(uploaded, 'sale')} sent`)
        if (failed > 0) parts.push(`${formatCount(failed)} refused`)
        if (skipped > 0) parts.push(`${formatCount(skipped)} left out`)
        if (leftWaiting > 0) parts.push(`${formatCount(leftWaiting)} still waiting for the next run`)
        setNotice({
          tone: failed > 0 ? 'error' : 'ok',
          text: [parts.length > 0 ? `${parts.join(', ')}.` : 'Nothing needed sending.', outcome.summary.message ?? '']
            .filter((part) => part !== '').join(' '),
        })
      }
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not send your sales to Google Ads') })
    } finally {
      setBusy(null)
    }
  }, [])

  const fetchSpend = useCallback(async () => {
    setBusy('spend')
    setNotice(null)
    try {
      const { outcome, ads } = await runAdsSpendFetch()
      setView(ads)
      setNotice(outcome.status === 'skipped'
        ? { tone: 'info', text: 'Nothing was fetched - either Google Ads is switched off here, or everything Google has published so far is already in.' }
        : {
          tone: 'ok',
          text: outcome.backfilling
            ? `Brought in ${plural(outcome.rows, 'figure')} up to ${outcome.to}. Still catching up on earlier days; the rest follows on the next check.`
            : `Brought in ${plural(outcome.rows, 'figure')} up to ${outcome.to}.`,
        })
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not fetch what your ads cost') })
    } finally {
      setBusy(null)
    }
  }, [])

  const toggle = useCallback(async (patch: { enabled?: boolean; uploadEnabled?: boolean; spendImportEnabled?: boolean }) => {
    setBusy('switch')
    setNotice(null)
    try {
      setView(await setAds(patch))
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not change that') })
    } finally {
      setBusy(null)
    }
  }, [])

  if (loadError !== '') {
    return (
      <section className="gsh-panel is-bad" aria-label="Google Ads">
        <h3 className="gsh-panel-title">Google Ads</h3>
        <p className="gsh-panel-note">{loadError}</p>
      </section>
    )
  }
  if (!view) return null

  const tracker = view.conversionAction
  const sending = view.enabled && view.uploadEnabled && tracker.primary === false
  const trouble = view.uploads.refused > 0 || tracker.primary === true || view.lastRun.stalled || view.spend.failedAt !== null

  return (
    <section className={`gsh-panel${trouble ? ' is-bad' : sending ? ' is-good' : ''}`} aria-label="Google Ads">
      <h3 className="gsh-panel-title">Google Ads</h3>
      <p className="gsh-panel-note">
        Your paid Shopping adverts live in Google Ads, which is a different account from Merchant Center with its own sign-in. With
        this on, the site brings in what those adverts cost so the Reports tab can show it, and tells Google Ads which of its clicks
        turned into a sale - so its own figures stop being guesswork. Only shoppers who agreed to marketing are ever included, and
        only sales this site could already tie to a paid click.
      </p>

      {/* --- Not connected ------------------------------------------------- */}
      {!view.connected && (
        <div className="gsw-message is-info">
          <p style={{ margin: '0 0 0.5rem' }}>
            Google Ads is not connected yet. These still need saving on this site - the boxes for them are just below:
          </p>
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {view.missing.map((name: AdsEnvVar) => (
              <li key={name} style={{ marginBottom: '0.25rem' }}>
                <strong>{ADS_ENV_COPY[name].label}</strong>
                {' '}<code>{name}</code>
                <span style={{ display: 'block', fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>
                  {ADS_ENV_COPY[name].where}
                </span>
              </li>
            ))}
          </ul>
          {!view.env.GOOGLE_ADS_DEVELOPER_TOKEN && (
            <p style={{ margin: '0.5rem 0 0', fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>
              {ADS_ENV_COPY.GOOGLE_ADS_DEVELOPER_TOKEN.where}
            </p>
          )}
        </div>
      )}

      {/* --- Where the details come from, and the boxes to put them in ------ */}
      <AdsCredentials view={view} />

      {notice && <p className={`gsw-message is-${notice.tone}`}>{notice.text}</p>}

      {/* --- The switches --------------------------------------------------- */}
      <div className="gsw-switch">
        <label>
          <input
            type="checkbox"
            checked={view.enabled}
            disabled={busy !== null || !view.connected}
            onChange={(event) => void toggle({ enabled: event.target.checked })}
          />
          {' '}Use Google Ads on this site
        </label>
      </div>
      <div className="gsw-switch">
        <label>
          <input
            type="checkbox"
            checked={view.spendImportEnabled}
            disabled={busy !== null || !view.enabled}
            onChange={(event) => void toggle({ spendImportEnabled: event.target.checked })}
          />
          {' '}Bring in what the adverts cost, once a day
        </label>
      </div>
      <div className="gsw-switch">
        <label>
          <input
            type="checkbox"
            checked={view.uploadEnabled}
            disabled={busy !== null || !view.enabled || !tracker.resourceName}
            onChange={(event) => void toggle({ uploadEnabled: event.target.checked })}
          />
          {' '}Tell Google Ads which clicks turned into a sale
        </label>
      </div>

      {/* --- The tracker ---------------------------------------------------- */}
      <p className="gsh-panel-note"><TrackerLine view={view} /></p>

      {/* --- What has happened ---------------------------------------------- */}
      <p className="gsh-panel-note">
        <LastRunLine view={view} />
        {view.uploads.waiting > 0 && <> {plural(view.uploads.waiting, 'sale')} waiting to go.</>}
        {view.uploads.uploaded > 0 && <> {plural(view.uploads.uploaded, 'sale')} sent altogether.</>}
      </p>

      <p className="gsh-panel-note">
        {view.spend.failedAt
          ? <>The last attempt to fetch what your ads cost failed on {formatDateTime(view.spend.failedAt)}{view.spend.lastError ? <>: {view.spend.lastError}</> : null}</>
          : view.spend.checkedAt
            ? <>
                Costs last fetched {formatDateTime(view.spend.checkedAt)}
                {view.spend.heldFrom && view.spend.heldTo ? <>, covering {view.spend.heldFrom} to {view.spend.heldTo}</> : null}
                {view.account.currency ? <>, billed in {view.account.currency}</> : null}.
              </>
            : <>Google Ads has not been asked what your adverts cost yet, so there is nothing to show. That is not the same as them having cost nothing.</>}
      </p>

      {/* --- The buttons ---------------------------------------------------- */}
      <div className="gsh-actions">
        <button type="button" className="btn btn-sm" disabled={busy !== null || !view.connected} onClick={() => void check()}>
          {busy === 'check' ? 'Asking Google…' : 'Check the connection'}
        </button>
        <button type="button" className="btn btn-sm" disabled={busy !== null || !view.enabled} onClick={() => void connect()}>
          {busy === 'connect' ? 'Setting up…' : 'Set it up'}
        </button>
        <button type="button" className="btn btn-sm" disabled={busy !== null || !view.enabled} onClick={() => void fetchSpend()}>
          {busy === 'spend' ? 'Fetching…' : 'Fetch costs now'}
        </button>
        <button type="button" className="btn btn-sm" disabled={busy !== null || !sending} onClick={() => void upload()}>
          {busy === 'upload' ? 'Sending…' : 'Send sales now'}
        </button>
      </div>

      {/* --- The connection check ------------------------------------------- */}
      {access && (
        <div className="gsh-explain">
          <p className="gsh-explain-head">
            {access.accountName
              ? <>Google Ads answered for <strong>{access.accountName}</strong>{access.customerId ? <> ({access.customerId})</> : null}.</>
              : <>Checked against account {access.customerId ?? 'not set'}.</>}
            {access.loginCustomerId && <> Signed in through manager account {access.loginCustomerId}.</>}
            {access.timeZone && <> Its day runs on {access.timeZone} time.</>}
          </p>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {access.probes.map((probe) => (
              <li key={probe.id} style={{ display: 'flex', gap: '0.625rem', alignItems: 'flex-start', padding: '0.375rem 0' }}>
                <span aria-hidden style={{ color: TONE[probe.status].colour, fontWeight: 700, lineHeight: 1.4 }}>{TONE[probe.status].mark}</span>
                <span>
                  <span style={{ display: 'block', fontSize: '0.875rem', color: 'var(--color-text)' }}>
                    {probe.label} - <strong>{TONE[probe.status].word}</strong>
                  </span>
                  <span style={{ display: 'block', fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>{probe.detail}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="gsh-explain-foot">Checked {formatDateTime(access.checkedAt)}. Nothing was changed by asking.</p>
        </div>
      )}

      {/* --- What has not got through ---------------------------------------- */}
      {view.uploads.problems.length > 0 && (
        <div className="gsh-issues">
          <p className="gsh-panel-note">
            Sales that have not reached Google Ads. A refused one is offered again on the next few runs, up to
            {' '}{view.uploads.maxAttempts} tries; one that was left out is not - the reason will not change on its own.
          </p>
          {view.uploads.problems.map((row) => (
            <div key={row.orderId} className="gsh-issue">
              <span className="gsh-issue-title">
                Order {row.orderNumber}
                {row.value !== null && <> · {formatMoney(row.value, row.currency ?? 'GBP')}</>}
                {' · '}
                {row.status === 'refused' ? `refused${row.attempts > 1 ? ` (${row.attempts} tries)` : ''}` : 'left out'}
              </span>
              <span className="gsh-issue-detail">{row.message ?? 'No reason was given.'}</span>
            </div>
          ))}
        </div>
      )}

      {/* --- What has ------------------------------------------------------- */}
      {view.uploads.recent.length > 0 && (
        <div className="gsh-issues">
          <p className="gsh-panel-note">The most recent sales Google Ads took.</p>
          {view.uploads.recent.map((row) => (
            <div key={row.orderId} className="gsh-issue">
              <span className="gsh-issue-title">
                Order {row.orderNumber}
                {row.value !== null && <> · {formatMoney(row.value, row.currency ?? 'GBP')}</>}
              </span>
              <span className="gsh-issue-detail">{row.at ? `Sent ${formatDateTime(row.at)}` : 'Sent'}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
