// Merged into core /robots.txt (scanned by scripts/generate-module-router.mjs).
// The feed is for Merchant Center's fetcher, not for search results: Google
// fetches a configured feed URL regardless of robots, so this only keeps the
// path out of organic crawling.
export function getPublicRobotsDisallow(): string[] {
  return ['/google-shopping']
}
