'use client'

// Page controls: first, previous, a page box to jump with, next, last.
import { useId, useState } from 'react'
import { formatCount } from '@/modules/google-shopping-for-shop/components/workbench/format'

type Props = {
  page: number
  pageCount: number
  total: number
  perPage: number
  disabled: boolean
  onPage: (page: number) => void
}

export function Pager({ page, pageCount, total, perPage, disabled, onPage }: Props) {
  // The box holds what is being typed; it resets to the real page whenever the
  // page changes underneath it.
  const boxId = useId()
  const [typed, setTyped] = useState<{ forPage: number; value: string } | null>(null)
  const boxValue = typed && typed.forPage === page ? typed.value : String(page)

  const first = total === 0 ? 0 : (page - 1) * perPage + 1
  const last = Math.min(total, page * perPage)

  function jump() {
    const wanted = Math.round(Number(boxValue))
    setTyped(null)
    if (Number.isFinite(wanted) && wanted >= 1 && wanted <= pageCount && wanted !== page) onPage(wanted)
  }

  return (
    <nav className="gsw-pager" aria-label="Pages">
      <span className="gsw-muted gsw-small">
        {total === 0 ? 'Nothing to show' : `Showing ${formatCount(first)}-${formatCount(last)} of ${formatCount(total)}`}
      </span>
      {pageCount > 1 && (
        <div className="gsw-pager-controls">
          <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || page <= 1} onClick={() => onPage(1)} aria-label="First page">«</button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
          <form onSubmit={(event) => { event.preventDefault(); jump() }} className="gsw-pager-controls">
            <label className="gsw-muted gsw-small" htmlFor={boxId}>Page</label>
            <input
              id={boxId}
              inputMode="numeric"
              value={boxValue}
              disabled={disabled}
              onChange={(event) => setTyped({ forPage: page, value: event.target.value.replace(/[^0-9]/g, '') })}
              onBlur={jump}
            />
            <span className="gsw-muted gsw-small">of {formatCount(pageCount)}</span>
          </form>
          <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || page >= pageCount} onClick={() => onPage(page + 1)}>Next</button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || page >= pageCount} onClick={() => onPage(pageCount)} aria-label="Last page">»</button>
        </div>
      )}
    </nav>
  )
}
