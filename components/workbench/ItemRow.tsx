'use client'

// One feed item in the workbench table: what it is, how Google sees it, and its
// title template editor. Memoised - typing in one row's editor must not
// re-render the other two hundred.
import { memo } from 'react'
import { ISSUE_LABELS } from '@/modules/google-shopping-for-shop/lib/workbench-query'
import type { WorkbenchRow } from '@/modules/google-shopping-for-shop/lib/workbench-view'
import { TemplateEditor } from '@/modules/google-shopping-for-shop/components/workbench/TemplateEditor'
import { MatchHistory, type HistoryState } from '@/modules/google-shopping-for-shop/components/workbench/MatchHistory'
import { formatDateTime, formatMoney, plural } from '@/modules/google-shopping-for-shop/components/workbench/format'

type Props = {
  row: WorkbenchRow
  adminPath: string
  selected: boolean
  /** Every matching row is selected as a whole; single rows cannot be unticked. */
  selectionLocked: boolean
  onSelect: (id: string, selected: boolean) => void
  draft: string
  dirty: boolean
  saving: boolean
  onDraftChange: (id: string, value: string, saved: string | null) => void
  onSave: (id: string) => void
  onRevert: (id: string) => void
  historyOpen: boolean
  history: HistoryState | undefined
  onToggleHistory: (id: string) => void
  onRetryHistory: (id: string) => void
  /** True when the list is already narrowed to this row's listing. */
  listingShown: boolean
  onShowListing: (groupId: string) => void
}

// Google says nothing about which product it matched an offer to, so both
// links search Google Shopping for the title Google holds for us.
function googleShoppingSearch(title: string): string {
  return `https://www.google.com/search?${new URLSearchParams({ udm: '28', q: title })}`
}

function MatchBadge({ state }: { state: WorkbenchRow['matched'] }) {
  if (state === 'matched') return <span className="badge badge-success">Matched</span>
  if (state === 'unmatched') return <span className="badge badge-warning">Not matched</span>
  return <span className="badge badge-default">Not reported yet</span>
}

function PriceLine({ row }: { row: WorkbenchRow }) {
  const onSale = row.regularPrice > row.priceAmount
  return (
    <div>
      <span className="gsw-muted">Ours </span>
      <strong>{formatMoney(row.priceAmount, row.currency)}</strong>
      {onSale && <span className="gsw-muted"> (was {formatMoney(row.regularPrice, row.currency)})</span>}
      {row.benchmarkAmount !== null && (
        <>
          <span className="gsw-muted"> · typical </span>
          <strong>{formatMoney(row.benchmarkAmount, row.benchmarkCurrency || row.currency)}</strong>
          {row.gapPercent !== null && (
            <div className={`gsw-gap is-${row.pricePosition}`}>
              {row.gapPercent === 0 ? 'Level with typical' : row.gapPercent > 0 ? `${row.gapPercent}% dearer than typical` : `${Math.abs(row.gapPercent)}% cheaper than typical`}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ItemRowView(props: Props) {
  const { row, adminPath, selected, selectionLocked, draft, dirty, saving, historyOpen, history, listingShown } = props
  const editHref = `/${adminPath}/m/shop/products/${row.groupId ?? row.id}`
  const outOfDate = row.issues.includes('out-of-date')

  return (
    <>
      <tr className={`gsw-row${selected ? ' is-selected' : ''}${dirty ? ' is-dirty' : ''}`}>
        <td className="gsw-check">
          <input
            type="checkbox"
            checked={selected}
            disabled={selectionLocked}
            aria-label={`Select ${row.renderedTitle}`}
            onChange={(event) => props.onSelect(row.id, event.target.checked)}
          />
        </td>
        <td>
          <div className="gsw-product">
            {row.imageUrl
              // eslint-disable-next-line @next/next/no-img-element -- feed photos are arbitrary media-library hosts, not a configured next/image loader
              ? <img className="gsw-thumb" src={row.imageUrl} alt="" loading="lazy" decoding="async" />
              : <div className="gsw-thumb gsw-thumb-empty" aria-hidden>No photo</div>}
            <div className="gsw-product-body">
              <a className="gsw-product-name" href={editHref} title="Edit this product">{row.originalTitle}</a>
              <div className="gsw-meta">
                {row.sku && <span>SKU <code>{row.sku}</code></span>}
                {row.mpn && <span>MPN <code>{row.mpn}</code></span>}
                {row.gtin && <span>GTIN <code>{row.gtin}</code></span>}
                {row.brand && <span>{row.brand}</span>}
              </div>
              {row.productType && <div className="gsw-meta"><span>{row.productType}</span></div>}
              {row.groupId && row.listingSize > 1 && !listingShown && (
                <div>
                  <button type="button" className="gsw-linkish" onClick={() => props.onShowListing(row.groupId ?? row.id)}>
                    One of {plural(row.listingSize, 'variation')} - show them all
                  </button>
                </div>
              )}
              {row.issues.length > 0 && (
                <div className="gsw-issues">
                  {row.issues.map((code) => (
                    <span key={code} className={`badge ${code === 'unknown-token' || code === 'too-long' ? 'badge-error' : 'badge-warning'}`}>{ISSUE_LABELS[code]}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </td>
        <td>
          <div className="gsw-google">
            <div><MatchBadge state={row.matched} /></div>
            <PriceLine row={row} />
            {outOfDate && (
              <div className="gsw-held">
                <strong>Google still holds: </strong>{row.merchantTitle}
              </div>
            )}
            <div className="gsw-google-actions">
              {row.matched !== 'unknown' && (
                <a href={googleShoppingSearch(row.merchantTitle || row.renderedTitle)} target="_blank" rel="noreferrer">
                  {row.matched === 'matched' ? 'Find on Google' : 'Search on Google'}
                </a>
              )}
              <a href={row.url} target="_blank" rel="noreferrer">View on site</a>
              <button type="button" className="gsw-linkish" aria-expanded={historyOpen} onClick={() => props.onToggleHistory(row.id)}>
                {historyOpen ? 'Hide history' : 'History'}
              </button>
            </div>
            {row.checkedAt && <div className="gsw-muted gsw-small">Checked {formatDateTime(row.checkedAt)}</div>}
          </div>
        </td>
        <td>
          <TemplateEditor
            label={`Google title template for ${row.originalTitle}`}
            value={draft}
            onChange={(value) => props.onDraftChange(row.id, value, row.titleTemplate)}
            context={row.context}
            originalTitle={row.originalTitle}
            placeholder="Blank sends the site title"
            dirty={dirty}
            disabled={saving}
            onSubmit={dirty ? () => props.onSave(row.id) : undefined}
          >
            <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || saving} onClick={() => props.onSave(row.id)}>Save</button>
            {dirty && <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={() => props.onRevert(row.id)}>Undo edit</button>}
            {!dirty && row.titleTemplate !== null && (
              <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={() => props.onDraftChange(row.id, '', row.titleTemplate)}>Clear</button>
            )}
          </TemplateEditor>
        </td>
      </tr>
      {historyOpen && (
        <tr className="gsw-subrow">
          <td />
          <td colSpan={3}>
            <MatchHistory state={history} onRetry={() => props.onRetryHistory(row.id)} />
          </td>
        </tr>
      )}
    </>
  )
}

export const ItemRow = memo(ItemRowView)
