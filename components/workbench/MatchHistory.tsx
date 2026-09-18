'use client'

// One item's match history, newest first: when Google matched or unmatched it,
// and what title it held at the time.
import type { HistoryEntry } from '@/modules/google-shopping-for-shop/components/workbench/api'
import { formatDateTime, formatMoney } from '@/modules/google-shopping-for-shop/components/workbench/format'

export type HistoryState = { status: 'loading' } | { status: 'ready'; entries: HistoryEntry[] } | { status: 'error'; message: string }

function typicalPrice(entry: HistoryEntry): string {
  const amount = Number(entry.benchmarkAmountMicros) / 1_000_000
  if (!entry.benchmarkAmountMicros || !Number.isFinite(amount)) return 'n/a'
  return formatMoney(amount, entry.benchmarkCurrency)
}

export function MatchHistory({ state, onRetry }: { state: HistoryState | undefined; onRetry: () => void }) {
  if (!state || state.status === 'loading') {
    return <p className="gsw-status" role="status"><span className="gsw-spinner" aria-hidden /> Loading history…</p>
  }
  if (state.status === 'error') {
    return (
      <p className="gsw-message is-error" role="alert">
        {state.message}
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>Try again</button>
      </p>
    )
  }
  if (state.entries.length === 0) {
    return <p className="gsw-muted gsw-small" style={{ margin: 0 }}>No history yet. It starts with the next match check.</p>
  }
  return (
    <div className="gsw-history">
      <p className="gsw-muted gsw-small" style={{ margin: 0 }}>
        A line is added when the match state or the title Google holds changes. Dates are when a check first saw the change.
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Seen</th>
            <th scope="col">State</th>
            <th scope="col">Title Google held</th>
            <th scope="col">Typical price</th>
          </tr>
        </thead>
        <tbody>
          {state.entries.map((entry, index) => {
            // Newest first, so the entry after this one is the state before it.
            const previous = state.entries[index + 1]
            const titleChanged = previous !== undefined && previous.merchantTitle !== entry.merchantTitle
            const stateChanged = previous !== undefined && previous.matched !== entry.matched
            return (
              <tr key={`${entry.recordedAt}-${index}`}>
                <td className="gsw-nowrap">{formatDateTime(entry.recordedAt)}</td>
                <td className="gsw-nowrap">
                  <span className={`badge ${entry.matched ? 'badge-success' : 'badge-warning'}`}>{entry.matched ? 'Matched' : 'Not matched'}</span>
                  {stateChanged && <div className="gsw-muted gsw-small">was {previous.matched ? 'matched' : 'not matched'}</div>}
                  {previous === undefined && <div className="gsw-muted gsw-small">first seen</div>}
                </td>
                <td>
                  {entry.merchantTitle || <span className="gsw-muted">none</span>}
                  {titleChanged && <div className="gsw-small" style={{ color: 'var(--color-warning)', fontWeight: 600 }}>Title changed</div>}
                </td>
                <td className="gsw-nowrap">{typicalPrice(entry)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
