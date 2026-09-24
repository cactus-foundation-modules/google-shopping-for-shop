'use client'

// The workbench's Products sub-tab: every item in the Google feed, how Google
// sees it, and the feed-only titles it is sent.
//
// Built for catalogues in the tens of thousands. The server holds the whole
// feed in memory and answers a search in milliseconds (lib/workbench-data.ts);
// this screen keeps the query in the address bar, debounces typing, cancels
// stale requests and always says what it is doing while it waits.
//
// This file only wires the parts together. The list's request lifecycle is
// use-workbench-list.ts, selection use-selection.ts, unsaved edits
// use-title-drafts.ts, and each part of the screen its own component.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { UnsavedChangesModal } from '@/components/admin/UnsavedChangesModal'
import { useUnsavedChanges } from '@/components/admin/useUnsavedChanges'
import { isFilteredQuery, writeWorkbenchQuery, type WorkbenchQuery } from '@/modules/google-shopping-for-shop/lib/workbench-query'
import {
  exportHref,
  fetchChanges,
  fetchHistory,
  refreshMatchStatus,
  runBulk,
  saveTemplates,
  undoChange,
  type BulkAction,
  type BulkOutcome,
  type BulkScope,
  type ChangeEntry,
} from '@/modules/google-shopping-for-shop/components/workbench/api'
import { BulkBar } from '@/modules/google-shopping-for-shop/components/workbench/BulkBar'
import { BulkConfirmDialog } from '@/modules/google-shopping-for-shop/components/workbench/BulkConfirmDialog'
import { FilterBar } from '@/modules/google-shopping-for-shop/components/workbench/FilterBar'
import { ItemRow } from '@/modules/google-shopping-for-shop/components/workbench/ItemRow'
import type { HistoryState } from '@/modules/google-shopping-for-shop/components/workbench/MatchHistory'
import { Pager } from '@/modules/google-shopping-for-shop/components/workbench/Pager'
import { RecentChanges } from '@/modules/google-shopping-for-shop/components/workbench/RecentChanges'
import { StatusLine } from '@/modules/google-shopping-for-shop/components/workbench/StatusLine'
import { SummaryPanel } from '@/modules/google-shopping-for-shop/components/workbench/SummaryPanel'
import { agoFromSeconds, formatCount, formatDateTime, plural } from '@/modules/google-shopping-for-shop/components/workbench/format'
import { useElapsedSeconds } from '@/modules/google-shopping-for-shop/components/workbench/use-elapsed-seconds'
import { useSelection } from '@/modules/google-shopping-for-shop/components/workbench/use-selection'
import { useStableCallback } from '@/modules/google-shopping-for-shop/components/workbench/use-stable-callback'
import { useTitleDrafts } from '@/modules/google-shopping-for-shop/components/workbench/use-title-drafts'
import { useWorkbenchList } from '@/modules/google-shopping-for-shop/components/workbench/use-workbench-list'
import { workbenchCss } from '@/modules/google-shopping-for-shop/components/workbench/workbench-css'

type Notice = { tone: 'ok' | 'error' | 'info'; text: string; undoBatchId?: string | null }

type PendingBulk = { action: BulkAction; scope: BulkScope; outcome: BulkOutcome }

// The save route takes 500 edits a call.
const SAVE_CHUNK = 500
const SKELETON_ROWS = 8

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

function listParams(query: WorkbenchQuery): URLSearchParams {
  return writeWorkbenchQuery(query, new URLSearchParams())
}

export function ProductsTab() {
  const adminPath = useAdminPath()
  const router = useRouter()
  const list = useWorkbenchList()
  const selection = useSelection(list.query)
  const drafts = useTitleDrafts()
  const searchRef = useRef<HTMLInputElement>(null)

  const [notice, setNotice] = useState<Notice | null>(null)
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(new Set())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [histories, setHistories] = useState<Record<string, HistoryState>>({})
  const [bulkTemplate, setBulkTemplate] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)
  const [pendingBulk, setPendingBulk] = useState<PendingBulk | null>(null)
  const [changes, setChanges] = useState<ChangeEntry[] | null>(null)
  const [changesError, setChangesError] = useState('')
  const [undoingId, setUndoingId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshRun, setRefreshRun] = useState(0)
  const refreshSeconds = useElapsedSeconds(refreshing, refreshRun)

  const { pendingHref, setPendingHref } = useUnsavedChanges(() => drafts.count > 0)

  const { data, summary, query } = list
  const rows = data?.rows ?? []
  const loading = list.phase === 'loading'
  const catalogueItems = data?.catalogue.items ?? summary?.total ?? null

  // ----- Recent changes ------------------------------------------------------
  const loadChanges = useCallback(async () => {
    try {
      const next = await fetchChanges()
      setChanges(next)
      setChangesError('')
    } catch (error) {
      setChangesError(messageOf(error, 'Could not load recent changes'))
    }
  }, [])

  useEffect(() => {
    void loadChanges()
  }, [loadChanges])

  // ----- "/" jumps to the search box, as it does on most big lists ----------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return
      event.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // ----- Filters -------------------------------------------------------------
  const changeQuery = useCallback((patch: Partial<WorkbenchQuery>) => {
    setNotice(null)
    list.updateQuery(patch)
  }, [list])

  const showListing = useStableCallback((groupId: string) => changeQuery({ group: groupId }))

  // ----- Row edits -----------------------------------------------------------
  /** Saves the given edits (all of them when no ids), and says whether it worked. */
  async function saveRows(ids?: string[]): Promise<boolean> {
    const updates = drafts.updates(ids)
    if (updates.length === 0) return true
    const saving = updates.map((update) => update.itemId)
    setSavingIds((previous) => new Set([...previous, ...saving]))
    setNotice(null)
    try {
      let changed = 0
      let lastBatch: string | null = null
      for (let start = 0; start < updates.length; start += SAVE_CHUNK) {
        const outcome = await saveTemplates(updates.slice(start, start + SAVE_CHUNK))
        changed += outcome.changed
        lastBatch = outcome.batchId
      }
      drafts.discard(saving)
      setNotice({
        tone: 'ok',
        text: changed === 0 ? 'Nothing had changed, so nothing was saved.' : `Saved ${plural(changed, 'title')}. Google picks ${changed === 1 ? 'it' : 'them'} up the next time it fetches the feed.`,
        undoBatchId: updates.length <= SAVE_CHUNK ? lastBatch : null,
      })
      list.reload()
      void loadChanges()
      return true
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not save the titles') })
      return false
    } finally {
      setSavingIds((previous) => {
        const next = new Set(previous)
        for (const id of saving) next.delete(id)
        return next
      })
    }
  }

  const saveRow = useStableCallback((id: string) => void saveRows([id]))
  const revertRow = useStableCallback((id: string) => drafts.discard([id]))

  // ----- Match history -------------------------------------------------------
  async function loadHistory(id: string) {
    setHistories((previous) => ({ ...previous, [id]: { status: 'loading' } }))
    try {
      const entries = await fetchHistory(id)
      setHistories((previous) => ({ ...previous, [id]: { status: 'ready', entries } }))
    } catch (error) {
      setHistories((previous) => ({ ...previous, [id]: { status: 'error', message: messageOf(error, 'Could not load match history') } }))
    }
  }

  // Fetched the first time a row opens; reopening reuses what came back.
  const toggleHistory = useStableCallback((id: string) => {
    const opening = !expanded.has(id)
    setExpanded((previous) => {
      const next = new Set(previous)
      if (opening) next.add(id)
      else next.delete(id)
      return next
    })
    if (opening && !histories[id]) void loadHistory(id)
  })
  const retryHistory = useStableCallback((id: string) => void loadHistory(id))

  // ----- Bulk changes --------------------------------------------------------
  async function startBulk(action: BulkAction) {
    const scope = selection.scope
    if (!scope) return
    setBulkBusy(true)
    setNotice(null)
    try {
      const outcome = await runBulk(scope, action, true)
      setPendingBulk({ action, scope, outcome })
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not check that change') })
    } finally {
      setBulkBusy(false)
    }
  }

  async function confirmBulk() {
    if (!pendingBulk) return
    setBulkBusy(true)
    try {
      const result = await runBulk(pendingBulk.scope, pendingBulk.action, false)
      const changed = result.changed ?? 0
      setPendingBulk(null)
      selection.clear()
      setBulkTemplate('')
      setNotice({
        tone: 'ok',
        text: `Changed ${plural(changed, 'title')}. Google picks them up the next time it fetches the feed.`,
        undoBatchId: result.batchId ?? null,
      })
      list.reload()
      void loadChanges()
    } catch (error) {
      setPendingBulk(null)
      setNotice({ tone: 'error', text: messageOf(error, 'Could not change the titles') })
      list.reload()
    } finally {
      setBulkBusy(false)
    }
  }

  // ----- Undo ----------------------------------------------------------------
  async function undo(batchId: string) {
    setUndoingId(batchId)
    setNotice(null)
    try {
      const result = await undoChange(batchId)
      const left = result.skipped > 0
        ? ` ${plural(result.skipped, 'title')} had been edited since, so ${result.skipped === 1 ? 'it was' : 'they were'} left as ${result.skipped === 1 ? 'it is' : 'they are'}.`
        : ''
      setNotice({ tone: 'ok', text: `Put back ${plural(result.restored, 'title')}.${left}`, undoBatchId: result.batchId })
      list.reload()
      void loadChanges()
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not undo that change') })
    } finally {
      setUndoingId(null)
    }
  }

  // ----- Google match refresh ------------------------------------------------
  async function refreshMatches() {
    setRefreshing(true)
    setRefreshRun((run) => run + 1)
    setNotice({ tone: 'info', text: 'Asking Google about every item in the feed. On a big catalogue that can take up to a minute.' })
    try {
      const result = await refreshMatchStatus()
      setNotice({ tone: 'ok', text: `Google reported on ${plural(result.products, 'item')}; ${formatCount(result.matched)} are matched to other sellers.` })
      setHistories({})
      setExpanded(new Set())
      list.reload()
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not refresh match status') })
    } finally {
      setRefreshing(false)
    }
  }

  // ----- Leaving with unsaved edits -----------------------------------------
  function leave(href: string) {
    setPendingHref(null)
    router.push(href)
  }

  const pageIds = rows.map((row) => row.id)
  const pageSelectedCount = rows.filter((row) => selection.isSelected(row.id)).length
  const allOnPageSelected = rows.length > 0 && pageSelectedCount === rows.length
  const listingTitle = query.group !== '' ? rows.find((row) => row.groupId === query.group || row.id === query.group)?.parentTitle ?? null : null
  const filtered = isFilteredQuery(query)

  return (
    <div className="gsw">
      <style dangerouslySetInnerHTML={{ __html: workbenchCss }} />

      <header className="gsw-head">
        <div>
          <h2 className="gsw-title">Google Shopping</h2>
          <p className="gsw-lede">
            Every item in the Google feed, whether Google has matched it to other sellers, how its price compares, and the title Google is sent.
            Titles set here are for Google only - product names on the site are left alone.
          </p>
        </div>
        <div className="gsw-head-actions">
          <a className="btn btn-secondary btn-sm" href={exportHref(listParams(query))} download>
            Download {data && data.total !== data.catalogue.items ? `these ${formatCount(data.total)}` : 'all'} as CSV
          </a>
          <button type="button" className="btn btn-secondary btn-sm" disabled={loading} onClick={() => list.reload({ reread: true })}>
            Re-read the shop
          </button>
          {data?.canRefresh && (
            <button type="button" className="btn btn-primary btn-sm" disabled={refreshing} onClick={() => void refreshMatches()}>
              {refreshing ? <><span className="gsw-spinner" aria-hidden /> Asking Google… {refreshSeconds ?? 0}s</> : 'Check matches with Google'}
            </button>
          )}
        </div>
      </header>

      {data && (
        <p className="gsw-muted gsw-small" style={{ margin: 0 }}>
          Shop read {agoFromSeconds(data.catalogue.ageSeconds)}{data.catalogue.stale ? ' - reading it again in the background' : ''}
          {' · '}Google last reported {summary?.lastCheckedAt ? formatDateTime(summary.lastCheckedAt) : 'never'}
          {data.catalogue.withheld > 0 && <> · {plural(data.catalogue.withheld, 'product')} held back from Google for having no photo</>}
          {data.catalogue.outOfFeed > 0 && query.feed === 'in' && (
            <> · <button type="button" className="gsw-linkish" onClick={() => changeQuery({ feed: 'out' })}>{plural(data.catalogue.outOfFeed, 'item')} kept out by rules or by hand</button></>
          )}
        </p>
      )}

      <SummaryPanel summary={summary} query={query} onChange={changeQuery} />

      <FilterBar
        query={query}
        summary={summary}
        searchInput={list.searchInput}
        onSearchInput={list.setSearchInput}
        onSearchSubmit={list.applySearchNow}
        searching={list.searchPending || (loading && list.activity === 'search')}
        searchRef={searchRef}
        onChange={changeQuery}
        onReset={list.resetFilters}
        listingTitle={listingTitle}
      />

      {notice && (
        <p className={`gsw-message is-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
          <span>{notice.text}</span>
          {notice.undoBatchId && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={undoingId !== null} onClick={() => void undo(notice.undoBatchId ?? '')}>Undo</button>
          )}
          <button type="button" className="gsw-search-clear" aria-label="Dismiss" onClick={() => setNotice(null)}>×</button>
        </p>
      )}

      {drafts.count > 0 && (
        <section className="gsw-bar is-unsaved" aria-label="Unsaved edits">
          <div className="gsw-bar-row">
            <span className="gsw-bar-count">{plural(drafts.count, 'unsaved title edit')}</span>
            <span className="gsw-muted gsw-small">Kept while you page and search, until you save or discard them.</span>
            <span className="gsw-spacer" />
            <button type="button" className="btn btn-ghost btn-sm" disabled={savingIds.size > 0} onClick={drafts.discardAll}>Discard all</button>
            <button type="button" className="btn btn-primary btn-sm" disabled={savingIds.size > 0} onClick={() => void saveRows()}>
              {savingIds.size > 0 ? <><span className="gsw-spinner" aria-hidden /> Saving…</> : `Save all ${formatCount(drafts.count)}`}
            </button>
          </div>
        </section>
      )}

      <BulkBar
        selection={selection}
        pageRows={rows}
        matchingTotal={data?.total ?? 0}
        template={bulkTemplate}
        onTemplateChange={setBulkTemplate}
        busy={bulkBusy}
        onSetTemplate={() => void startBulk({ kind: 'set-template', template: bulkTemplate.trim() })}
        onClearTemplates={() => void startBulk({ kind: 'clear-template' })}
      />

      {list.phase === 'error' && (
        <p className="gsw-message is-error" role="alert">
          <span>{list.error}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => list.reload()}>Try again</button>
        </p>
      )}

      <div className="gsw-card">
        <StatusLine
          phase={list.phase}
          activity={list.activity}
          searchPending={list.searchPending}
          elapsedSeconds={list.elapsedSeconds}
          catalogueItems={catalogueItems}
          targetPage={query.page}
          result={data ? { total: data.total, page: data.page, pageCount: data.pageCount, serverMs: data.serverMs } : null}
          filtered={filtered}
        />
        <div className="gsw-scroll">
          <table className="gsw-table" aria-busy={loading}>
            <thead>
              <tr>
                <th className="gsw-check" scope="col">
                  <input
                    type="checkbox"
                    aria-label="Select every item on this page"
                    checked={allOnPageSelected}
                    disabled={rows.length === 0 || selection.isWholeQuery}
                    ref={(element) => {
                      if (element) element.indeterminate = pageSelectedCount > 0 && !allOnPageSelected
                    }}
                    onChange={(event) => selection.setMany(pageIds, event.target.checked)}
                  />
                </th>
                <th scope="col" className="gsw-col-product">Product</th>
                <th scope="col" className="gsw-col-google">On Google</th>
                <th scope="col">Title sent to Google</th>
              </tr>
            </thead>
            <tbody className={`gsw-tbody${loading && data ? ' is-busy' : ''}`}>
              {!data && list.phase !== 'error' && Array.from({ length: SKELETON_ROWS }, (_unused, index) => (
                <tr key={`skeleton-${index}`} aria-hidden>
                  <td className="gsw-check" />
                  <td><div className="gsw-product"><span className="skeleton gsw-thumb" style={{ display: 'block' }} /><span className="skeleton" style={{ display: 'block', width: '80%', height: '1rem' }} /></div></td>
                  <td><span className="skeleton" style={{ display: 'block', width: '60%', height: '1rem' }} /></td>
                  <td><span className="skeleton" style={{ display: 'block', width: '100%', height: '3rem' }} /></td>
                </tr>
              ))}
              {rows.map((row) => (
                <ItemRow
                  key={row.id}
                  row={row}
                  adminPath={adminPath}
                  selected={selection.isSelected(row.id)}
                  selectionLocked={selection.isWholeQuery}
                  onSelect={selection.toggle}
                  draft={drafts.valueFor(row.id, row.titleTemplate)}
                  dirty={drafts.isDirty(row.id)}
                  saving={savingIds.has(row.id)}
                  onDraftChange={drafts.set}
                  onSave={saveRow}
                  onRevert={revertRow}
                  historyOpen={expanded.has(row.id)}
                  history={histories[row.id]}
                  onToggleHistory={toggleHistory}
                  onRetryHistory={retryHistory}
                  listingShown={query.group !== ''}
                  onShowListing={showListing}
                />
              ))}
              {data && rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="gsw-empty">
                    {filtered ? (
                      <>
                        <strong>Nothing matches.</strong>
                        Try fewer words, or <button type="button" className="gsw-linkish" onClick={list.resetFilters}>clear the filters</button>.
                      </>
                    ) : (
                      <>
                        <strong>Nothing in the Google feed yet.</strong>
                        Products go to Google once they are active, visible in the shop and have a photo.
                      </>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {data && (
          <Pager
            page={data.page}
            pageCount={data.pageCount}
            total={data.total}
            perPage={data.perPage}
            disabled={loading}
            onPage={(page) => changeQuery({ page })}
          />
        )}
      </div>

      <RecentChanges
        changes={changes}
        error={changesError}
        undoingId={undoingId}
        onUndo={(change) => void undo(change.id)}
        onRetry={() => void loadChanges()}
      />

      {pendingBulk && (
        <BulkConfirmDialog
          action={pendingBulk.action}
          outcome={pendingBulk.outcome}
          busy={bulkBusy}
          onConfirm={() => void confirmBulk()}
          onCancel={() => setPendingBulk(null)}
        />
      )}

      <UnsavedChangesModal
        pendingHref={pendingHref}
        saving={savingIds.size > 0}
        message={`${plural(drafts.count, 'title edit')} on the Google Shopping list ${drafts.count === 1 ? 'is' : 'are'} not saved yet. Save before you go?`}
        onCancel={() => setPendingHref(null)}
        onDiscard={() => {
          drafts.discardAll()
          if (pendingHref) leave(pendingHref)
        }}
        onSave={() => {
          const href = pendingHref
          // Only leave once the edits are safely saved; a failed save stays put
          // with its error showing, edits intact.
          void saveRows().then((saved) => {
            if (saved && href) leave(href)
            else setPendingHref(null)
          })
        }}
      />
    </div>
  )
}
