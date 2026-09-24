'use client'

// The switches that belong to the Reports tab rather than to the settings tab.
//
// Same reasoning as the Delivery tab's own daily-check switch: a setting lives
// where it is used, and an owner looking at an empty chart should be able to
// see why from the same screen rather than going hunting.
//
// Nothing saves as you type. Each control commits on change or on blur with a
// single PATCH, and the screen re-reads itself afterwards, so what is on the
// page is always what is stored rather than what was typed.
import { useState } from 'react'
import type { PerformanceReport } from '@/modules/google-shopping-for-shop/lib/performance/report'
import { BEST_SELLER_GRANULARITIES, GRANULARITY_LABELS, asGranularity } from '@/modules/google-shopping-for-shop/lib/best-sellers/types'
import type { ReportSettingsPatch } from '@/modules/google-shopping-for-shop/components/workbench/reports/api'

type Props = {
  settings: PerformanceReport['settings']
  busy: boolean
  onSave: (patch: ReportSettingsPatch) => void
}

/** What the boxes hold, as one string. Compared by VALUE rather than by object
 *  identity: the report is re-fetched whenever the date range changes, which
 *  hands this component a brand new settings object holding exactly the same
 *  numbers, and resetting the boxes on that would wipe out whatever was being
 *  typed at the time. */
function signatureOf(settings: Props['settings']): string {
  return [settings.backfillDays, settings.retentionDays, settings.bestSellersCategoryIds, settings.bestSellersLimit].join('\u0000')
}

export function ReportSettings({ settings, busy, onSave }: Props) {
  // The number and text boxes are held here while they are being typed in and
  // committed on blur. Committing on every keystroke would save "4" on the way
  // to "400".
  const [boxes, setBoxes] = useState(() => ({
    backfill: String(settings.backfillDays),
    retention: String(settings.retentionDays),
    categories: settings.bestSellersCategoryIds,
    limit: String(settings.bestSellersLimit),
  }))

  // Adjusting state during the render rather than in an effect - React's own
  // pattern for "put this back when the prop changes", and the one that does
  // not cost a second render pass. What came back from the server wins, so a
  // value the server clamped shows as the clamped one rather than as what was
  // typed at it.
  const [applied, setApplied] = useState(() => signatureOf(settings))
  const signature = signatureOf(settings)
  if (applied !== signature) {
    setApplied(signature)
    setBoxes({
      backfill: String(settings.backfillDays),
      retention: String(settings.retentionDays),
      categories: settings.bestSellersCategoryIds,
      limit: String(settings.bestSellersLimit),
    })
  }

  /** One number box, committed. Nothing usable typed in puts that box's stored
   *  value back rather than saving a NaN or leaving a blank. */
  function commitNumber(box: 'backfill' | 'retention' | 'limit', stored: number, patch: (parsed: number) => ReportSettingsPatch) {
    const parsed = Number(boxes[box])
    if (!Number.isInteger(parsed)) {
      setBoxes((held) => ({ ...held, [box]: String(stored) }))
      return
    }
    if (parsed === stored) return
    onSave(patch(parsed))
  }

  return (
    <section className="gsr-panel gsr-settings" aria-label="Report settings">
      <h3 className="gsr-panel-title">Settings for these figures</h3>

      <div className="gsr-setting">
        <label>
          <input
            type="checkbox"
            checked={settings.importEnabled}
            disabled={busy}
            onChange={(event) => onSave({ importEnabled: event.target.checked })}
          />{' '}
          Fetch Google&apos;s figures every day
        </label>
        <p className="gsr-setting-note">
          On by default. It only reads figures Google already holds and writes them here; it changes nothing about your feed or
          your shop. Switch it off if you would rather not spend the requests.
        </p>
      </div>

      <div className="gsr-setting">
        <label htmlFor="gsr-backfill">Fetch history going back</label>
        <input
          id="gsr-backfill"
          type="number"
          min={1}
          max={730}
          value={boxes.backfill}
          disabled={busy}
          onChange={(event) => setBoxes((held) => ({ ...held, backfill: event.target.value }))}
          onBlur={() => commitNumber('backfill', settings.backfillDays, (days) => ({ backfillDays: days }))}
        />
        <span className="gsw-small gsw-muted">days</span>
        <p className="gsr-setting-note">
          How far back the first fetch reaches. A quarter is the default. Widening it later fills in the extra days over the next
          few daily checks rather than all at once, so nothing has to be fetched twice.
        </p>
      </div>

      <div className="gsr-setting">
        <label htmlFor="gsr-retention">Keep figures for</label>
        <input
          id="gsr-retention"
          type="number"
          min={0}
          max={3650}
          value={boxes.retention}
          disabled={busy}
          onChange={(event) => setBoxes((held) => ({ ...held, retention: event.target.value }))}
          onBlur={() => commitNumber('retention', settings.retentionDays, (days) => ({ retentionDays: days }))}
        />
        <span className="gsw-small gsw-muted">days (0 keeps everything)</span>
        <p className="gsr-setting-note">
          Thirteen months by default, so this month can be compared with the same month last year. Anything older is dropped by
          the daily check.
        </p>
      </div>

      <div className="gsr-setting">
        <label>
          <input
            type="checkbox"
            checked={settings.bestSellersEnabled}
            disabled={busy}
            onChange={(event) => onSave({ bestSellersEnabled: event.target.checked })}
          />{' '}
          Also fetch what is selling in my categories
        </label>
        <p className="gsr-setting-note">
          Off by default: it is a second daily request and not every Merchant Center account has the report. A category Google
          does not rank simply returns nothing.
        </p>
      </div>

      {settings.bestSellersEnabled && (
        <>
          <div className="gsr-setting">
            <label htmlFor="gsr-categories">Google category numbers</label>
            <input
              id="gsr-categories"
              type="text"
              value={boxes.categories}
              disabled={busy}
              placeholder="Leave empty to use your own category mapping"
              onChange={(event) => setBoxes((held) => ({ ...held, categories: event.target.value }))}
              onBlur={() => {
                if (boxes.categories !== settings.bestSellersCategoryIds) onSave({ bestSellersCategoryIds: boxes.categories })
              }}
            />
            <p className="gsr-setting-note">
              Numbers from Google&apos;s product taxonomy, separated by commas. Leave it empty and Cactus uses the numbers you
              already typed against your own categories on the Google category screen; with none of those either, Google ranks
              its top-level categories instead. Ten categories at most.
            </p>
          </div>

          <div className="gsr-setting">
            <label htmlFor="gsr-granularity">Rank over</label>
            <select
              id="gsr-granularity"
              value={settings.bestSellersGranularity}
              disabled={busy}
              onChange={(event) => onSave({ bestSellersGranularity: asGranularity(event.target.value) })}
            >
              {BEST_SELLER_GRANULARITIES.map((option) => (
                <option key={option} value={option}>{GRANULARITY_LABELS[option]}</option>
              ))}
            </select>
          </div>

          <div className="gsr-setting">
            <label htmlFor="gsr-limit">Keep the top</label>
            <input
              id="gsr-limit"
              type="number"
              min={1}
              max={1000}
              value={boxes.limit}
              disabled={busy}
              onChange={(event) => setBoxes((held) => ({ ...held, limit: event.target.value }))}
              onBlur={() => commitNumber('limit', settings.bestSellersLimit, (rows) => ({ bestSellersLimit: rows }))}
            />
            <span className="gsw-small gsw-muted">per category</span>
          </div>
        </>
      )}
    </section>
  )
}
