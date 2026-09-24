// The `shop.order-paid` observer: the money actually arrived.
//
// Why this exists at all when the confirmation page already says a sale
// happened. The page says it the moment the shopper sees it, which on a card is
// usually a moment BEFORE the payment settles and on a bank transfer can be
// days before. Taking the page's word for the revenue would put money on the
// Reports tab that no bank has moved. So the page joins the order to its
// landing, and this - which shop fires exactly once per order, however the
// money came in - is what says the money is real and how much of it there was.
//
// Either may be first and neither assumes it went first: the page confirms the
// figure itself where the order is already paid, and this fills it in where it
// is not.
//
// An observer, in shop's own sense of the word: nothing it returns is stored,
// nothing waits on it, and a bad day here cannot cost a shopper their order.
import type { OrderPaidEvent } from '@/modules/shop/lib/order-paid-hooks'
import { getOrderById } from '@/modules/shop/lib/db/orders'
import { confirmAttributedOrder, hasPendingAttribution } from '@/modules/google-shopping-for-shop/lib/click-tracking/store'

export async function googleShoppingOrderPaid(event: OrderPaidEvent): Promise<void> {
  // One primary-key lookup, and for nearly every order on nearly every shop
  // that is the whole cost of this module being installed. No settings read
  // either: an attribution written while tracking was on is still a real sale,
  // and leaving it for ever pending because somebody turned the switch off
  // afterwards would be a figure that is wrong rather than absent.
  if (!await hasPendingAttribution(event.orderId)) return

  const order = await getOrderById(event.orderId)
  if (!order) return

  await confirmAttributedOrder({
    orderId: order.id,
    // The shop's own stored total. Never a figure from a browser, and never one
    // re-derived here: a report that disagreed with the order page about what
    // an order was worth would be worse than no report.
    value: order.total,
    currency: order.currency,
    confirmedAt: new Date(),
  })
}
