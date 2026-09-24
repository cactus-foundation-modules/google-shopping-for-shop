'use client'

// Which part of the Google Shopping workbench is open, kept in the address bar.
//
// The host page (shop's Products screen) owns `tab`, so this one is `sub`:
//   ?tab=google-shopping-workbench&sub=shipping
// The rules for reading and writing it are in sub-tab-url.ts.
//
// Same pattern as shop's own settings sub-tabs, and built on the same
// primitives (modules/shop/lib/admin/tab-url.ts): read the URL once on mount
// rather than during a render, because the screen is server-rendered first and
// reading the location mid-render would have the two disagree; write with
// replaceState, because this is bookkeeping about where you already are and the
// back button should leave the screen rather than walk back through every tab
// that got poked at.
import { useCallback, useEffect, useState } from 'react'
import { setTabParams } from '@/modules/shop/lib/admin/tab-url'
import {
  DEFAULT_SUB_TAB,
  SUB_TAB_PARAM,
  subTabFromParams,
  subTabParamValue,
  type WorkbenchSubTab,
} from '@/modules/google-shopping-for-shop/components/workbench/sub-tab-url'

export { WORKBENCH_SUB_TABS, type WorkbenchSubTab } from '@/modules/google-shopping-for-shop/components/workbench/sub-tab-url'

export function useWorkbenchSubTab() {
  const [tab, setTab] = useState<WorkbenchSubTab>(DEFAULT_SUB_TAB)

  useEffect(() => {
    const opened = subTabFromParams(new URLSearchParams(window.location.search))
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot read of the URL on mount
    if (opened !== DEFAULT_SUB_TAB) setTab(opened)
  }, [])

  const selectTab = useCallback((next: WorkbenchSubTab) => {
    setTab(next)
    setTabParams({ [SUB_TAB_PARAM]: subTabParamValue(next) })
  }, [])

  return [tab, selectTab] as const
}
