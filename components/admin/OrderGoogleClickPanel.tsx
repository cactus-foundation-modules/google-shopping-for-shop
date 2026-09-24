import { getSessionFromCookie } from '@/lib/auth/session'
import { hasShopPermission } from '@/modules/shop/lib/access'
import { readAttributedOrder } from '@/modules/google-shopping-for-shop/lib/click-tracking/report'
import { formatDuration } from '@/modules/google-shopping-for-shop/components/workbench/reports/duration'

// "Where did this order come from?" - answered on the order itself.
//
// Contributed to shop's `shop.order-detail-panels` point, which hands us
// `orderId`, `orderNumber` and `orderStatus` and wraps nothing: a panel draws
// its own card, and renders NULL rather than an empty one when it has nothing
// to say about the order it is looking at.
//
// Why it exists when the Reports tab already shows this. The Reports tab
// answers "which of my Google listings are earning their keep", which an owner
// asks occasionally and deliberately. This answers "where did THIS one come
// from", which they ask while already looking at an order - and until this
// existed the only way to find out was to open Reports, pick the right dates
// and hunt for the order number in a list of recent landings.
//
// Silent on the overwhelming majority of orders, which is correct: an order
// that did not come from Google, and an order from a visitor who declined
// marketing cookies, both have nothing recorded against them. One row read by
// primary key settles it, which is what an order screen can afford.
//
// A server component, per the point's contract. The permission is checked here
// as well as on the manifest entry: the host does honour that entry, but a
// component that renders whatever it is handed is one refactor away from
// appearing on a screen it should never reach.
//
// UNDER components/admin/ DELIBERATELY, and it must stay there. That directory
// name is what scripts/generate-module-extension-points.mjs reads to withhold an
// entry from the PUBLIC extension-point map (isAdminOnly). This file reaches
// prisma through readAttributedOrder and the session through getSessionFromCookie,
// so a copy of it sitting anywhere else is emitted into the map a client bundle
// may import - which is how a homepage ends up carrying the database client.
// Moving it up one directory looks like tidying and is not.

const SOURCE_LABEL = { free: 'a free Google listing', paid: 'a paid Google ad' } as const

export async function OrderGoogleClickPanel({ orderId }: { orderId: string; orderNumber: string; orderStatus: string }) {
  const user = await getSessionFromCookie()
  if (!user) return null
  // Read-only, so shop.access alone is enough - the same bar the rest of this
  // module's read screens are held to.
  if (!await hasShopPermission(user, 'shop.orders', { allowAccess: true })) return null

  const view = await readAttributedOrder(orderId)
  if (!view) return null

  const landed = view.click.variantName
    ? `${view.click.productName} - ${view.click.variantName}`
    : view.click.productName
  // Said only where it is true, and worth saying: an advert that sold something
  // else is still a sale, and it is the thing an owner reading only the total
  // would never notice.
  const boughtSomethingElse = view.boughtItems.some(
    (item) => item.productId && item.productId !== view.click.productId && item.productId !== view.click.variantId,
  )

  return (
    <section className="sox-card">
      <div className="sox-card-head"><h2>Came from Google</h2></div>
      <div className="sox-card-body" style={{ display: 'grid', gap: '0.5rem' }}>
        <p style={{ margin: 0 }}>
          This customer arrived from <strong>{SOURCE_LABEL[view.click.source]}</strong>, landing on{' '}
          <strong>{landed}</strong>, and ordered {formatDuration(view.secondsToPurchase)} later.
        </p>
        {boughtSomethingElse && (
          <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
            What they bought is not what they landed on - the listing brought them in and they chose something else once
            they were here.
          </p>
        )}
        {view.confirmedAt === null && (
          <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
            Not counted towards the Google figures yet: those only include orders whose payment has settled.
          </p>
        )}
        <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
          This site&apos;s own record of the visit, not Google&apos;s - the two never match exactly. Only visitors who agreed
          to marketing cookies can be traced back this way, so an order with nothing here may still have come from Google.
        </p>
      </div>
    </section>
  )
}
