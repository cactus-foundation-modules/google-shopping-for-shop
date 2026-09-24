// POST /api/m/google-shopping-for-shop/admin/health/refresh
// Asks Google how its last fetch of the feed went, records the answer, and
// raises or clears the "Google is not reading your feed" alert.
//
// Item issues are NOT refreshed here: they come off the same report as the
// match snapshot, so pressing Refresh on the Products tab brings both. Two
// buttons that each cost a different Google call is better than one button
// that quietly costs both.
import { NextResponse } from 'next/server'
import { requireShopUser } from '@/modules/shop/lib/access'
import { ALERT_KEYS, isAlertUp, syncFeedFetchAlert } from '@/modules/google-shopping-for-shop/lib/health/alerts'
import { refreshFeedFetchStatus } from '@/modules/google-shopping-for-shop/lib/health/feed-fetch'
import { FETCH_UNAVAILABLE_COPY } from '@/modules/google-shopping-for-shop/lib/health/types'

export async function POST() {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  try {
    const outcome = await refreshFeedFetchStatus()
    const alreadyUp = await isAlertUp(ALERT_KEYS.feedFetch)
    const alerted = outcome.status === 'ok'
      ? await syncFeedFetchAlert({ status: 'ok', fetch: outcome.fetch, alreadyUp })
      : await syncFeedFetchAlert({ status: 'unavailable', reason: outcome.reason, alreadyUp })

    if (outcome.status === 'ok') {
      return NextResponse.json({ status: 'ok', origin: outcome.origin, fetch: outcome.fetch, alerted })
    }
    // 200, not an error status: "we could not find out" is an answer the
    // screen has words for, and a 4xx would have the browser show it as a
    // failed request instead.
    return NextResponse.json({
      status: 'unavailable',
      reason: outcome.reason,
      message: FETCH_UNAVAILABLE_COPY[outcome.reason],
      // Google's own sentence, where it gave one. Never a credential: this is
      // GoogleApiError's message, which carries Google's text and nothing of
      // ours.
      detail: outcome.detail,
      alerted,
    })
  } catch (error) {
    console.error('[google-shopping] feed fetch check failed:', error)
    return NextResponse.json({ error: 'Could not check the feed with Google. Try again in a moment.' }, { status: 500 })
  }
}
