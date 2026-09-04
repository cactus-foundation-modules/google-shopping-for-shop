// Merged into core /robots.txt (scanned by scripts/generate-module-router.mjs).
// The feed is for Merchant Center's fetcher, not for search results: Google
// fetches a configured feed URL regardless of robots, so this only keeps the
// path out of organic crawling.
//
// Anchored: a bare '/google-shopping' is a PREFIX match and would also block any
// root-slug page whose slug starts with it. The trailing-slash entry covers the
// only thing actually served under here, /google-shopping/feed.xml.
export function getPublicRobotsDisallow(): string[] {
  return ['/google-shopping$', '/google-shopping/']
}
