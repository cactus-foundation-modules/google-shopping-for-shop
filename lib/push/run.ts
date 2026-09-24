// The worker: what actually goes to Google when a price or a stock count moves.
//
// The shape of a run, and why each part is where it is:
//
//   1. Refuse early and say why. Every way out of this file either raises the
//      live-updates alert or clears it - never neither. An alert raised by
//      yesterday's failure and left up because today's run returned early at
//      line three is a notice about something that is no longer happening, and
//      stage 4 had to go back and fix exactly that.
//
//   2. Claim the slot in the DATABASE. Two serverless invocations are two
//      machines; a flag in this process would not stop either of them.
//
//   3. Build the feed. The whole feed, every time. It is the expensive part and
//      it is not negotiable: the feed build is the authority on what an item's
//      price and availability are, on the VAT treatment, on which items feed
//      rules have excluded and on which the owner has excluded by hand. Reading
//      the product table directly here would be a second implementation of all
//      of that, and the two would drift within a month.
//
//   4. Send only what has actually changed. The state table holds what we last
//      tried to set; an item matching it to the penny is skipped, so a run
//      triggered by a description edit sends nothing at all.
//
//   5. Stop on a wall-clock budget rather than on a count. Whatever is left
//      stays in the queue and the next run takes it.
//
//   6. On the HOURLY run, sweep. The queue only ever holds what a shop signal
//      saw, and plenty of changes fire no signal at all, so the sweep compares
//      every live item against what we believe we sent and re-sends the ones
//      that have moved - as well as taking out the ones that have left the
//      feed. Without that half, a change nothing announced would reach Google
//      not late but never. See sweepTargets.
//
// On retrying: an insert into a supplemental data source REPLACES our input for
// that item - it is not an append - so sending the same three attributes twice
// leaves Merchant Center in the state one send would have. That is what makes
// the client's own 429/5xx retry safe here, and what makes a failed item safe
// to try again on the next run. Nothing in this module retries anything whose
// effect would compound.
import { getSiteUrl } from '@/lib/config/env'
import { collectFeedItems } from '@/modules/google-shopping-for-shop/lib/feed-data'
import type { FeedItem } from '@/modules/google-shopping-for-shop/lib/feed-xml'
import { merchantRequest } from '@/modules/google-shopping-for-shop/lib/google/client'
import { hasGoogleCredentials } from '@/modules/google-shopping-for-shop/lib/google/credentials'
import { GoogleApiError } from '@/modules/google-shopping-for-shop/lib/google/errors'
import { productResourceSegment } from '@/modules/google-shopping-for-shop/lib/health/parse'
import { ALERT_KEYS, isAlertUp, setPricePushAlert } from '@/modules/google-shopping-for-shop/lib/health/alerts'
import { syncPushAlert } from '@/modules/google-shopping-for-shop/lib/push/alert'
import { recordChange } from '@/modules/google-shopping-for-shop/lib/change-log'
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { buildProductInput, sameSnapshot, snapshotOf } from '@/modules/google-shopping-for-shop/lib/push/payload'
import {
  claimPushRun,
  clearQueued,
  forgetItems,
  queueDepth,
  readAllPushState,
  readPushTotals,
  readQueue,
  recordFailed,
  recordSent,
  releasePushRun,
  type PushStateRow,
  type QueuedProduct,
} from '@/modules/google-shopping-for-shop/lib/push/store'
import {
  PUSH_SKIP_COPY,
  type PushRunOutcome,
  type PushRunSummary,
  type PushSkipReason,
  type PushSnapshot,
} from '@/modules/google-shopping-for-shop/lib/push/types'

/** How long a run keeps sending before it leaves the rest for next time. A
 *  module route has sixty seconds in total and the feed build has already had
 *  some of them, so this is measured from AFTER the build. */
const SEND_BUDGET_MS = 30_000

/** Products taken off the queue in one run. A bulk edit of a catalogue is
 *  several runs, which is the right answer - the alternative is one run that
 *  times out and leaves nothing recorded. */
const MAX_QUEUED_PER_RUN = 400

/** How many sends are in flight at once. Enough to make a hundred items quick;
 *  small enough that a rate limit is a pause rather than a wall. */
const CONCURRENCY = 4

/** Retries of previously-refused items squeezed into a run alongside the queue.
 *  Capped so a catalogue's worth of permanently-refused items cannot crowd out
 *  the changes somebody made a moment ago. */
const MAX_RETRIES_PER_RUN = 50

/** How many items the hourly sweep may send in one run, on top of the queue.
 *  It is what walks a catalogue the first time the feature is switched on, and
 *  what carries a change no signal saw - so it has to be generous enough to
 *  finish in a sensible number of hours and small enough that one run is not
 *  the whole catalogue. The wall-clock budget stops it long before this on a
 *  slow day. */
const MAX_SWEEP_SENDS = 200

export type PushRunOptions = {
  /** 0 for a run on a timer or a button; the debounce setting for a run kicked
   *  by a product save. */
  minGapSeconds?: number
  /** Who pressed the button, for the change log. Null for the cron. */
  actor?: string | null
  /** True on the hourly run: also takes items out of Merchant Center that the
   *  feed no longer carries, wherever they are, rather than only the ones that
   *  happened to be queued. */
  sweep?: boolean
}

function skipped(reason: PushSkipReason): PushRunOutcome {
  return { status: 'skipped', reason, message: PUSH_SKIP_COPY[reason] }
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof GoogleApiError) return error.message
  return error instanceof Error ? error.message : fallback
}

/** True when this item's last attempt is still standing - same figures, sent,
 *  and acknowledged. Anything else is worth sending again. */
function alreadySent(state: PushStateRow | undefined, snapshot: PushSnapshot): boolean {
  if (!state) return false
  if (state.failedAt !== null) return false
  if (!state.confirmed) return false
  return sameSnapshot(state.snapshot, snapshot)
}

type SendContext = {
  merchantId: string
  /** Half of a product's identity at Google, with the content language and the
   *  offer id. Validated against the main feed's own at setup. */
  feedLabel: string
  contentLanguage: string
  dataSource: string
}

type SendResult = { itemId: string; ok: boolean; confirmed: boolean; snapshot: PushSnapshot; message?: string }

/**
 * One item to Merchant Center.
 *
 * `productInputs.insert` is an upsert into the named data source: the same call
 * creates our input the first time and replaces it every time after, which is
 * why there is no separate "have we sent this before" branch.
 *
 * A reply that cannot be read is recorded as sent-but-unconfirmed, never as
 * sent. The reconcile settles those; claiming them would make the one figure
 * on the screen that is supposed to mean "Google has this" mean nothing.
 */
async function sendOne(context: SendContext, item: FeedItem): Promise<SendResult> {
  const snapshot = snapshotOf(item)
  const body = buildProductInput(item, { contentLanguage: context.contentLanguage, feedLabel: context.feedLabel })
  try {
    const reply = await merchantRequest<{ name?: string; offerId?: string }>(
      `products/v1/accounts/${context.merchantId}/productInputs:insert?dataSource=${encodeURIComponent(context.dataSource)}`,
      { method: 'POST', body },
    )
    const confirmed = typeof reply?.name === 'string' || typeof reply?.offerId === 'string'
    return { itemId: item.id, ok: true, confirmed, snapshot }
  } catch (error) {
    return { itemId: item.id, ok: false, confirmed: false, snapshot, message: messageOf(error, 'Google refused it') }
  }
}

/** Takes our supplemental input for one item back out. A 404 is success: it
 *  means somebody has already removed it, which is the state we were after. */
async function removeOne(context: SendContext, itemId: string): Promise<{ ok: boolean; message?: string }> {
  const segment = productResourceSegment({ contentLanguage: context.contentLanguage, feedLabel: context.feedLabel, offerId: itemId })
  if (!segment) return { ok: false, message: 'That item has no name Google would recognise.' }
  try {
    await merchantRequest(
      `products/v1/accounts/${context.merchantId}/productInputs/${segment}?dataSource=${encodeURIComponent(context.dataSource)}`,
      { method: 'DELETE' },
    )
    return { ok: true }
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 404) return { ok: true }
    return { ok: false, message: messageOf(error, 'Google refused it') }
  }
}

/**
 * Which items the hourly sweep should send, in the order it should send them.
 *
 * Pure, and exported, because it is the whole value-drift backstop in one
 * function and the alternative is trusting a comment. An earlier version of the
 * sweep only REMOVED items - it compared membership and never snapshots - so a
 * change that fired no shop signal never reached Google at all. Not late:
 * never. Three comments and a report claimed the opposite.
 *
 * Drift first, never-sent after. A wrong price on a listing Google is already
 * showing is worse than a listing this site has not started keeping up to date
 * yet; and including the never-sent at all is what makes switching the feature
 * on work its way through the catalogue by itself, rather than waiting for
 * somebody to go and edit every product in the shop.
 *
 * ONE THING TO KNOW ABOUT THAT PRIORITY. `alreadySent` counts an unconfirmed
 * row as still needing sending, so a run whose replies could not be read comes
 * back here as drift - and drift always goes first. If Google's replies ever
 * became SYSTEMATICALLY unreadable, the same capped batch would re-send every
 * hour and the never-sent tail would never advance: the catalogue walk would
 * stall while the panel showed a large "sent but not confirmed" figure. It is
 * unlikely (`productInputs.insert` returns the resource, and a reply with a
 * name in it is all `confirmed` asks for) and it is not silent, which is why it
 * is a note here rather than a mechanism. If it ever does happen, the fix is to
 * take a slice of the never-sent regardless rather than to reorder these two.
 */
export function sweepTargets(
  items: readonly FeedItem[],
  state: ReadonlyMap<string, PushStateRow>,
  handled: ReadonlySet<string>,
): FeedItem[] {
  const drifted: FeedItem[] = []
  const unsent: FeedItem[] = []
  for (const item of items) {
    if (handled.has(item.id)) continue
    const held = state.get(item.id)
    if (!held) unsent.push(item)
    else if (!alreadySent(held, snapshotOf(item))) drifted.push(item)
  }
  return [...drifted, ...unsent]
}

/** Runs `work` over `items`, a few at a time, in order. */
async function inBatches<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let start = 0; start < items.length; start += size) {
    results.push(...await Promise.all(items.slice(start, start + size).map(work)))
  }
  return results
}

/**
 * Sends everything queued, and takes out what the feed no longer carries.
 *
 * Never throws for an ordinary refusal: everything comes back as an outcome, so
 * the cron does not lose the rest of its jobs to this one.
 */
export async function runPricePush(options: PushRunOptions = {}): Promise<PushRunOutcome> {
  const settings = await getGsfSettings()

  // ---- The ways out that are nobody's fault --------------------------------
  if (!settings.pricePushEnabled) {
    await setPricePushAlert({ failed: false })
    return skipped('off')
  }
  // The module's own master switch, checked here as well as in the observer.
  // Without it, a shop that switched its Google feed off and left this on kept
  // writing to Merchant Center on the timer for ever - a feed nobody is serving
  // any more, being kept scrupulously up to date.
  if (!settings.enabled) {
    await setPricePushAlert({ failed: false })
    return skipped('feed-off')
  }

  // ---- The ways out that ARE worth a notice --------------------------------
  // Switched on and unable to run is a problem: the owner believes their prices
  // are reaching Google and they are not.
  const alreadyUp = await isAlertUp(ALERT_KEYS.pricePush)
  const refuse = async (reason: PushSkipReason): Promise<PushRunOutcome> => {
    await setPricePushAlert({ failed: true, message: PUSH_SKIP_COPY[reason], alreadyUp })
    return skipped(reason)
  }
  if (!hasGoogleCredentials()) return refuse('no-credentials')
  if (!settings.merchantId) return refuse('no-merchant-id')
  if (!settings.feedLabel) return refuse('no-feed-label')
  if (!settings.pushDataSourceId) return refuse('not-set-up')
  // Set up but not connected. Google accepts every insert into a supplemental
  // source nothing points at and ignores all of it, so without this the panel
  // reported a clean send of prices no shopper would ever see. runSetup records
  // the source BEFORE the link call on purpose (so a second press finds it
  // rather than making another), which is exactly how this state arises.
  if (settings.pushLinkedSourceIds.length === 0) return refuse('not-linked')

  const totals = await readPushTotals()
  const depth = await queueDepth()
  // Items Google refused, and items Google is holding something different for,
  // both count as work: the point of finding drift is to put it right.
  if (depth === 0 && totals.failed === 0 && totals.differs === 0 && !options.sweep) {
    await setPricePushAlert({ failed: false })
    return skipped('nothing-queued')
  }

  // ---- The slot ------------------------------------------------------------
  // Deliberately no alert change on either branch: another run holds the slot,
  // and whatever it finds is its news to report.
  if (!await claimPushRun(options.minGapSeconds ?? 0)) {
    return skipped((options.minGapSeconds ?? 0) > 0 ? 'too-soon' : 'already-running')
  }

  try {
    const summary = await sendEverything({
      merchantId: settings.merchantId,
      feedLabel: settings.feedLabel,
      contentLanguage: settings.contentLanguage,
      dataSourceId: settings.pushDataSourceId,
    }, options)
    await releasePushRun(summary)
    await syncPushAlert(summary.message)
    return { status: 'ran', summary }
  } catch (error) {
    // Whatever went wrong, the slot has to go back or nothing runs for five
    // minutes. The stamp records a FAILURE rather than being left alone, so the
    // screen cannot read the run before this one as though it were this one.
    const message = messageOf(error, 'The send did not finish')
    const summary: PushRunSummary = { status: 'failed', sent: 0, unchanged: 0, removed: 0, failed: 0, leftQueued: depth, message }
    await releasePushRun(summary)
      .catch((stampError) => console.error('[google-shopping] could not stamp the failed live-updates run:', stampError))
    await setPricePushAlert({ failed: true, message, alreadyUp }).catch(() => {})
    return { status: 'ran', summary }
  }
}

async function sendEverything(
  account: { merchantId: string; feedLabel: string; contentLanguage: string; dataSourceId: string },
  options: PushRunOptions,
): Promise<PushRunSummary> {
  const context: SendContext = {
    merchantId: account.merchantId,
    feedLabel: account.feedLabel,
    contentLanguage: account.contentLanguage,
    dataSource: `accounts/${account.merchantId}/dataSources/${account.dataSourceId}`,
  }

  const queue = await readQueue(MAX_QUEUED_PER_RUN)
  const [feed, state] = await Promise.all([collectFeedItems(getSiteUrl()), readAllPushState()])

  // Every item the feed WOULD publish, by id. Anything not in here is out of
  // the feed - excluded by a rule, excluded by hand, withheld for having no
  // image, or simply no longer a product - and must not be sent.
  const live = new Map(feed.items.map((item) => [item.id, item]))

  // A queued product is either an item in its own right or a variation parent
  // whose children are the items. Both are handled by looking the product up on
  // either side.
  const byProduct = new Map<string, FeedItem[]>()
  for (const item of feed.items) {
    for (const key of [item.id, item.itemGroupId]) {
      if (!key) continue
      const held = byProduct.get(key)
      if (held) held.push(item)
      else byProduct.set(key, [item])
    }
  }

  // The listing an item belongs to, which is what the queue holds and what
  // gsf_push_state records alongside the item.
  const parentOf = (item: FeedItem): string => item.itemGroupId ?? item.id

  // Every item we are keeping up to date, grouped by its listing. Without this
  // a queued variation PARENT that has left the feed matched nothing: the state
  // table is keyed by CHILD item ids, so `state.has(parentId)` was false and the
  // children sat at Merchant Center until the hourly sweep noticed.
  const trackedByParent = new Map<string, string[]>()
  for (const row of state.values()) {
    const held = trackedByParent.get(row.parentId)
    if (held) held.push(row.itemId)
    else trackedByParent.set(row.parentId, [row.itemId])
  }

  const deadline = Date.now() + SEND_BUDGET_MS
  const outOfTime = () => Date.now() > deadline

  let sent = 0
  let unchanged = 0
  let failed = 0
  let removed = 0
  const done: QueuedProduct[] = []
  const handled = new Set<string>()
  const failures: string[] = []
  const sentIds: string[] = []

  /** Sends one item and records whichever answer came back. */
  const record = async (result: SendResult, parentId: string): Promise<void> => {
    if (result.ok) {
      await recordSent(result.itemId, parentId, result.snapshot, result.confirmed)
      sent++
      sentIds.push(result.itemId)
    } else {
      await recordFailed(result.itemId, parentId, result.snapshot, result.message ?? 'Google refused it')
      failed++
      if (failures.length < 5) failures.push(result.message ?? 'Google refused it')
    }
  }

  /** Takes one item's override back out of Merchant Center. */
  const drop = async (itemId: string): Promise<void> => {
    const outcome = await removeOne(context, itemId)
    if (outcome.ok) {
      await forgetItems([itemId])
      removed++
    } else {
      failed++
      if (failures.length < 5) failures.push(outcome.message ?? 'Google refused it')
    }
    handled.add(itemId)
  }

  // ---- What is queued -------------------------------------------------------
  for (const entry of queue) {
    if (outOfTime()) break
    const items = (byProduct.get(entry.productId) ?? []).filter((item) => !handled.has(item.id))
    const toSend = items.filter((item) => !alreadySent(state.get(item.id), snapshotOf(item)))
    unchanged += items.length - toSend.length
    for (const item of items) handled.add(item.id)

    const results = await inBatches(toSend, CONCURRENCY, (item) => sendOne(context, item))
    const parents = new Map(toSend.map((item) => [item.id, parentOf(item)]))
    for (const result of results) await record(result, parents.get(result.itemId) ?? result.itemId)

    // Anything we hold for this listing that the feed no longer publishes: take
    // our override back out rather than leave Merchant Center holding a price
    // this site no longer stands behind. Only OUR supplemental input goes; the
    // fetched feed's own row is untouched and, where the item has genuinely
    // left the catalogue, Google drops it on its next fetch anyway.
    //
    // Looked up BY LISTING, not by the queued id: a variation parent's feed
    // items are its children, so a test against the parent's own id found
    // nothing and left the children behind.
    const orphans = (trackedByParent.get(entry.productId) ?? [])
      .filter((itemId) => !live.has(itemId) && !handled.has(itemId))
    let cleared = true
    for (const itemId of orphans) {
      if (outOfTime()) { cleared = false; break }
      await drop(itemId)
    }

    // Only taken off the queue once everything it owns has been dealt with. A
    // run that stopped half way through one listing leaves it where it is, so
    // the next run finishes the job rather than the hourly sweep having to.
    if (cleared) done.push(entry)
  }
  await clearQueued(done)

  // ---- Items that were refused, or that Google disagrees about --------------
  // Neither is queued - their products have not changed again - and both are
  // still wrong at Google. Tried again here, oldest first, within whatever
  // budget is left. Safe to repeat: the insert replaces our input rather than
  // adding to it.
  if (!outOfTime()) {
    const retries = [...state.values()]
      .filter((row) => (row.failedAt !== null || row.reconcileResult === 'differs') && !handled.has(row.itemId) && live.has(row.itemId))
      .sort((a, b) => (a.failedAt?.getTime() ?? a.reconciledAt?.getTime() ?? 0) - (b.failedAt?.getTime() ?? b.reconciledAt?.getTime() ?? 0))
      .slice(0, MAX_RETRIES_PER_RUN)
    for (const row of retries) {
      if (outOfTime()) break
      const item = live.get(row.itemId)
      if (!item) continue
      handled.add(row.itemId)
      await record(await sendOne(context, item), parentOf(item))
    }
  }

  // ---- The sweep -----------------------------------------------------------
  //
  // Only on the hourly run, and it is the backstop the whole feature rests on.
  // A product's price or availability can move without anything queueing it:
  // the stock-import module writes counts in one bulk UPDATE and announces
  // nothing, a feed rule can change what an item is worth, a category can move,
  // an image can be deleted. The signal from the shop cannot see any of those.
  //
  // So the sweep does BOTH halves, and it has to. An earlier version only
  // removed items, which meant a change no signal saw never reached Google at
  // all - not late, never - while three comments and a report claimed the
  // opposite. Both maps are already in memory, so this costs nothing but the
  // sends themselves.
  if (options.sweep) {
    // 1. Gone from the feed: take our override out.
    for (const itemId of [...state.keys()].filter((id) => !live.has(id) && !handled.has(id))) {
      if (outOfTime()) break
      await drop(itemId)
    }

    // 2. Still in the feed and no longer what we sent - or never sent at all.
    for (const item of sweepTargets(feed.items, state, handled).slice(0, MAX_SWEEP_SENDS)) {
      if (outOfTime()) break
      handled.add(item.id)
      await record(await sendOne(context, item), parentOf(item))
    }
  }

  const leftQueued = await queueDepth()
  const status: PushRunSummary['status'] = failed === 0 ? 'ok' : sent > 0 || removed > 0 ? 'part' : 'failed'
  const summary: PushRunSummary = {
    status,
    sent,
    unchanged,
    removed,
    failed,
    leftQueued,
    ...(failures.length > 0 ? { message: failures[0] } : {}),
  }

  if (sent > 0 || removed > 0 || failed > 0) {
    // One entry per run that actually did something. A run that found nothing
    // to send writes nothing: the log is for changes, and "nothing changed" is
    // not one. The ids are capped because a bulk price change is thousands and
    // the log is read by a person.
    await recordChange({
      area: 'live-updates',
      action: 'push',
      summary: describeRun(summary),
      before: null,
      after: { ...summary, items: sentIds.slice(0, 50), moreItems: Math.max(0, sentIds.length - 50) },
      createdBy: options.actor ?? null,
    }).catch((error) => console.error('[google-shopping] could not record the live-updates run:', error))
  }

  return summary
}

/** The run in a sentence, for the change log. */
export function describeRun(summary: PushRunSummary): string {
  const parts: string[] = []
  if (summary.sent > 0) parts.push(`Sent ${summary.sent === 1 ? '1 product' : `${summary.sent.toLocaleString('en-GB')} products`} to Google`)
  if (summary.removed > 0) parts.push(`took ${summary.removed === 1 ? '1 product' : `${summary.removed.toLocaleString('en-GB')} products`} back out`)
  if (summary.failed > 0) parts.push(`${summary.failed === 1 ? '1 was' : `${summary.failed.toLocaleString('en-GB')} were`} refused`)
  if (parts.length === 0) return 'Nothing needed sending to Google'
  return `${parts.join(', ')}.`
}
