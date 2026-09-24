'use client'

// The workbench's Delivery sub-tab: what this site charges for delivery, what
// Merchant Center charges, and the button that makes the second match the
// first.
//
// Three things this screen is careful about, because each of them is somebody
// else's money:
//
//   - Nothing calls Google on load. The preview is worked out here; the
//     comparison is the last one that was made, with the date on it. The two
//     buttons are the only things that pick up the telephone.
//   - Nothing is sent without being read first. The send asks, plainly, with
//     the number of services and what happens to the ones this site does not
//     manage, and the owner has to say yes.
//   - The places where the two systems do not fit are on the screen, not in a
//     comment. Delivery charged per item against one figure per product is the
//     big one, and it is stated in the owner's own terms at the top.
import { useCallback, useEffect, useState } from 'react'
import { workbenchCss } from '@/modules/google-shopping-for-shop/components/workbench/workbench-css'
import { deliveryCss } from '@/modules/google-shopping-for-shop/components/workbench/delivery/delivery-css'
import { formatCount, formatDateTime, formatMoney, plural } from '@/modules/google-shopping-for-shop/components/workbench/format'
import {
  compareDelivery,
  fetchDelivery,
  pushDelivery,
  setDeliverySync,
  type DeliveryTabView,
} from '@/modules/google-shopping-for-shop/components/workbench/delivery/api'
import type { ServiceComparison, ServiceDiffStatus } from '@/modules/google-shopping-for-shop/lib/delivery/diff'

type Notice = { tone: 'ok' | 'error' | 'info'; text: string }

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

const STATUS_LABEL: Record<ServiceDiffStatus, string> = {
  match: 'Matches',
  different: 'Different',
  missing: 'Not at Google yet',
  'only-in-google': 'Only at Google',
}

const STATUS_TONE: Record<ServiceDiffStatus, string> = {
  match: 'badge-success',
  different: 'badge-warning',
  missing: 'badge-info',
  'only-in-google': 'badge-default',
}

/** One of the mapping notes. The severity decides the stripe, never the
 *  wording: the sentence already says how serious it is. */
function NoteRow({ severity, service, message }: { severity: string; service: string | null; message: string }) {
  return (
    <li className={`gsd-note is-${severity}`}>
      {service && <span className="gsd-note-where">{service}</span>}
      <span className="gsd-note-text">{message}</span>
    </li>
  )
}

function ComparisonRow({ row }: { row: ServiceComparison }) {
  return (
    <div className="gsd-row">
      <div className="gsd-row-head">
        <span className="gsd-row-name">{row.serviceName}</span>
        <span className={`badge ${STATUS_TONE[row.status]}`}>{STATUS_LABEL[row.status]}</span>
        {row.status === 'only-in-google' && (
          <span className="gsd-service-time">
            {row.managed
              ? 'This site put it there and no longer offers it, so sending would take it away.'
              : 'Somebody set this up in Merchant Center. Sending leaves it exactly as it is.'}
          </span>
        )}
      </div>
      {row.differences.length > 0 && (
        <ul className="gsd-diffs">
          {row.differences.map((difference) => (
            <li key={difference.field} className="gsd-diff">
              <span className="gsd-diff-field">{difference.field}</span>
              <span className="gsd-diff-side">Here: {difference.here}</span>
              <span className="gsd-diff-side">At Google: {difference.atGoogle}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function DeliveryTab() {
  const [view, setView] = useState<DeliveryTabView | null>(null)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState<'compare' | 'push' | 'sync' | null>(null)
  const [confirming, setConfirming] = useState(false)

  const load = useCallback(async () => {
    try {
      // The await sits inside the setState call rather than a line above it,
      // the same way the Health tab does: it is what makes plain to both a
      // reader and the lint rule that nothing here sets state synchronously
      // while an effect is running.
      setView(await fetchDelivery())
      setLoadError('')
    } catch (error) {
      setLoadError(messageOf(error, 'Could not work out your delivery settings'))
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- first fetch on mount; every setState in load() runs after an await
    void load()
  }, [load])

  async function runCompare() {
    setBusy('compare')
    setNotice(null)
    try {
      const outcome = await compareDelivery()
      // An earlier send whose outcome was never known has just been settled by
      // this read, which also puts Undo back within reach - worth a sentence,
      // because the owner was last told that send could not be confirmed.
      const settled = outcome.status === 'ok' && outcome.settledEarlierSend
        ? ' An earlier send that could not be confirmed has now been checked, and it did go through.'
        : ''
      setNotice(outcome.status === 'ok'
        ? {
          tone: outcome.diff.differences > 0 ? 'info' : 'ok',
          text: (outcome.diff.differences > 0
            ? `${plural(outcome.diff.differences, 'delivery service')} at Merchant Center ${outcome.diff.differences === 1 ? 'does' : 'do'} not match this site.`
            : 'Merchant Center is charging exactly what this site charges.') + settled,
        }
        : { tone: 'info', text: outcome.message })
      await load()
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not compare your delivery settings with Google') })
    } finally {
      setBusy(null)
    }
  }

  async function runPush() {
    setBusy('push')
    setConfirming(false)
    setNotice(null)
    try {
      const outcome = await pushDelivery(view?.fingerprint ?? '')
      if (outcome.status === 'pushed') {
        const removed = outcome.removed.length > 0 ? ` ${plural(outcome.removed.length, 'old one')} taken away.` : ''
        const sent = plural(outcome.services.length, 'delivery service')
        // Straight back to Google for the truth of it, rather than telling the
        // owner it worked and showing them yesterday's comparison underneath.
        // This also SETTLES a send whose reply could not be read, which is why
        // it happens before the notice is written rather than after: telling
        // somebody to go and compare, and then comparing for them a
        // millisecond later, is advice that is stale by the time it is read.
        const checked = await compareDelivery().catch(() => null)
        // A send whose outcome could not be read back is NOT a green tick. It
        // is the one case where this site deliberately recorded that it does
        // not know what Merchant Center holds, and saying "sent" there would be
        // the one lie in the whole feature.
        if (outcome.confirmed) {
          setNotice({ tone: 'ok', text: `Sent ${sent} to Merchant Center.${removed}` })
        } else if (checked?.status === 'ok' && checked.settledEarlierSend) {
          setNotice({
            tone: 'ok',
            text: `${sent} went to Merchant Center. Google's reply could not be read back, so this site checked - it did go `
              + `through.${removed}`,
          })
        } else {
          setNotice({
            tone: 'info',
            text: `${sent} went to Merchant Center, but Google's reply could not be read back and a check afterwards could not `
              + 'confirm what it now holds. The comparison below is what Merchant Center actually has.',
          })
        }
      } else {
        setNotice({ tone: outcome.status === 'conflict' || outcome.status === 'stale' ? 'error' : 'info', text: outcome.message })
      }
      await load()
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not send your delivery settings to Google') })
    } finally {
      setBusy(null)
    }
  }

  async function toggleSync(enabled: boolean) {
    setBusy('sync')
    try {
      setView(await setDeliverySync(enabled))
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not change the daily check') })
    } finally {
      setBusy(null)
    }
  }

  const canSend = view !== null && view.available && !view.unreadable && view.linked && !view.blocked
    && view.services.length > 0 && view.fingerprint !== ''
  const unmanagedAtGoogle = (view?.lastDiff?.services ?? []).filter((row) => row.status === 'only-in-google' && !row.managed)

  return (
    <div className="gsd">
      <style>{workbenchCss}{deliveryCss}</style>

      <div className="gsd-head">
        <div>
          <h2 className="gsw-title">Delivery</h2>
          <p className="gsw-lede">
            What Merchant Center charges for delivery, lined up against what this site charges. Nothing here is sent to Google until
            you have read it and said so.
          </p>
        </div>
        <div className="gsd-actions">
          <button type="button" className="btn btn-sm" disabled={busy !== null || view === null || !view.linked} onClick={() => void runCompare()}>
            {busy === 'compare' ? 'Asking Google…' : 'Compare with Google'}
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null || !canSend} onClick={() => setConfirming(true)}>
            Send to Merchant Center
          </button>
        </div>
      </div>

      {notice && <p className={`gsw-message is-${notice.tone}`}>{notice.text}</p>}
      {loadError !== '' && <p className="gsw-message is-error">{loadError}</p>}

      {view && !view.available && (
        <div className="gsd-empty">
          <strong>Nothing here publishes delivery services</strong>
          Install a delivery module and this tab fills itself in. Until then, delivery rates are set in Merchant Center by hand.
        </div>
      )}

      {view?.unreadable && (
        <p className="gsw-message is-error">
          Your delivery services could not be read, so there is nothing to show. Check the delivery settings on this site.
        </p>
      )}

      {view && view.available && !view.linked && (
        <p className="gsw-message is-info">
          Fill in your Merchant Center account number on the Google Shopping settings tab and the comparing and sending can work.
          What would be sent is below either way.
        </p>
      )}

      {/* --- The one blocker that is a setting rather than a delivery rule -- */}
      {view && view.available && !view.unreadable && !view.labelsFromDeliveryScopes && (
        <div className="gsd-panel is-bad">
          <h3 className="gsd-panel-title">Your products are not labelled with these delivery groups yet</h3>
          <p className="gsd-panel-note">
            Google matches these prices to a product by the delivery group the product carries in your feed, and your feed is
            labelling products some other way at the moment. Sending as things stand would name groups that no product carries, and
            every product in the shop would be charged whatever the last rule says.
          </p>
          <p className="gsd-panel-note">
            On the <strong>Google Shopping settings</strong> tab, under &ldquo;Group your products for delivery rates&rdquo;, set
            <strong> Where the group comes from</strong> to <strong>Your own delivery rules</strong>. Then come back here and the
            counts below will mean something.
          </p>
        </div>
      )}

      {/* --- Sending, once it has been read -------------------------------- */}
      {confirming && view && (
        <div className="gsd-confirm">
          <p className="gsd-confirm-title">Send these delivery settings to Merchant Center?</p>
          <p className="gsd-confirm-text">
            {plural(view.services.length, 'delivery service')} below will be written to your Merchant Center account, replacing
            whatever {view.services.length === 1 ? 'it currently says' : 'they currently say'} there.
            {unmanagedAtGoogle.length > 0
              ? ` ${plural(unmanagedAtGoogle.length, 'other service')} at Merchant Center ${unmanagedAtGoogle.length === 1 ? 'was' : 'were'} set up by somebody else and will be left exactly as ${unmanagedAtGoogle.length === 1 ? 'it is' : 'they are'}.`
              : ' Anything at Merchant Center this site did not put there is left exactly as it is.'}
            {' '}You can undo this afterwards from the change log.
          </p>
          <div className="gsd-actions">
            <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => void runPush()}>
              {busy === 'push' ? 'Sending…' : 'Yes, send them'}
            </button>
            <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* --- Where the two systems do not fit ------------------------------ */}
      {view && view.notes.length > 0 && (
        <div className={`gsd-panel${view.blocked ? ' is-bad' : ''}`}>
          <h3 className="gsd-panel-title">{view.blocked ? 'These have to be sorted out first' : 'Worth knowing'}</h3>
          <p className="gsd-panel-note">
            Google&apos;s delivery settings and this site&apos;s do not have quite the same shape. Everything that could not be carried
            across exactly is listed here rather than quietly rounded off.
          </p>
          <ul className="gsd-notes">
            {view.notes.map((note, index) => (
              <NoteRow key={`${note.severity}-${note.service ?? 'shop'}-${index}`} severity={note.severity} service={note.service} message={note.message} />
            ))}
          </ul>
        </div>
      )}

      {/* --- How much of the catalogue this would actually cover ----------- */}
      {view?.coverage && view.coverage.anyServiceWithoutCatchAll && (
        <div className="gsd-panel is-bad">
          <h3 className="gsd-panel-title">Not every product would get a delivery price</h3>
          <p className="gsd-panel-note">
            Google does not fall back to anything when a product has no delivery price - it stops showing the product. These are
            counted from every active product on the site, so the feed itself sends slightly fewer.
          </p>
          <ul className="gsd-groups">
            {view.coverage.services.filter((service) => service.uncovered > 0).map((service) => (
              <li key={service.serviceName} className="gsd-group">
                <span className="gsd-group-price">{formatCount(service.uncovered)}</span>
                <span className="gsd-group-labels">
                  products get no price from &ldquo;{service.serviceName}&rdquo;, of {formatCount(view.coverage?.products ?? 0)}
                </span>
              </li>
            ))}
            {view.coverage.unlabelled > 0 && (
              <li className="gsd-group">
                <span className="gsd-group-price">{formatCount(view.coverage.unlabelled)}</span>
                <span className="gsd-group-labels">products are in no delivery group at all, so they carry no label</span>
              </li>
            )}
          </ul>
        </div>
      )}

      {/* --- What would be sent -------------------------------------------- */}
      {view && view.services.length > 0 && (
        <div className="gsd-panel">
          <h3 className="gsd-panel-title">What would be sent</h3>
          <p className="gsd-panel-note">
            One Merchant Center delivery service for each of yours, with a price for each group of products. Prices include VAT,
            the way the prices in your feed do.
            {view.taxRatesDiffer && ' Your products are not all taxed at the same rate, so these use the highest of them.'}
          </p>
          {view.services.map((service) => (
            <div key={service.serviceName} className="gsd-service">
              <div className="gsd-service-head">
                <span className="gsd-service-name">{service.serviceName}</span>
                <span className="gsd-service-time">
                  {plural(service.handlingDays, 'working day')} to send it, then {plural(service.transitDays, 'working day')} on the way
                </span>
              </div>
              <ul className="gsd-groups">
                {service.groups.map((group, index) => (
                  <li key={`${service.serviceName}-${index}`} className={`gsd-group${group.catchAll ? ' is-catch-all' : ''}`}>
                    <span className="gsd-group-price">{group.price === null ? 'Not offered' : formatMoney(group.price, view.currency)}</span>
                    <span className="gsd-group-labels">
                      {group.catchAll ? 'Everything the groups above do not cover' : group.labels.join(', ')}
                      {group.price === null && ' - Google is told this service cannot deliver these'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* --- The comparison ------------------------------------------------ */}
      {view && (
        <div className="gsd-panel">
          <h3 className="gsd-panel-title">Compared with Merchant Center</h3>
          {view.lastDiff
            ? (
              <>
                <p className="gsd-panel-note">
                  As it stood on {formatDateTime(view.lastDiff.comparedAt)}.
                  {view.pushedAt ? ` Last sent on ${formatDateTime(view.pushedAt)}.` : ' Nothing has ever been sent from here.'}
                </p>
                <div className="gsd-compare">
                  {view.lastDiff.services.map((row) => <ComparisonRow key={row.serviceName} row={row} />)}
                </div>
              </>
            )
            : (
              <p className="gsd-panel-note">
                These have never been compared. Press &ldquo;Compare with Google&rdquo; above and this fills in - it only reads, and
                sends nothing.
              </p>
            )}
        </div>
      )}

      {/* --- The daily check ----------------------------------------------- */}
      {view && view.available && (
        <div className="gsd-panel">
          <h3 className="gsd-panel-title">Keep an eye on it</h3>
          <label style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={view.syncEnabled}
              disabled={busy !== null}
              onChange={(event) => void toggleSync(event.target.checked)}
              style={{ marginTop: '0.2rem' }}
            />
            <span>
              <span style={{ display: 'block', color: 'var(--color-text)' }}>Check once a day and tell me if they drift apart</span>
              <span className="gsd-panel-note">
                One read of your Merchant Center delivery settings a day. Nothing is ever sent by the check - if the two stop
                agreeing it raises a notice in the bell and leaves the deciding to you.
              </span>
            </span>
          </label>
        </div>
      )}
    </div>
  )
}
