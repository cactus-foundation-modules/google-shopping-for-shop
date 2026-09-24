// The shapes the live price and stock updates work in. No database, no network:
// everything here is a plain value, so the mapping can be tested without either.

import type { FeedAvailability } from '@/modules/google-shopping-for-shop/lib/feed-xml'

/** Merchant API `ProductAttributes.availability`, as Google's own products_v1
 *  discovery document (revision 20260923) spells the enum. The feed XML spells
 *  the same idea in lower case, which is the XML specification's business and
 *  not the API's - they are NOT interchangeable and one is not the other
 *  lower-cased, because Google also has LIMITED_AVAILABILITY, which nothing in
 *  this module produces. */
export const GOOGLE_AVAILABILITY = ['IN_STOCK', 'OUT_OF_STOCK', 'PREORDER', 'BACKORDER'] as const
export type GoogleAvailability = (typeof GOOGLE_AVAILABILITY)[number]

export function isGoogleAvailability(value: unknown): value is GoogleAvailability {
  return typeof value === 'string' && (GOOGLE_AVAILABILITY as readonly string[]).includes(value)
}

/** The three things this module sends, and the only three it claims anything
 *  about. Everything else on an item - title, images, category, delivery - is
 *  the fetched feed's business and is never overridden from here. */
export type PushSnapshot = {
  /** Gross, major units, exactly as the feed renders it. */
  price: number
  /** Absent rather than null when there is no offer running: Google reads a
   *  missing sale price as "no sale", and there is no way to say "no sale" by
   *  sending one. */
  salePrice?: number
  currency: string
  availability: GoogleAvailability
}

/** Merchant API `Price`. `amountMicros` is a STRING in Google's schema (int64),
 *  and sending a JSON number would lose precision on a large enough figure. */
export type GooglePrice = { amountMicros: string; currencyCode: string }

/** The body of a `productInputs.insert`, holding only the attributes this
 *  module supplies. A supplemental data source merges over the primary feed,
 *  so an attribute left out here is simply the feed's own. */
export type ProductInputBody = {
  offerId: string
  contentLanguage: string
  feedLabel: string
  productAttributes: {
    price: GooglePrice
    salePrice?: GooglePrice
    availability: GoogleAvailability
  }
}

/** One item's place in a run. */
export type PushItemOutcome =
  | { itemId: string; status: 'sent'; confirmed: boolean; snapshot: PushSnapshot }
  | { itemId: string; status: 'unchanged' }
  | { itemId: string; status: 'removed' }
  | { itemId: string; status: 'failed'; message: string }

/** What a whole run came to. `status` is what the stamp records, and it is
 *  never 'ok' unless the run actually reached the end. */
export type PushRunSummary = {
  status: 'ok' | 'part' | 'failed'
  sent: number
  unchanged: number
  removed: number
  failed: number
  /** Products still queued when the run stopped, because it ran out of budget.
   *  They stay in the queue and the next run takes them. */
  leftQueued: number
  message?: string
}

/** Why a run did not happen. Each one is a sentence the Health panel can show
 *  as it stands - no code is ever put in front of an owner. */
export type PushSkipReason =
  | 'off'
  | 'feed-off'
  | 'not-set-up'
  | 'not-linked'
  | 'no-credentials'
  | 'no-merchant-id'
  | 'no-feed-label'
  | 'nothing-queued'
  | 'too-soon'
  | 'already-running'

export type PushRunOutcome =
  | { status: 'ran'; summary: PushRunSummary }
  | { status: 'skipped'; reason: PushSkipReason; message: string }

export const PUSH_SKIP_COPY: Record<PushSkipReason, string> = {
  off: 'Live price and stock updates are switched off.',
  'feed-off': 'Your Google Shopping feed is switched off, so there are no listings to keep up to date.',
  'not-set-up': 'Live updates have not been set up with Merchant Center yet, so nothing has been sent.',
  // Being set up and not connected is its own state, and the one that used to
  // report success: Google accepts every send into a supplemental feed nothing
  // points at, and then ignores all of it.
  'not-linked': 'Your main feed at Merchant Center is not taking prices from this site, so anything sent would be ignored. '
    + 'Press "Set it up" on the Health tab to connect the two.',
  'no-credentials': 'No Google service-account key has been saved, so nothing can be sent.',
  'no-merchant-id': 'Your Merchant Center account number has not been filled in, so nothing can be sent.',
  'no-feed-label': 'Your feed label has not been filled in. Google needs it to know which products these updates belong to.',
  'nothing-queued': 'Nothing has changed since the last send.',
  'too-soon': 'Something was sent very recently, so this run has been left for the next one.',
  'already-running': 'A send is already under way.',
}

export type { FeedAvailability }
