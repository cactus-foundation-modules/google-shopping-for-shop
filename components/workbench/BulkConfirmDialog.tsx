'use client'

// The "are you sure" for a bulk title change, filled in by a dry run: how many
// titles actually change, whose hand-written template gets replaced, what
// comes out broken, and a few real before/after titles. Nobody should change
// three thousand titles on the strength of a count alone.
import { useEffect } from 'react'
import type { BulkAction, BulkOutcome } from '@/modules/google-shopping-for-shop/components/workbench/api'
import { formatCount, plural } from '@/modules/google-shopping-for-shop/components/workbench/format'

type Props = {
  action: BulkAction
  outcome: BulkOutcome
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function BulkConfirmDialog({ action, outcome, busy, onConfirm, onCancel }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  const setting = action.kind === 'set-template'
  const nothing = outcome.changing === 0

  return (
    <div className="gsw-overlay" onClick={(event) => { if (event.target === event.currentTarget && !busy) onCancel() }}>
      <div className="gsw-dialog" role="dialog" aria-modal="true" aria-labelledby="gsw-bulk-title">
        <h3 id="gsw-bulk-title">{setting ? 'Set this Google title template?' : 'Clear these Google title templates?'}</h3>
        {setting && <p><code>{action.template}</code></p>}
        {nothing ? (
          <p>All {plural(outcome.affected, 'item')} already {setting ? 'have exactly this template' : 'send their site title'}. There is nothing to change.</p>
        ) : (
          <>
            <p>
              <strong>{plural(outcome.changing, 'title')}</strong> will change
              {outcome.unchanged > 0 && <> ({formatCount(outcome.unchanged)} of the {formatCount(outcome.affected)} selected already {setting ? 'have it' : 'send their site title'})</>}.
              {setting ? ' Only what Google is sent changes - product names on the site stay as they are.' : ' Those items go back to sending their site title.'}
            </p>
            {((setting && outcome.replacingOwn > 0) || outcome.unknownTokenItems > 0 || outcome.tooLongItems > 0) && (
              <ul>
                {outcome.replacingOwn > 0 && setting && (
                  <li><strong>{plural(outcome.replacingOwn, 'item')}</strong> {outcome.replacingOwn === 1 ? 'has' : 'have'} a template of {outcome.replacingOwn === 1 ? 'its' : 'their'} own already, which this replaces.</li>
                )}
                {outcome.unknownTokenItems > 0 && (
                  <li><strong>{plural(outcome.unknownTokenItems, 'item')}</strong> {outcome.unknownTokenItems === 1 ? 'lacks' : 'lack'} a token the template uses, so that part is left out of {outcome.unknownTokenItems === 1 ? 'its' : 'their'} title.</li>
                )}
                {outcome.tooLongItems > 0 && (
                  <li><strong>{plural(outcome.tooLongItems, 'title')}</strong> {outcome.tooLongItems === 1 ? 'comes' : 'come'} out over 150 characters and will be cut short.</li>
                )}
              </ul>
            )}
            {outcome.samples.length > 0 && (
              <div className="gsw-samples">
                <span className="gsw-preview-label">How the first few change</span>
                {outcome.samples.map((sample) => (
                  <div key={sample.id} className="gsw-sample">
                    <span className="gsw-sample-before">{sample.before}</span>
                    <span className="gsw-sample-after">{sample.after}</span>
                    {sample.unknownTokens.length > 0 && <span className="gsw-warn">Left out: {sample.unknownTokens.join(', ')}</span>}
                  </div>
                ))}
              </div>
            )}
            <p className="gsw-muted gsw-small">Changed your mind afterwards? Recent changes, below the list, can undo it.</p>
          </>
        )}
        <div className="gsw-dialog-actions">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onCancel}>{nothing ? 'Close' : 'Cancel'}</button>
          {!nothing && (
            <button type="button" className={setting ? 'btn btn-primary' : 'btn btn-danger'} disabled={busy} autoFocus onClick={onConfirm}>
              {busy ? <><span className="gsw-spinner" aria-hidden /> Saving…</> : `Change ${plural(outcome.changing, 'title')}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
