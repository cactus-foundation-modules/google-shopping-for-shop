'use client'

// What the owner has picked for a bulk change: nothing, some rows by hand
// (kept across pages and searches, so a selection can be built up), or every
// row a query matches - thousands of items that were never on screen at once.
//
// A "whole query" selection belongs to the filters it was made under. Change a
// filter and it lapses rather than silently applying to a different list.
import { useCallback, useMemo, useState } from 'react'
import type { WorkbenchQuery } from '@/modules/google-shopping-for-shop/lib/workbench-query'
import type { BulkScope } from '@/modules/google-shopping-for-shop/components/workbench/api'

type StoredSelection =
  | { kind: 'ids'; ids: ReadonlySet<string> }
  | { kind: 'query'; query: WorkbenchQuery; total: number }

export type WorkbenchSelection = {
  count: number
  /** True when every row the current query matches is selected. */
  isWholeQuery: boolean
  isSelected: (id: string) => boolean
  toggle: (id: string, selected: boolean) => void
  setMany: (ids: string[], selected: boolean) => void
  selectWholeQuery: (total: number) => void
  clear: () => void
  /** The bulk scope to send, or null when nothing is selected. */
  scope: BulkScope | null
}

const NOTHING: StoredSelection = { kind: 'ids', ids: new Set() }

// Sort order, page and page size do not change which rows match.
function sameFilters(a: WorkbenchQuery, b: WorkbenchQuery): boolean {
  return a.search === b.search
    && a.match === b.match
    && a.override === b.override
    && a.issue === b.issue
    && a.price === b.price
    && a.brand === b.brand
    && a.category === b.category
    && a.group === b.group
}

export function useSelection(query: WorkbenchQuery): WorkbenchSelection {
  const [stored, setStored] = useState<StoredSelection>(NOTHING)

  // Derived rather than cleared by an effect: a lapsed whole-query selection
  // simply reads as nothing selected.
  const current: StoredSelection = stored.kind === 'query' && !sameFilters(stored.query, query) ? NOTHING : stored

  const toggle = useCallback((id: string, selected: boolean) => {
    setStored((previous) => {
      const ids = new Set(previous.kind === 'ids' ? previous.ids : [])
      if (selected) ids.add(id)
      else ids.delete(id)
      return { kind: 'ids', ids }
    })
  }, [])

  const setMany = useCallback((ids: string[], selected: boolean) => {
    setStored((previous) => {
      const next = new Set(previous.kind === 'ids' ? previous.ids : [])
      for (const id of ids) {
        if (selected) next.add(id)
        else next.delete(id)
      }
      return { kind: 'ids', ids: next }
    })
  }, [])

  const selectWholeQuery = useCallback((total: number) => {
    setStored({ kind: 'query', query, total })
  }, [query])

  const clear = useCallback(() => setStored(NOTHING), [])

  return useMemo(() => {
    const isWholeQuery = current.kind === 'query'
    return {
      count: current.kind === 'query' ? current.total : current.ids.size,
      isWholeQuery,
      isSelected: (id: string) => current.kind === 'query' || current.ids.has(id),
      toggle,
      setMany,
      selectWholeQuery,
      clear,
      scope: current.kind === 'query'
        ? { kind: 'query', query: current.query, expectedCount: current.total }
        : current.ids.size > 0 ? { kind: 'ids', ids: [...current.ids] } : null,
    }
  }, [current, toggle, setMany, selectWholeQuery, clear])
}
