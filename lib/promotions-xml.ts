// Pure Google Merchant Center PROMOTIONS rendering: plain data in, RSS 2.0 XML
// with the g: namespace out. No database, no config - everything testable with
// fixtures, exactly as lib/feed-xml.ts is for the product source. Attribute
// reference: Google Merchant Center promotions data specification
// (support.google.com/merchants/answer/2906014).

/** One promotion, already reduced to the figures Google takes. Every amount is
 *  gross (VAT-inclusive) and in major units, because that is what Google quotes
 *  a UK shopper. */
export type FeedPromotion = {
  /** Stable across runs and unique in the source. Products join a promotion by
   *  carrying this same string in the PRODUCT source's promotion_id, which is
   *  the only mapping that scales past the twenty items the item_id filter
   *  allows. */
  id: string
  /** What the shopper is told the offer is. Google allows 60 characters. */
  longTitle: string
  /** Money off, gross. */
  moneyOff: number
  /** What the basket has to reach before it applies, gross. */
  minimumPurchase: number
  currency: string
  /** Terms and conditions, shown to shoppers. Google allows 500 characters. */
  finePrint?: string
  /** The window the promotion runs for. Google caps a promotion at 183 days, so
   *  a standing offer is served as a rolling window that each fetch renews. */
  startsAt: Date
  endsAt: Date
}

const LONG_TITLE_MAX = 60
const FINE_PRINT_MAX = 500

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function clip(value: string, max: number): string {
  const trimmed = value.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= max) return trimmed
  const hard = trimmed.slice(0, max)
  const lastSpace = hard.lastIndexOf(' ')
  return (lastSpace > max - 30 ? hard.slice(0, lastSpace) : hard).trimEnd()
}

/** "420.00 GBP" - the number first, the code after, same as the product source.
 *  Worth stating because Google's own promotions examples are written both ways
 *  round in different places and only this one is accepted. */
function money(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`
}

/** Google's own example is written with an explicit offset rather than a Z, so
 *  the offset is what goes out - the same instant either way, but there is no
 *  benefit in being the first source to find out whether their parser minds. */
function instant(date: Date): string {
  return `${date.toISOString().replace(/\.\d{3}Z$/, '')}+00:00`
}

function tag(name: string, value: string | undefined): string {
  return value === undefined || value === '' ? '' : `\n      <${name}>${escapeXml(value)}</${name}>`
}

function renderPromotion(promotion: FeedPromotion): string {
  const parts = [
    tag('g:promotion_id', promotion.id),
    // Always specific_products: the offer is mapped item by item from the
    // product source, never applied to a whole catalogue.
    tag('g:product_applicability', 'specific_products'),
    tag('g:offer_type', 'no_code'),
    tag('g:long_title', clip(promotion.longTitle, LONG_TITLE_MAX)),
    tag('g:promotion_effective_dates', `${instant(promotion.startsAt)}/${instant(promotion.endsAt)}`),
    tag('g:redemption_channel', 'online'),
    // Both the paid and the unpaid surface: a shop advertising an offer has no
    // reason to hide it from whichever of the two it happens to appear on.
    tag('g:promotion_destination', 'shopping_ads'),
    tag('g:promotion_destination', 'free_listings'),
    tag('g:coupon_value_type', 'money_off'),
    tag('g:money_off_amount', money(promotion.moneyOff, promotion.currency)),
    tag('g:minimum_purchase_amount', money(promotion.minimumPurchase, promotion.currency)),
    tag('g:fine_print', promotion.finePrint ? clip(promotion.finePrint, FINE_PRINT_MAX) : undefined),
  ]
  return `\n    <item>${parts.join('')}\n    </item>`
}

export type PromotionChannel = {
  title: string
  link: string
  description: string
}

export function buildPromotionsXml(channel: PromotionChannel, promotions: FeedPromotion[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${escapeXml(channel.title)}</title>
    <link>${escapeXml(channel.link)}</link>
    <description>${escapeXml(channel.description)}</description>${promotions.map(renderPromotion).join('')}
  </channel>
</rss>
`
}
