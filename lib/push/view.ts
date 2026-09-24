// What the Health tab's live-updates panel is given, in one shape.
//
// Assembled from our own tables only - opening the tab never rings Google. The
// two buttons on the panel are the only things that pick up the telephone, the
// same rule the rest of the Health tab follows.
//
// Dates cross to the browser as ISO strings. A Date in a server component's
// props arrives as an empty object, which this module has already learned the
// hard way once.
import { hasGoogleCredentials } from '@/modules/google-shopping-for-shop/lib/google/credentials'
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { merchantCentreItemUrl } from '@/modules/google-shopping-for-shop/lib/merchant-centre-url'
import {
  queueDepth,
  readDisagreements,
  readPushRun,
  readPushTotals,
  readRecentFailures,
  type PushStateRow,
} from '@/modules/google-shopping-for-shop/lib/push/store'
import type { PushSnapshot } from '@/modules/google-shopping-for-shop/lib/push/types'

/** A run that claimed the slot and has not let go for longer than this is
 *  presumed dead, and the panel says so rather than showing a spinner nobody
 *  ever takes down. Matches the claim's own stale window. */
const STALE_RUN_MS = 300_000

const FAILURE_LIST = 20
const DISAGREEMENT_LIST = 20

export type LiveUpdateFailure = {
  itemId: string
  merchantCentreUrl: string | null
  snapshot: PushSnapshot
  message: string
  failedAt: string
}

export type LiveUpdateDisagreement = {
  itemId: string
  merchantCentreUrl: string | null
  /** What this site sent. */
  sent: PushSnapshot
  /** What Google says it holds. Null when Google is not holding the item at all. */
  google: PushSnapshot | null
  checkedAt: string
}

export type LiveUpdatesView = {
  /** The owner's switch for live updates. */
  enabled: boolean
  /** The module's master switch. Nothing is sent while the feed itself is off:
   *  there are no listings to keep up to date. */
  feedEnabled: boolean
  /** Merchant Center has the supplemental feed. */
  setUp: boolean
  /** ...and the main feed takes from it. Being set up and not linked is a real
   *  state: Google accepts a supplemental feed nothing points at and then
   *  ignores every word of it, so nothing is sent while this is false.
   *
   *  THIS IS WHAT WE RECORDED WHEN WE LINKED IT, not a fresh answer from
   *  Google - and in particular it says nothing about the ORDER of that link,
   *  which is what decides whether any of it takes effect. An owner who unlinks
   *  it at Merchant Center, or reorders the rule so the feed answers first,
   *  will still see "connected" here until they press Check, which is the only
   *  thing that asks. Said on the panel too, because a stale yes is worse than
   *  no answer at all. */
  linked: boolean
  linkedAt: string | null
  dataSourceId: string | null
  debounceSeconds: number
  reconcileSample: number
  /** The three things that have to be filled in before anything can be sent. */
  ready: { credentials: boolean; merchantId: boolean; feedLabel: boolean }
  queued: number
  tracked: number
  unconfirmed: number
  failed: number
  differs: number
  lastRun: {
    startedAt: string | null
    finishedAt: string | null
    status: 'ok' | 'part' | 'failed' | null
    sent: number
    failed: number
    removed: number
    lastError: string | null
    /** A run is under way right now. */
    running: boolean
    /** A run started and never came back. NOT the same as "it failed" - nothing
     *  here knows how far it got. */
    stalled: boolean
  }
  lastCheck: { checkedAt: string | null; checked: number; differs: number }
  failures: LiveUpdateFailure[]
  disagreements: LiveUpdateDisagreement[]
}

function readSnapshot(value: unknown): PushSnapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (typeof row.price !== 'number' || typeof row.currency !== 'string' || typeof row.availability !== 'string') return null
  return {
    price: row.price,
    ...(typeof row.salePrice === 'number' ? { salePrice: row.salePrice } : {}),
    currency: row.currency,
    availability: row.availability as PushSnapshot['availability'],
  }
}

/** The console's page for one item, when there is an account to point at. */
function itemUrl(merchantId: string | null, feedLabel: string | null, offerId: string): string | null {
  return merchantId ? merchantCentreItemUrl({ merchantId, offerId, feedLabel }) : null
}

function toFailure(row: PushStateRow, merchantId: string | null, feedLabel: string | null): LiveUpdateFailure {
  return {
    itemId: row.itemId,
    merchantCentreUrl: itemUrl(merchantId, feedLabel, row.itemId),
    snapshot: row.snapshot,
    message: row.lastError ?? 'Google refused it and did not say why.',
    failedAt: (row.failedAt ?? row.sentAt).toISOString(),
  }
}

function toDisagreement(row: PushStateRow, merchantId: string | null, feedLabel: string | null): LiveUpdateDisagreement {
  const detail = row.reconcileDetail as { google?: unknown; checkedAt?: unknown } | null
  return {
    itemId: row.itemId,
    merchantCentreUrl: itemUrl(merchantId, feedLabel, row.itemId),
    sent: row.snapshot,
    google: readSnapshot(detail?.google),
    checkedAt: typeof detail?.checkedAt === 'string'
      ? detail.checkedAt
      : (row.reconciledAt ?? row.sentAt).toISOString(),
  }
}

export async function readLiveUpdatesView(): Promise<LiveUpdatesView> {
  const settings = await getGsfSettings()
  const [queued, totals, run, failures, disagreements] = await Promise.all([
    queueDepth(),
    readPushTotals(),
    readPushRun(),
    readRecentFailures(FAILURE_LIST),
    readDisagreements(DISAGREEMENT_LIST),
  ])

  const claimedFor = run.claimedAt ? Date.now() - run.claimedAt.getTime() : null
  const running = claimedFor !== null && claimedFor <= STALE_RUN_MS
  const stalled = claimedFor !== null && claimedFor > STALE_RUN_MS

  return {
    enabled: settings.pricePushEnabled,
    feedEnabled: settings.enabled,
    setUp: settings.pushDataSourceId !== null,
    linked: settings.pushLinkedSourceIds.length > 0,
    linkedAt: settings.pushLinkedAt?.toISOString() ?? null,
    dataSourceId: settings.pushDataSourceId,
    debounceSeconds: settings.pushDebounceSeconds,
    reconcileSample: settings.pushReconcileSample,
    ready: {
      credentials: hasGoogleCredentials(),
      merchantId: Boolean(settings.merchantId),
      feedLabel: Boolean(settings.feedLabel),
    },
    queued,
    tracked: totals.tracked,
    unconfirmed: totals.unconfirmed,
    failed: totals.failed,
    differs: totals.differs,
    lastRun: {
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      status: run.status,
      sent: run.sent,
      failed: run.failed,
      removed: run.removed,
      lastError: run.lastError,
      running,
      stalled,
    },
    lastCheck: {
      checkedAt: run.reconciledAt?.toISOString() ?? null,
      checked: run.reconcileChecked,
      differs: run.reconcileDiffers,
    },
    failures: failures.map((row) => toFailure(row, settings.merchantId, settings.feedLabel)),
    disagreements: disagreements.map((row) => toDisagreement(row, settings.merchantId, settings.feedLabel)),
  }
}
