'use client'

// The sticky bar that appears once anything is selected: how much, the step up
// to "every item that matches", and one template to set across the lot, with
// a live preview against one of them.
import type { WorkbenchRow } from '@/modules/google-shopping-for-shop/lib/workbench-view'
import { TemplateEditor } from '@/modules/google-shopping-for-shop/components/workbench/TemplateEditor'
import type { WorkbenchSelection } from '@/modules/google-shopping-for-shop/components/workbench/use-selection'
import { formatCount, plural } from '@/modules/google-shopping-for-shop/components/workbench/format'

type Props = {
  selection: WorkbenchSelection
  /** The rows on screen, to preview against and to offer "select all matching". */
  pageRows: WorkbenchRow[]
  /** Items the current query matches, across every page. */
  matchingTotal: number
  template: string
  onTemplateChange: (value: string) => void
  busy: boolean
  onSetTemplate: () => void
  onClearTemplates: () => void
}

export function BulkBar({ selection, pageRows, matchingTotal, template, onTemplateChange, busy, onSetTemplate, onClearTemplates }: Props) {
  if (selection.count === 0) return null

  const previewRow = pageRows.find((row) => selection.isSelected(row.id)) ?? null
  const wholePageSelected = pageRows.length > 0 && pageRows.every((row) => selection.isSelected(row.id))
  const offerWholeQuery = !selection.isWholeQuery && wholePageSelected && matchingTotal > pageRows.length

  return (
    <section className="gsw-bar" aria-label="Change the selected items">
      <div className="gsw-bar-row">
        <span className="gsw-bar-count">
          {selection.isWholeQuery ? `All ${plural(selection.count, 'matching item')} selected` : `${plural(selection.count, 'item')} selected`}
        </span>
        {offerWholeQuery && (
          <button type="button" className="gsw-linkish gsw-select-all" onClick={() => selection.selectWholeQuery(matchingTotal)}>
            Select all {formatCount(matchingTotal)} that match, not just this page
          </button>
        )}
        <span className="gsw-spacer" />
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={selection.clear}>Clear selection</button>
      </div>
      <TemplateEditor
        label="Google title template for the selected items"
        value={template}
        onChange={onTemplateChange}
        context={previewRow?.context ?? null}
        originalTitle={previewRow?.originalTitle ?? ''}
        placeholder="One template for all of them, e.g. <brand> <parent_title> <colour> <size>"
        disabled={busy}
        onSubmit={template.trim() ? onSetTemplate : undefined}
      >
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || template.trim() === ''} onClick={onSetTemplate}>
          {busy ? <><span className="gsw-spinner" aria-hidden /> Checking…</> : 'Set this template…'}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onClearTemplates}>Clear their templates…</button>
        {previewRow
          ? <span className="gsw-muted gsw-small">Preview shows {previewRow.originalTitle}</span>
          : <span className="gsw-muted gsw-small">Tick a row on this page to preview against it</span>}
      </TemplateEditor>
    </section>
  )
}
