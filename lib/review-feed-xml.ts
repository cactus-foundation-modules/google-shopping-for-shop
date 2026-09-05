// Pure Google product review feed rendering: plain data in, XML out. No
// database, no config - everything testable with fixtures, the same division of
// labour as lib/feed-xml.ts.
//
// The document shape is version 2.3 of Google's product reviews schema, read
// off the XSD itself (google.com/shopping/reviews/schema/product/2.3/
// product_reviews.xsd) rather than off a blog post. Two things it is strict
// about, and both fail the whole file rather than one review:
//
//   1. ELEMENT ORDER. Every complexType in that schema is an xs:sequence, so
//      <title> after <content>, or <ratings> before <review_url>, is invalid -
//      even though every element is present and correct. The order below is the
//      schema's order and must stay that way.
//   2. EMPTY ELEMENTS. Most string fields are nonEmptyStringType, which a
//      self-closing or whitespace-only tag does not satisfy. So an absent value
//      leaves the element out entirely rather than writing an empty one.

export type ReviewFeedProduct = {
  /** Absolute URL of the product's own page. Required. */
  url: string
  name?: string
  gtins?: string[]
  mpns?: string[]
  brands?: string[]
}

export type ReviewFeedItem = {
  /** Permanent, unique id for this review in the shop's own system. */
  id: string
  /** The reviewer's name. Empty renders as anonymous, which is what the schema's
   *  is_anonymous attribute is for. */
  authorName: string
  /** ISO instant the review went live. */
  timestamp: string
  title?: string
  content: string
  /** Where the review can be read. `group` says the page carries a set of
   *  reviews including this one, which a product page does; `singleton` says the
   *  page is this review alone. */
  url: string
  urlType: 'singleton' | 'group'
  rating: number
  ratingMin: number
  ratingMax: number
  products: ReviewFeedProduct[]
  /** Whether the shop asked for this review after fulfilling the order, or it
   *  arrived unprompted. Left off where the shop cannot say. */
  collectionMethod?: 'unsolicited' | 'post_fulfillment'
  /** The order the review came from, where one is known. Google uses it to tie
   *  several reviews of one order together. */
  transactionId?: string
}

export type ReviewFeedPublisher = {
  name: string
  /** Absolute URL of a 16x16 GIF, JPG or PNG. Left off when the site has none. */
  faviconUrl?: string
}

const TITLE_MAX = 150
const CONTENT_MAX = 10000

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function clean(value: string): string {
  // Tab, newline and carriage return are legal XML and worth keeping - a review
  // written in paragraphs should stay in paragraphs. The rest of the C0 range
  // is not legal in XML 1.0 at all, and one of them in one review takes down the
  // whole document at Google's end rather than the review that carried it.
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').trim()
}

function clip(value: string, max: number): string {
  const trimmed = clean(value)
  if (trimmed.length <= max) return trimmed
  const hard = trimmed.slice(0, max)
  const lastSpace = hard.lastIndexOf(' ')
  return (lastSpace > max - 40 ? hard.slice(0, lastSpace) : hard).trimEnd()
}

function tag(name: string, value: string | undefined, indent: string): string {
  const text = value === undefined ? '' : clean(value)
  return text === '' ? '' : `\n${indent}<${name}>${escapeXml(text)}</${name}>`
}

// A list container ("gtins" holding "gtin" elements), or nothing at all when the
// shop knows none: an empty container satisfies no part of the schema and only
// tells Google that something went missing.
function idList(container: string, item: string, values: string[] | undefined, indent: string): string {
  const kept = (values ?? []).map(clean).filter((v) => v !== '')
  if (kept.length === 0) return ''
  const inner = kept.map((v) => `\n${indent}  <${item}>${escapeXml(v)}</${item}>`).join('')
  return `\n${indent}<${container}>${inner}\n${indent}</${container}>`
}

function renderProduct(product: ReviewFeedProduct): string {
  const ids = [
    idList('gtins', 'gtin', product.gtins, '            '),
    idList('mpns', 'mpn', product.mpns, '            '),
    idList('brands', 'brand', product.brands, '            '),
  ].join('')
  // product_ids first, then the name, then the URL - the schema's order.
  const idsBlock = ids === '' ? '' : `\n          <product_ids>${ids}\n          </product_ids>`
  return [
    `\n        <product>`,
    idsBlock,
    tag('product_name', product.name, '          '),
    tag('product_url', product.url, '          '),
    `\n        </product>`,
  ].join('')
}

// The rating, as a number Google will accept. Whole where the shop rates in
// whole stars, one decimal place otherwise - never the full float, which is how
// a 4.199999999999999 ends up in somebody's feed.
function ratingValue(rating: number): string {
  return Number.isInteger(rating) ? String(rating) : rating.toFixed(1)
}

function renderReview(review: ReviewFeedItem): string {
  const name = clean(review.authorName)
  const anonymous = name === ''
  const reviewer = [
    `\n      <reviewer>`,
    `\n        <name is_anonymous="${anonymous ? 'true' : 'false'}">${escapeXml(anonymous ? 'Anonymous' : name)}</name>`,
    `\n      </reviewer>`,
  ].join('')
  const ratings = [
    `\n      <ratings>`,
    `\n        <overall min="${review.ratingMin}" max="${review.ratingMax}">${ratingValue(review.rating)}</overall>`,
    `\n      </ratings>`,
  ].join('')
  const products = [
    `\n      <products>`,
    review.products.map(renderProduct).join(''),
    `\n      </products>`,
  ].join('')
  // Order is load-bearing - see the note at the top of this file.
  const parts = [
    tag('review_id', review.id, '      '),
    reviewer,
    tag('review_timestamp', review.timestamp, '      '),
    review.title ? tag('title', clip(review.title, TITLE_MAX), '      ') : '',
    tag('content', clip(review.content, CONTENT_MAX), '      '),
    `\n      <review_url type="${review.urlType}">${escapeXml(clean(review.url))}</review_url>`,
    ratings,
    products,
    // Said out loud on every review, because Google's own guidance is that a
    // feed which never marks anything as spam is a feed with no moderation
    // behind it. Everything here has been through the shop's queue.
    `\n      <is_spam>false</is_spam>`,
    tag('collection_method', review.collectionMethod, '      '),
    tag('transaction_id', review.transactionId, '      '),
  ]
  return `\n    <review>${parts.join('')}\n    </review>`
}

/** The whole document. */
export function buildReviewFeedXml(publisher: ReviewFeedPublisher, reviews: ReviewFeedItem[]): string {
  const publisherBlock = [
    `\n  <publisher>`,
    tag('name', publisher.name, '    '),
    tag('favicon', publisher.faviconUrl, '    '),
    `\n  </publisher>`,
  ].join('')
  // <reviews> is optional in the schema, and an empty one is invalid - a shop
  // with nothing published yet serves a valid document that simply says so.
  const reviewsBlock =
    reviews.length === 0 ? '' : `\n  <reviews>${reviews.map(renderReview).join('')}\n  </reviews>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:vc="http://www.w3.org/2007/XMLSchema-versioning"
      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xsi:noNamespaceSchemaLocation="http://www.google.com/shopping/reviews/schema/product/2.3/product_reviews.xsd">
  <version>2.3</version>${publisherBlock}${reviewsBlock}
</feed>
`
}
