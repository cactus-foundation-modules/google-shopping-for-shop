'use client'

// A callback whose identity never changes but which always runs the latest
// version of `handler`. Lets memoised table rows take handlers that read fresh
// state without every keystroke in one row re-rendering all the others.
import { useCallback, useLayoutEffect, useRef } from 'react'

export function useStableCallback<Args extends unknown[], Result>(handler: (...args: Args) => Result): (...args: Args) => Result {
  const latest = useRef(handler)
  useLayoutEffect(() => {
    latest.current = handler
  })
  return useCallback((...args: Args) => latest.current(...args), [])
}
