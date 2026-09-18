'use client'

// Unsaved title template edits, kept by item id so they survive paging and
// searching: an owner can work down several pages and save the lot at once.
// An edit typed back to what is saved stops being an edit.
import { useCallback, useMemo, useState } from 'react'

export type TitleDrafts = {
  /** The text the row's editor shows: the edit if there is one, else what is saved. */
  valueFor: (id: string, saved: string | null) => string
  isDirty: (id: string) => boolean
  set: (id: string, value: string, saved: string | null) => void
  discard: (ids: string[]) => void
  discardAll: () => void
  /** Every edit, as the save route takes them: blank means "no template". */
  updates: (ids?: string[]) => Array<{ itemId: string; titleTemplate: string | null }>
  count: number
}

export function useTitleDrafts(): TitleDrafts {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(new Map())

  const set = useCallback((id: string, value: string, saved: string | null) => {
    setDrafts((previous) => {
      const next = new Map(previous)
      if (value.trim() === (saved ?? '')) next.delete(id)
      else next.set(id, value)
      return next
    })
  }, [])

  const discard = useCallback((ids: string[]) => {
    setDrafts((previous) => {
      const next = new Map(previous)
      for (const id of ids) next.delete(id)
      return next
    })
  }, [])

  const discardAll = useCallback(() => setDrafts(new Map()), [])

  return useMemo(() => ({
    valueFor: (id: string, saved: string | null) => drafts.get(id) ?? saved ?? '',
    isDirty: (id: string) => drafts.has(id),
    set,
    discard,
    discardAll,
    updates: (ids?: string[]) => {
      const wanted = ids ?? [...drafts.keys()]
      return wanted
        .filter((id) => drafts.has(id))
        .map((id) => ({ itemId: id, titleTemplate: drafts.get(id)?.trim() || null }))
    },
    count: drafts.size,
  }), [drafts, set, discard, discardAll])
}
