// Pure Google Merchant Center feed rendering: plain data in, RSS 2.0 XML with
// the g: namespace out. No database, no config - everything testable with
// fixtures. Attribute reference: Google Merchant Center product data
// specification (support.google.com/merchants/answer/7052112).

export type FeedAvailability = 'in_stock' | 'out_of_stock' | 'preorder' | 'backorder'

// One option on one variant, as a plain name/value pair: { name: "Finish",
// value: "Oak" }. Which Google axis (if any) it lands on is mapVariantAxes' job.
export type FeedOptionPair = { name: string; value: string }

/** One delivery service, as Google's repeatable `shipping` attribute wants it:
 *  a country, a name, a gross price and the days either side of dispatch. */
export type FeedShippingGroup = {
  /** ISO 3166-1 alpha-2. Google rejects a group without one. */
  country: string
  /** The service's name. Free text - it matches a Merchant Center service where
   *  one is named the same, and stands on its own where none is. */
  service: string
  /** Gross (VAT-inclusive) price in major units. Zero is meaningful: it is what
   *  tells Google the delivery is free. */
  price: number
  /** Working days either side of dispatch for THIS service, overriding the
   *  item-level pair for it. Sent as a range with both ends equal, same rule. */
  minHandlingTime?: number
  maxHandlingTime?: number
  minTransitTime?: number
  maxTransitTime?: number
}

export type FeedVariantAxes = {
  color?: string
  size?: string
  material?: string
  pattern?: string
}

export type FeedItem = {
  /** Product row id (the variant child's for a variation) - stable and opaque.
   *  Deliberately never a SKU: supplier codes are withheld from shoppers. */
  id: string
  /** Parent product id shared by every variation of one product; absent on a
   *  standalone item. */
  itemGroupId?: string
  title: string
  description: string
  link: string
  imageLinks: string[]
  availability: FeedAvailability
  /** The regular price, gross (VAT-inclusive), major units. */
  price: number
  /** The discounted price while an offer runs, gross. */
  salePrice?: number
  currency: string
  brand?: string
  gtin?: string
  mpn?: string
  /** false = tell Google this product genuinely has no GTIN/brand+MPN pair, so
   *  it is not held back waiting for identifiers it will never have. */
  identifierExists: boolean
  condition: 'new' | 'refurbished' | 'used'
  /** The shop's own category trail, e.g. "Office Furniture > Desks". */
  productType?: string
  /** A value from Google's product taxonomy, when the owner has set one. */
  googleProductCategory?: string
  /** e.g. "12.5 kg" - only when the weight and a Google-accepted unit exist. */
  shippingWeight?: string
  /** Working days from order to dispatch. Google wants a range; a shop quoting
   *  one figure sends it as both ends. Both are set together or neither is -
   *  Google rejects a half-stated range. */
  minHandlingTime?: number
  maxHandlingTime?: number
  /** Working days from dispatch to doorstep, same rule. Sent per item rather
   *  than left to the Merchant Center account, because a shop whose couriers
   *  differ by supplier or department has no single account-wide answer. */
  minTransitTime?: number
  maxTransitTime?: number
  /** ISO instant the item can first be dispatched. Google REQUIRES this on a
   *  pre-order or backorder item and ignores it on anything else, so it is only
   *  ever rendered alongside those two availabilities. */
  availabilityDate?: string
  /** The delivery services this item can be bought with. Google reads several
   *  and, where more than one reaches the shopper, quotes the cheapest - so the
   *  free option in the list is what a listing shows. Empty or absent leaves
   *  the Merchant Center account's own rates in charge, which is the default. */
  shippingGroups?: FeedShippingGroup[]
  axes?: FeedVariantAxes
}

export type FeedChannel = {
  title: string
  link: string
  description: string
}

const TITLE_MAX = 150
const DESCRIPTION_MAX = 5000

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function clip(value: string, max: number): string {
  const trimmed = value.trim()
  if (trimmed.length <= max) return trimmed
  // Cut on a word where one is near, so a clipped title does not end mid-word.
  const hard = trimmed.slice(0, max)
  const lastSpace = hard.lastIndexOf(' ')
  return (lastSpace > max - 30 ? hard.slice(0, lastSpace) : hard).trimEnd()
}

/** Sorts each option onto the Google variant axis its name suggests. First
 *  match per axis wins (a product with Seat Colour and Frame Colour keeps Seat
 *  Colour as g:color); options matching nothing stay off the axes and live in
 *  the item title instead, which already carries the full variant label.
 *  Several size-like options join as one size ("1200mm x 800mm") because Google
 *  has a single size field and furniture rarely fits a small/medium/large. */
export function mapVariantAxes(pairs: FeedOptionPair[]): FeedVariantAxes {
  const axes: FeedVariantAxes = {}
  const sizes: string[] = []
  for (const pair of pairs) {
    const name = pair.name.toLowerCase()
    const value = pair.value.trim()
    if (!value) continue
    if (/colou?r|fabric|upholstery/.test(name)) {
      if (!axes.color) axes.color = value
    } else if (/\b(width|height|depth|length|size|seat)\b/.test(name)) {
      sizes.push(value)
    } else if (/material|finish|frame|wood|top/.test(name)) {
      if (!axes.material) axes.material = value
    } else if (/pattern|grain/.test(name)) {
      if (!axes.pattern) axes.pattern = value
    }
  }
  if (sizes.length > 0) axes.size = sizes.join(' x ')
  return axes
}

function money(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`
}

const AVAILABILITY_LABEL: Record<FeedAvailability, string> = {
  in_stock: 'in stock',
  out_of_stock: 'out of stock',
  preorder: 'preorder',
  backorder: 'backorder',
}

function tag(name: string, value: string | undefined): string {
  return value === undefined || value === '' ? '' : `\n      <${name}>${escapeXml(value)}</${name}>`
}

// A half-stated range is worse than none: Google rejects min without max. So
// each pair is rendered only when both ends are whole non-negative numbers, and
// a product the shop cannot put a time on sends neither and inherits whatever
// the Merchant Center account says.
function handlingAndTransit(item: FeedItem): string[] {
  const pair = (minName: string, maxName: string, min: number | undefined, max: number | undefined): string[] => {
    const usable = (n: number | undefined): n is number => n !== undefined && Number.isInteger(n) && n >= 0
    if (!usable(min) || !usable(max)) return []
    return [tag(minName, String(min)), tag(maxName, String(max))]
  }
  return [
    ...pair('g:min_handling_time', 'g:max_handling_time', item.minHandlingTime, item.maxHandlingTime),
    ...pair('g:min_transit_time', 'g:max_transit_time', item.minTransitTime, item.maxTransitTime),
  ]
}

// One `g:shipping` block per service. Country and price are the two Google
// insists on; the day counts ride along where the shop knows them, and a group
// missing them falls back to the item-level pair rendered above.
function shippingGroups(item: FeedItem, currency: string): string[] {
  const usable = (n: number | undefined): n is number => n !== undefined && Number.isInteger(n) && n >= 0
  const range = (minName: string, maxName: string, min: number | undefined, max: number | undefined): string =>
    usable(min) && usable(max) ? `<${minName}>${min}</${minName}><${maxName}>${max}</${maxName}>` : ''
  const inner = (name: string, value: string): string => `<${name}>${escapeXml(value)}</${name}>`
  return (item.shippingGroups ?? [])
    .filter((group) => /^[A-Za-z]{2}$/.test(group.country) && group.service.trim() !== '' && Number.isFinite(group.price) && group.price >= 0)
    .map((group) => {
      const body = [
        inner('g:country', group.country.toUpperCase()),
        inner('g:service', group.service.trim()),
        inner('g:price', money(group.price, currency)),
        range('g:min_handling_time', 'g:max_handling_time', group.minHandlingTime, group.maxHandlingTime),
        range('g:min_transit_time', 'g:max_transit_time', group.minTransitTime, group.maxTransitTime),
      ].join('')
      return `\n      <g:shipping>${body}</g:shipping>`
    })
}

function renderItem(item: FeedItem): string {
  const [primary, ...rest] = item.imageLinks
  const parts = [
    tag('g:id', item.id),
    tag('g:item_group_id', item.itemGroupId),
    tag('g:title', clip(item.title, TITLE_MAX)),
    tag('g:description', clip(item.description, DESCRIPTION_MAX)),
    tag('g:link', item.link),
    tag('g:image_link', primary),
    // Google accepts at most ten additional images per item.
    ...rest.slice(0, 10).map((url) => tag('g:additional_image_link', url)),
    tag('g:availability', AVAILABILITY_LABEL[item.availability]),
    tag('g:price', money(item.price, item.currency)),
    item.salePrice !== undefined ? tag('g:sale_price', money(item.salePrice, item.currency)) : '',
    tag('g:brand', item.brand),
    tag('g:gtin', item.gtin),
    tag('g:mpn', item.mpn),
    item.identifierExists ? '' : tag('g:identifier_exists', 'no'),
    tag('g:condition', item.condition),
    tag('g:product_type', item.productType),
    tag('g:google_product_category', item.googleProductCategory),
    tag('g:shipping_weight', item.shippingWeight),
    ...handlingAndTransit(item),
    ...shippingGroups(item, item.currency),
    // Only meaningful on the two availabilities where the shop has not got the
    // thing yet; Google disapproves a pre-order item that omits it.
    item.availability === 'preorder' || item.availability === 'backorder'
      ? tag('g:availability_date', item.availabilityDate)
      : '',
    tag('g:color', item.axes?.color),
    tag('g:size', item.axes?.size),
    tag('g:material', item.axes?.material),
    tag('g:pattern', item.axes?.pattern),
  ]
  return `\n    <item>${parts.join('')}\n    </item>`
}

export function buildFeedXml(channel: FeedChannel, items: FeedItem[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${escapeXml(channel.title)}</title>
    <link>${escapeXml(channel.link)}</link>
    <description>${escapeXml(channel.description)}</description>${items.map(renderItem).join('')}
  </channel>
</rss>
`
}

/** A GTIN Google will take: 8/12/13/14 digits (EAN-8, UPC-A, EAN-13, GTIN-14),
 *  ignoring any spaces or dashes a supplier sheet left in. Returns the cleaned
 *  digits, or null for anything else - a malformed GTIN is worse than none, as
 *  Google disapproves the item rather than shrugging. */
export function normaliseGtin(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = raw.replace(/[\s-]/g, '')
  return /^(\d{8}|\d{12,14})$/.test(digits) ? digits : null
}
