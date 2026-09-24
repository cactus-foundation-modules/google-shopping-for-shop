'use client'

// The recent changes to the feed rules and to the owner's own per-product
// choices, newest first, each with an Undo. Undo only puts back what is still
// as the change left it; the answer says when something had moved on.
import type { LogEntry } from '@/modules/google-shopping-for-shop/components/workbench/feed-rules/api'
import { formatDateTime } from '@/modules/google-shopping-for-shop/components/workbench/format'

type Props = {
  entries: LogEntry[] | null
  error: string
  undoingId: string | null
  onUndo: (entry: LogEntry) => void
  onRetry: () => void
  /** What this list is of. Defaults to the feed rules' own wording, so the tab
   *  that had it first is unchanged; the live updates panel passes its own. */
  label?: string
  /** What to say when there is nothing in it yet. */
  emptyText?: string
}

const DEFAULT_LABEL = 'Recent changes to rules and product choices'
const DEFAULT_EMPTY = 'Nothing yet. Every rule added, changed, moved or deleted is listed here, with a way back.'

export function ChangeHistory({ entries, error, undoingId, onUndo, onRetry, label, emptyText }: Props) {
  const count = entries?.length ?? 0
  return (
    <details className="gsw-changes">
      <summary>{label ?? DEFAULT_LABEL}{entries ? ` (${count})` : ''}</summary>
      {error && (
        <p className="gsw-message is-error" role="alert" style={{ margin: '0 0.75rem 0.75rem' }}>
          {error}
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>Try again</button>
        </p>
      )}
      {entries && count === 0 && <p className="gsw-muted gsw-small" style={{ margin: '0 0.75rem 0.75rem' }}>{emptyText ?? DEFAULT_EMPTY}</p>}
      {entries && count > 0 && (
        <ol>
          {entries.map((entry) => (
            <li key={entry.id} className={`gsw-change${entry.undoneAt ? ' is-undone' : ''}`}>
              <span className="gsw-change-summary">{entry.summary}</span>
              <span className="gsw-muted gsw-nowrap">{entry.createdBy ? `${entry.createdBy}, ` : ''}{formatDateTime(entry.createdAt)}</span>
              {entry.undoneAt
                ? <span className="badge badge-default">Undone {formatDateTime(entry.undoneAt)}</span>
                : entry.canUndo && (
                  <button type="button" className="btn btn-secondary btn-sm" disabled={undoingId !== null} onClick={() => onUndo(entry)}>
                    {undoingId === entry.id ? <><span className="gsw-spinner" aria-hidden /> Undoing…</> : 'Undo'}
                  </button>
                )}
            </li>
          ))}
        </ol>
      )}
    </details>
  )
}
