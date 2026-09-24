// The feed's own address, in one place.
//
// The product feed, the review feed and the promotions source are one route
// with a `content` parameter, and the secret key is a query parameter on all
// three. Composing that by hand in three files is how one of them ends up a
// parameter behind, so it is composed here. Pure - it reads nothing.

export type FeedContent = 'products' | 'reviews' | 'promotions'

/** The URL Google is given. Null when either half is missing: with no site URL
 *  there is no address, and with no token the route refuses to serve anyway. */
export function feedUrl(siteUrl: string | null, feedToken: string | null, content: FeedContent = 'products'): string | null {
  if (!siteUrl || !feedToken) return null
  const base = `${siteUrl.replace(/\/+$/, '')}/google-shopping/feed.xml?key=${encodeURIComponent(feedToken)}`
  return content === 'products' ? base : `${base}&content=${content}`
}
