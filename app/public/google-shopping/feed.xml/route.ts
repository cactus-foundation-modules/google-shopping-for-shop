// GET /google-shopping/feed.xml?key=<token> - the Google Merchant Center feed.
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

const notFound = () => new Response('Not found', { status: 404 })

export async function GET(request: NextRequest) {
  const settings = await getGsfSettings()
  const key = new URL(request.url).searchParams.get('key')
  if (!settings.enabled || !settings.feedToken || key !== settings.feedToken) return notFound()

  const config = await getShopConfigCached()
  if (config.shopStatus === 'CLOSED') return notFound()
  // A quote-only shop withholds its prices everywhere; Google requires one on
  // every item, so there is no feed to serve.
  const commerce = await resolveShopCommerceMode()
  if (commerce.hidePrices) return notFound()

  const siteUrl = getSiteUrlOrNull()
  if (!siteUrl) return notFound()

  const items = await collectFeedItems(siteUrl)
  const xml = buildFeedXml(
    { title: 'Product feed', link: siteUrl, description: 'Google Shopping product feed' },
    items,
  )
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } })
}
