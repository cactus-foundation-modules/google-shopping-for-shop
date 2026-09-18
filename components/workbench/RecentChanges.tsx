'use client'

// The last few title template saves, newest first, each with an Undo. Undo
// restores only the titles still as that save left them; anything edited since
// is left alone, and the answer says how many.
import type { ChangeEntry } from '@/modules/google-shopping-for-shop/components/workbench/api'
import { formatDateTime, plural } from '@/modules/google-shopping-for-shop/components/workbench/format'

type Props = {
  changes: ChangeEntry[] | null
  error: string
  undoingId: string | null
  onUndo: (change: ChangeEntry) => void
  onRetry: () => void
}

export function RecentChanges({ changes, error, undoingId, onUndo, onRetry }: Props) {
  const count = changes?.length ?? 0
  return (
    <details className="gsw-changes">
      <summary>Recent title changes{changes ? ` (${count})` : ''}</summary>
      {error && (
        <p className="gsw-message is-error" role="alert" style={{ margin: '0 0.75rem 0.75rem' }}>
          {error}
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>Try again</button>
        </p>
      )}
      {changes && count === 0 && <p className="gsw-muted gsw-small" style={{ margin: '0 0.75rem 0.75rem' }}>Nothing yet. Every save from this screen will be listed here, with a way back.</p>}
      {changes && count > 0 && (
        <ol>
          {changes.map((change) => (
            <li key={change.id} className={`gsw-change${change.undoneAt ? ' is-undone' : ''}`}>
              <span className="gsw-change-summary">{change.summary}</span>
              <span className="gsw-muted gsw-nowrap">{plural(change.itemCount, 'item')}</span>
              <span className="gsw-muted gsw-nowrap">{change.createdBy ? `${change.createdBy}, ` : ''}{formatDateTime(change.createdAt)}</span>
              {change.undoneAt
                ? <span className="badge badge-default">Undone {formatDateTime(change.undoneAt)}</span>
                : (
                  <button type="button" className="btn btn-secondary btn-sm" disabled={undoingId !== null} onClick={() => onUndo(change)}>
                    {undoingId === change.id ? <><span className="gsw-spinner" aria-hidden /> Undoing…</> : 'Undo'}
                  </button>
                )}
            </li>
          ))}
        </ol>
      )}
    </details>
  )
}
