// Which workbench sub-tab a URL means, and what a chosen tab writes back.
// Pure, so the rules can be tested without a browser; the hook that applies
// them is sub-tabs.ts.
//
// The rules:
//  - A URL with a valid `sub` opens that tab.
//  - A URL with no `sub` at all opens Reports - unless it carries a products
//    list parameter, in which case it is a link written before the sub-tabs
//    existed, and it meant the products list.
//  - Once a tab has been clicked, `sub` is always written, Reports included.
//    Leaving it off for Reports meant the Products filters still sitting in
//    the address bar turned a refresh on Reports back into Products. Writing
//    it every time also leaves those filters where they are, so coming back to
//    Products finds the list as it was left.
import { hasWorkbenchParams } from '@/modules/google-shopping-for-shop/lib/workbench-query'

export const WORKBENCH_SUB_TABS = [
  { id: 'reports', label: 'Reports' },
  { id: 'products', label: 'Products' },
  { id: 'feed-rules', label: 'Feed rules' },
  // 'shipping' in the URL because that is what Merchant Center calls it; the
  // label is what the rest of this module calls it in front of an owner.
  { id: 'shipping', label: 'Delivery' },
  { id: 'health', label: 'Health' },
] as const

export type WorkbenchSubTab = (typeof WORKBENCH_SUB_TABS)[number]['id']

export const DEFAULT_SUB_TAB: WorkbenchSubTab = 'reports'

export const SUB_TAB_PARAM = 'sub'

const IDS: readonly string[] = WORKBENCH_SUB_TABS.map((tab) => tab.id)

export function isWorkbenchSubTab(value: unknown): value is WorkbenchSubTab {
  return typeof value === 'string' && IDS.includes(value)
}

/** The tab a URL opens on. */
export function subTabFromParams(params: URLSearchParams): WorkbenchSubTab {
  const wanted = params.get(SUB_TAB_PARAM)
  if (isWorkbenchSubTab(wanted)) return wanted
  // Only a URL with no `sub` at all is an old link. A `sub` that is present
  // but unrecognised is a typo or a tab from another version, and gets the
  // default like any other.
  if (wanted === null && hasWorkbenchParams(params)) return 'products'
  return DEFAULT_SUB_TAB
}

/** What a clicked tab writes to the address bar. Always the id - see above. */
export function subTabParamValue(tab: WorkbenchSubTab): string {
  return tab
}
