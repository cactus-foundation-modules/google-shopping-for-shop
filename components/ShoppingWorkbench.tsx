'use client'

// Shop -> Products -> Google Shopping.
//
// The workbench started as one screen - the product list - and is growing into
// five: what Google reports back, the products themselves, the rules that
// decide what gets sent, the delivery settings held at Merchant Center, and
// whatever Google is unhappy about. This file is the tab strip and nothing
// else; each sub-tab owns its own screen, its own fetches and its own state.
//
// The open tab lives in the address bar as `sub`, because the host page already
// owns `tab` (components/workbench/sub-tabs.ts).
import { TabStrip } from '@/components/admin/TabStrip'
import { ProductsTab } from '@/modules/google-shopping-for-shop/components/workbench/ProductsTab'
import { ReportsTab } from '@/modules/google-shopping-for-shop/components/workbench/reports/ReportsTab'
import { FeedRulesTab } from '@/modules/google-shopping-for-shop/components/workbench/feed-rules/FeedRulesTab'
import { HealthTab } from '@/modules/google-shopping-for-shop/components/workbench/health/HealthTab'
import { DeliveryTab } from '@/modules/google-shopping-for-shop/components/workbench/delivery/DeliveryTab'
import { WORKBENCH_SUB_TABS, useWorkbenchSubTab } from '@/modules/google-shopping-for-shop/components/workbench/sub-tabs'
import { DEFAULT_WORKBENCH_QUERY, writeWorkbenchQuery } from '@/modules/google-shopping-for-shop/lib/workbench-query'

export function GoogleShoppingWorkbench() {
  const [sub, setSub] = useWorkbenchSubTab()

  // "Show them" on a rule: the products list, narrowed to what the rule
  // matches, in or out of the feed. Written to the address bar before the tab
  // opens, because the list reads its query from there when it mounts. The
  // other list filters are cleared, or a search left over from earlier would
  // hide half of what the rule catches.
  const showRuleProducts = (ruleId: string) => {
    const url = new URL(window.location.href)
    writeWorkbenchQuery({ ...DEFAULT_WORKBENCH_QUERY, feed: 'all', rule: ruleId }, url.searchParams)
    window.history.replaceState(null, '', url)
    setSub('products')
  }

  // "Open in Products" on one of Google's reasons: the products list, narrowed
  // to the items that reason is open against, in or out of the feed. Written
  // to the address bar first, because the list reads its query from there when
  // it mounts.
  const showIssueProducts = (code: string) => {
    const url = new URL(window.location.href)
    writeWorkbenchQuery({ ...DEFAULT_WORKBENCH_QUERY, feed: 'all', googleCode: code }, url.searchParams)
    window.history.replaceState(null, '', url)
    setSub('products')
  }

  return (
    <div>
      <TabStrip
        items={WORKBENCH_SUB_TABS.map((tab) => ({
          key: tab.id,
          label: tab.label,
          active: sub === tab.id,
          onClick: () => setSub(tab.id),
        }))}
      />

      {/* Mounted one at a time on purpose: the products list holds a whole
          catalogue page, its unsaved title edits and an in-flight request, and
          none of that should carry on running behind a tab nobody is looking
          at. */}
      {sub === 'products' && <ProductsTab />}

      {sub === 'reports' && <ReportsTab />}

      {sub === 'feed-rules' && <FeedRulesTab onShowProducts={showRuleProducts} />}

      {sub === 'shipping' && <DeliveryTab />}

      {sub === 'health' && <HealthTab onShowProducts={showIssueProducts} />}
    </div>
  )
}
