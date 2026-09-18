'use client'

// The workbench list's request lifecycle, owned in one place.
//
// - The query lives in the address bar, so a reload or a shared link opens the
//   same list.
// - Typing is debounced; every other change asks at once.
// - Only the newest request may land: a change aborts the one in flight, so a
//   slow answer to an old search can never overwrite a newer one.
// - Loading is state the screen can show - what is happening and for how long -
//   rather than a page that looks frozen until the results arrive.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  DEFAULT_WORKBENCH_QUERY,
  parseWorkbenchQuery,
  writeWorkbenchQuery,
  type WorkbenchQuery,
} from '@/modules/google-shopping-for-shop/lib/workbench-query'
import type { WorkbenchSummary } from '@/modules/google-shopping-for-shop/lib/workbench-view'
import { fetchList, type ListResponse } from '@/modules/google-shopping-for-shop/components/workbench/api'
import { useElapsedSeconds } from '@/modules/google-shopping-for-shop/components/workbench/use-elapsed-seconds'

const SEARCH_DEBOUNCE_MS = 300

export type ListPhase = 'loading' | 'ready' | 'error'

/** What the request in flight is for, so the status line can say so. */
export type ListActivity = 'first' | 'search' | 'filter' | 'page' | 'reload' | 'reread'

export type WorkbenchList = {
  query: WorkbenchQuery
  /** The search box's text, which runs ahead of `query.search` while typing. */
  searchInput: string
  setSearchInput: (value: string) => void
  /** Applies the typed search straight away (Enter). */
  applySearchNow: () => void
  /** True while typed text is waiting out the debounce. */
  searchPending: boolean
  /** Merges a change into the query. Anything but a page change goes back to page one. */
  updateQuery: (patch: Partial<WorkbenchQuery>) => void
  /** Clears every filter, keeping sort order and page size. */
  resetFilters: () => void
  reload: (options?: { reread?: boolean }) => void
  data: ListResponse | null
  summary: WorkbenchSummary | null
  phase: ListPhase
  activity: ListActivity
  error: string
  /** Seconds the request in flight has taken so far; null when idle. */
  elapsedSeconds: number | null
}

function sameQuery(a: WorkbenchQuery, b: WorkbenchQuery): boolean {
  return (Object.keys(a) as Array<keyof WorkbenchQuery>).every((key) => a[key] === b[key])
}

function activityFor(patch: Partial<WorkbenchQuery>): ListActivity {
  const keys = Object.keys(patch)
  if (keys.length === 1 && keys[0] === 'page') return 'page'
  if (keys.length === 1 && keys[0] === 'search') return 'search'
  return 'filter'
}

export function useWorkbenchList(): WorkbenchList {
  const searchParams = useSearchParams()
  const [query, setQuery] = useState<WorkbenchQuery>(() => parseWorkbenchQuery(new URLSearchParams(searchParams.toString())))
  const [searchInput, setSearchInput] = useState(query.search)
  const [data, setData] = useState<ListResponse | null>(null)
  const [summary, setSummary] = useState<WorkbenchSummary | null>(null)
  const [phase, setPhase] = useState<ListPhase>('loading')
  const [activity, setActivity] = useState<ListActivity>('first')
  const [error, setError] = useState('')
  const [reloadCount, setReloadCount] = useState(0)
  // Bumped by every change that starts a request, so the elapsed timer restarts.
  const [requestNumber, setRequestNumber] = useState(0)

  // The summary key the browser holds, so the server can skip re-sending it,
  // and a one-shot "read the shop again" flag for the next request.
  const knownKeyRef = useRef('')
  const rereadRef = useRef(false)

  const startLoading = useCallback((next: ListActivity) => {
    setPhase('loading')
    setActivity(next)
    setRequestNumber((count) => count + 1)
  }, [])

  // The request itself. State is only ever set once it answers, and only if
  // no newer request has replaced it.
  useEffect(() => {
    const controller = new AbortController()
    const params = writeWorkbenchQuery(query, new URLSearchParams())
    if (knownKeyRef.current) params.set('known', knownKeyRef.current)
    if (rereadRef.current) params.set('reread', '1')
    rereadRef.current = false

    fetchList(params, controller.signal)
      .then((body) => {
        if (controller.signal.aborted) return
        if (body.summary) {
          knownKeyRef.current = body.key
          setSummary(body.summary)
        }
        setData(body)
        setError('')
        setPhase('ready')
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return
        setError(reason instanceof Error ? reason.message : 'Could not load the Google Shopping list')
        setPhase('error')
      })
    return () => controller.abort()
  }, [query, reloadCount])

  // Keep the address bar in step, leaving the host page's own parameters alone.
  useEffect(() => {
    const params = writeWorkbenchQuery(query, new URLSearchParams(window.location.search))
    const search = params.toString()
    const next = `${window.location.pathname}${search ? `?${search}` : ''}`
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, '', next)
  }, [query])

  // Debounced search: the typed text lands as a query change once the owner
  // pauses, not on every keystroke.
  useEffect(() => {
    const typed = searchInput.trim()
    if (typed === query.search) return
    const timer = setTimeout(() => {
      startLoading('search')
      setQuery((current) => ({ ...current, search: typed, page: 1 }))
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput, query.search, startLoading])

  const updateQuery = useCallback((patch: Partial<WorkbenchQuery>) => {
    const next: WorkbenchQuery = { ...query, ...patch, page: patch.page ?? 1 }
    if (sameQuery(next, query)) return
    if (patch.search !== undefined) setSearchInput(patch.search)
    startLoading(activityFor(patch))
    setQuery(next)
  }, [query, startLoading])

  const applySearchNow = useCallback(() => {
    updateQuery({ search: searchInput.trim() })
  }, [searchInput, updateQuery])

  const resetFilters = useCallback(() => {
    updateQuery({
      search: DEFAULT_WORKBENCH_QUERY.search,
      match: DEFAULT_WORKBENCH_QUERY.match,
      override: DEFAULT_WORKBENCH_QUERY.override,
      issue: DEFAULT_WORKBENCH_QUERY.issue,
      price: DEFAULT_WORKBENCH_QUERY.price,
      brand: DEFAULT_WORKBENCH_QUERY.brand,
      category: DEFAULT_WORKBENCH_QUERY.category,
      group: DEFAULT_WORKBENCH_QUERY.group,
    })
  }, [updateQuery])

  const reload = useCallback((options?: { reread?: boolean }) => {
    rereadRef.current = options?.reread ?? false
    startLoading(options?.reread ? 'reread' : 'reload')
    setReloadCount((count) => count + 1)
  }, [startLoading])

  const elapsedSeconds = useElapsedSeconds(phase === 'loading', requestNumber)

  return {
    query,
    searchInput,
    setSearchInput,
    applySearchNow,
    searchPending: searchInput.trim() !== query.search,
    updateQuery,
    resetFilters,
    reload,
    data,
    summary,
    phase,
    activity,
    error,
    elapsedSeconds,
  }
}
