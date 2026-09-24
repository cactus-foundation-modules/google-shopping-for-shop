// Turning a delivery charge into the figure a shopper actually pays.
//
// Merchant Center holds one gross figure per rate group. This site holds its
// delivery prices on whatever side of tax it holds its product prices on, and
// the product feed converts them with displayAmount and the default zone's
// rates (see collectFeedItems). The same conversion is used here, from the
// same helper, or the delivery rates sent to Google would not agree with the
// prices sent beside them.
//
// One thing a delivery charge has that a product price does not: no tax class.
// A charge is folded into whichever line it is attached to and taxed at that
// product's own rate, so a shop with products on two rates has no single right
// answer. The HIGHEST rate in the default zone is used, and the owner is told.
// The reason it is the highest rather than an average: under-quoting delivery
// at Google is the thing Google penalises, and over-quoting by a couple of
// pence on a zero-rated product is not.
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { getDefaultTaxZoneId, listTaxZoneRates } from '@/modules/shop/lib/db/tax-shipping'
import { displayAmount, type PriceDisplay } from '@/modules/shop/lib/tax-display-shared'

export type DeliveryPricing = {
  /** Shop currency, for the payload. */
  currency: string
  /** NET in, gross out. The identity on a shop that stores gross prices. */
  grossUp: (net: number) => number
  /** The rate used, as a fraction. 0 where nothing needed converting. */
  rateUsed: number
  /** True where the shop has products on more than one tax rate, so the
   *  conversion above is an approximation the owner should know about. */
  ratesDiffer: boolean
}

export async function resolveDeliveryPricing(): Promise<DeliveryPricing> {
  const config = await getShopConfigCached()
  // Forced INCLUSIVE for the same reason the feed forces it: Google wants the
  // price a shopper pays, whatever the storefront happens to print.
  const display: PriceDisplay = { mode: 'INCLUSIVE', storedIncludesTax: config.taxMode === 'INCLUSIVE', suffix: '' }

  if (display.storedIncludesTax) {
    return {
      currency: config.currency,
      grossUp: (net) => Math.round(net * 100) / 100,
      rateUsed: 0,
      ratesDiffer: false,
    }
  }

  const rates: number[] = []
  const zoneId = await getDefaultTaxZoneId()
  if (zoneId) {
    for (const rate of await listTaxZoneRates(zoneId)) {
      const value = Number(rate.rate)
      if (Number.isFinite(value)) rates.push(value)
    }
  }
  const rateUsed = rates.length > 0 ? Math.max(...rates) : 0
  const ratesDiffer = new Set(rates).size > 1

  return {
    currency: config.currency,
    grossUp: (net) => Math.round(displayAmount(net, display, rateUsed) * 100) / 100,
    rateUsed,
    ratesDiffer,
  }
}
