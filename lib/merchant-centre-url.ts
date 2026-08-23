// The address of one item inside Merchant Center's console.
//
// Google publishes no URL contract for its console, only for the API, so the
// whole shape of the address lives here: when Merchant Center next reshuffles
// its query string, this is the only thing to change. Kept apart from the rest
// of the module so it stays pure and testable - it reads nothing.
//
// Confirmed 2026-08-23 against a live account, by comparing with the address
// Merchant Center's own product page carries. Two details are not guessable and
// both cost a "cannot find the page": the host is merchants.google.com (NOT
// merchantcenter.google.com, which is only the marketing site's domain and has
// no /mc path at all), and the online channel is the NUMBER 0, not the word
// "online" the API uses for the same thing.

const MC_ITEM_URL = 'https://merchants.google.com/mc/items/details'

// Every page of the platform renders in English (app/layout.tsx), so the feed
// only ever has one content language to declare.
const CONTENT_LANGUAGE = 'en'

/** The console's page for one item. */
export function merchantCentreItemUrl(opts: { merchantId: string; offerId: string; feedLabel: string | null }): string {
  const params = new URLSearchParams({
    a: opts.merchantId,
    offerId: opts.offerId,
    language: CONTENT_LANGUAGE,
    // 0 is the console's own code for the online channel. Sending 'online' -
    // the word the Content API takes - loads a page that finds nothing.
    channel: '0',
  })
  // Left off when unknown: Merchant Center then asks which feed is meant, which
  // is a far better answer than pointing confidently at the wrong country.
  if (opts.feedLabel) params.set('feedLabel', opts.feedLabel)
  return `${MC_ITEM_URL}?${params.toString()}`
}

