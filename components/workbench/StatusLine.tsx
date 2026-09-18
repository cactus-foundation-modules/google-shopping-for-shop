'use client'

// The line between the filters and the table that always says what the list is
// doing: searching, how long it has been at it, and - when a wait runs long -
// why. A bar across the top of the results moves for as long as anything is
// in flight, so a slow answer reads as work, not as a hang.
import type { ReactNode } from 'react'
import type { ListActivity, ListPhase } from '@/modules/google-shopping-for-shop/components/workbench/use-workbench-list'
import { formatCount, plural } from '@/modules/google-shopping-for-shop/components/workbench/format'

type Props = {
  phase: ListPhase
  activity: ListActivity
  /** Typed text waiting out the debounce. */
  searchPending: boolean
  elapsedSeconds: number | null
  /** Items in the whole feed, when known. */
  catalogueItems: number | null
  targetPage: number
  result: { total: number; page: number; pageCount: number; serverMs: number } | null
  filtered: boolean
}

// Past this, a wait gets an explanation as well as a timer.
const SLOW_AFTER_SECONDS = 2

function workingText(activity: ListActivity, items: string, page: number): string {
  switch (activity) {
    case 'first': return 'Reading the catalogue…'
    case 'reread': return 'Reading the shop again for the latest prices and names…'
    case 'search': return `Searching ${items}…`
    case 'filter': return `Filtering ${items}…`
    case 'page': return `Loading page ${formatCount(page)}…`
    case 'reload': return 'Refreshing the list…'
  }
}

function slowText(activity: ListActivity): string {
  if (activity === 'first' || activity === 'reread') {
    return 'The first look builds the whole Google feed, which takes a few seconds on a big catalogue. Searches and filters after that are quick.'
  }
  return 'Still working - the catalogue is being read afresh on the server, which takes a few seconds. It will be quick again straight after.'
}

export function StatusLine({ phase, activity, searchPending, elapsedSeconds, catalogueItems, targetPage, result, filtered }: Props) {
  const busy = phase === 'loading' || searchPending
  const items = catalogueItems !== null ? plural(catalogueItems, 'item') : 'the catalogue'
  const slow = phase === 'loading' && elapsedSeconds !== null && elapsedSeconds >= SLOW_AFTER_SECONDS

  let text: ReactNode = null
  if (searchPending && phase !== 'loading') {
    text = `Searching ${items}…`
  } else if (phase === 'loading') {
    text = (
      <>
        {workingText(activity, items, targetPage)}
        {elapsedSeconds !== null && elapsedSeconds >= 1 && <span className="gsw-nowrap"> {elapsedSeconds}s</span>}
      </>
    )
  } else if (result) {
    text = (
      <>
        <strong>{formatCount(result.total)}</strong>
        {filtered ? ` matching ${result.total === 1 ? 'item' : 'items'}` : ` ${result.total === 1 ? 'item' : 'items'} in the feed`}
        {result.pageCount > 1 && ` · page ${formatCount(result.page)} of ${formatCount(result.pageCount)}`}
        <span className="gsw-muted"> · answered in {(result.serverMs / 1000).toFixed(2)}s</span>
      </>
    )
  }

  return (
    <div>
      <div className={`gsw-progress${busy ? ' is-on' : ''}`} aria-hidden />
      <div className="gsw-status" role="status" aria-live="polite">
        {busy && <span className="gsw-spinner" aria-hidden />}
        <span>{text}</span>
        {slow && <span className="gsw-status-slow">{slowText(activity)}</span>}
      </div>
    </div>
  )
}
