// GET /google-shopping/feed.xml?key=<token> - the Google Merchant Center feed,
// and with &content=reviews the product REVIEW feed off the same address.
//
// One address for two documents because core dispatches the literal segment
// feed.xml and nothing else (app/(public)/[slug]/feed.xml/route.ts); a second
// public file name would need a core change, and a query parameter is what
// Merchant Center's scheduled fetch takes either way.
//
// Dispatched through core's literal feed.xml catch route (see
// app/(public)/[slug]/feed.xml/route.ts) once the manifest's publicBasePath is
// registered. Everything about a wrong request is a plain 404: whether the
// module is switched off, the key is wrong, or the shop cannot honestly quote
// prices, an outsider probing the URL learns nothing either way.
import type { NextRequest } from 'next/server'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { resolveShopCommerceMode } from '@/modules/shop/lib/commerce-mode'
import { getSiteUrlOrNull } from '@/lib/config/env'
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { collectFeedItems } from '@/modules/google-shopping-for-shop/lib/feed-data'
import { buildFeedXml } from '@/modules/google-shopping-for-shop/lib/feed-xml'
import { collectReviewFeedItems, reviewFeedPublisher } from '@/modules/google-shopping-for-shop/lib/review-feed-data'
import { buildReviewFeedXml } from '@/modules/google-shopping-for-shop/lib/review-feed-xml'

const notFound = () => new Response('Not found', { status: 404 })

const xml = (body: string) =>
  new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } })

export async function GET(request: NextRequest) {
  const settings = await getGsfSettings()
  const params = new URL(request.url).searchParams
  const key = params.get('key')
  // The product feed's own switch does not gate the review feed: a shop may
  // publish what customers said without advertising the products themselves.
  // The key is the same one, because it is the same module and the same
  // address, one parameter apart.
  const wantsReviews = params.get('content') === 'reviews'
  const switchedOn = wantsReviews ? settings.reviewsFeedEnabled : settings.enabled
  if (!switchedOn || !settings.feedToken || key !== settings.feedToken) return notFound()

  const config = await getShopConfigCached()
  if (config.shopStatus === 'CLOSED') return notFound()

  const siteUrl = getSiteUrlOrNull()
  if (!siteUrl) return notFound()

  if (wantsReviews) {
    // No price test here: reviews quote no prices, so a quote-only shop is
    // perfectly entitled to publish them.
    const [publisher, reviews] = await Promise.all([
      reviewFeedPublisher(siteUrl),
      collectReviewFeedItems(siteUrl),
    ])
    return xml(buildReviewFeedXml(publisher, reviews))
  }

  // A quote-only shop withholds its prices everywhere; Google requires one on
  // every item, so there is no product feed to serve.
  const commerce = await resolveShopCommerceMode()
  if (commerce.hidePrices) return notFound()

  const items = await collectFeedItems(siteUrl)
  return xml(buildFeedXml(
    { title: 'Product feed', link: siteUrl, description: 'Google Shopping product feed' },
    items,
  ))
}
