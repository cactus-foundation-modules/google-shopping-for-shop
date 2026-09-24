// What the Health tab's Google Ads panel is given, in one shape.
//
// Assembled from our own tables only - opening the tab never rings Google. The
// buttons on the panel are the only things that pick up the telephone, which is
// the rule the whole Health tab follows.
//
// Dates cross to the browser as ISO strings. A Date in a server component's
// props arrives as an empty object, which this module learned the hard way
// once already.
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import {
  adsEnvPresence,
  missingAdsEnvVars,
} from '@/modules/google-shopping-for-shop/lib/google-ads/credentials'
import {
  readAdsRun,
  readAdsSpendExtent,
  readRecentUploads,
  readUploadProblems,
  readUploadTotals,
  countUploadableOrders,
  type UploadRecord,
} from '@/modules/google-shopping-for-shop/lib/google-ads/store'
import { MAX_UPLOAD_ATTEMPTS } from '@/modules/google-shopping-for-shop/lib/google-ads/upload'
import { MANAGED_ACTION_NAME } from '@/modules/google-shopping-for-shop/lib/google-ads/conversion-action'
import type { AdsEnvVar } from '@/modules/google-shopping-for-shop/lib/google-ads/types'

/** A run that claimed the slot and has not let go for longer than this is
 *  presumed dead, and the panel says so rather than showing a spinner nobody
 *  ever takes down. Matches the claim's own stale window. */
const STALE_RUN_MS = 300_000

const RECENT_LIST = 15
const PROBLEM_LIST = 20

export type AdsView = {
  /** The owner's master switch. */
  enabled: boolean
  /** ...and the separate one for writing to the account. */
  uploadEnabled: boolean
  spendImportEnabled: boolean
  spendBackfillDays: number
  spendRetentionDays: number

  /** Which environment variables are set, by name. Presence only - never a
   *  value, not even a masked one. */
  env: Record<AdsEnvVar, boolean>
  /** The required ones that are still missing, in the order to show them. */
  missing: AdsEnvVar[]
  connected: boolean
  /**
   * Whether the person reading this panel may enter those environment
   * settings. The panel itself sits behind `shop.products`, which is a weaker
   * permission than core's environment route requires, so the form has to be
   * withheld from everyone else - and carrying the fact here rather than in a
   * second request keeps the Health tab's one-read-per-panel rule intact.
   */
  isAdmin: boolean

  conversionAction: {
    /** Google's resource name, or null when nothing has been set up. */
    resourceName: string | null
    name: string | null
    /**
     * What GOOGLE said about whether it is primary. Null is "not known", and
     * the upload treats that exactly as it treats true: it refuses. The panel
     * has to be able to show the three states apart, because "we have not asked
     * " and "Google says yes, it is primary" need different words and only one
     * of them is alarming.
     */
    primary: boolean | null
    checkedAt: string | null
    /** The name this module gives one it makes, so the screen can tell the
     *  owner what to look for in Google Ads. */
    managedName: string
  }

  account: { currency: string | null; timeZone: string | null; checkedAt: string | null }

  uploads: {
    /** Sales waiting to be sent right now. */
    waiting: number
    uploaded: number
    refused: number
    skipped: number
    maxAttempts: number
    recent: UploadRecord[]
    problems: UploadRecord[]
  }

  lastRun: {
    startedAt: string | null
    finishedAt: string | null
    status: 'ok' | 'part' | 'failed' | null
    uploaded: number
    failed: number
    skipped: number
    lastError: string | null
    /** A run is under way right now. */
    running: boolean
    /** A run started and never came back. NOT the same as "it failed" - nothing
     *  here knows how far it got. */
    stalled: boolean
  }

  spend: {
    checkedAt: string | null
    failedAt: string | null
    lastError: string | null
    importedThrough: string | null
    heldFrom: string | null
    heldTo: string | null
    rowsHeld: number
  }
}

export async function readAdsView({ isAdmin }: { isAdmin: boolean }): Promise<AdsView> {
  const settings = await getGsfSettings()
  const [run, totals, waiting, recent, problems, extent] = await Promise.all([
    readAdsRun(),
    readUploadTotals(),
    countUploadableOrders(MAX_UPLOAD_ATTEMPTS),
    readRecentUploads(RECENT_LIST),
    readUploadProblems(PROBLEM_LIST),
    readAdsSpendExtent(),
  ])

  const claimedFor = run.claimedAt ? Date.now() - run.claimedAt.getTime() : null

  return {
    enabled: settings.adsEnabled,
    uploadEnabled: settings.adsConversionUploadEnabled,
    spendImportEnabled: settings.adsSpendImportEnabled,
    spendBackfillDays: settings.adsSpendBackfillDays,
    spendRetentionDays: settings.adsSpendRetentionDays,
    env: adsEnvPresence(),
    missing: missingAdsEnvVars(),
    connected: missingAdsEnvVars().length === 0,
    isAdmin,
    conversionAction: {
      resourceName: settings.adsConversionAction,
      name: settings.adsConversionActionName,
      primary: settings.adsConversionActionPrimary,
      checkedAt: settings.adsConversionActionCheckedAt?.toISOString() ?? null,
      managedName: MANAGED_ACTION_NAME,
    },
    account: {
      currency: settings.adsCurrency,
      timeZone: settings.adsTimeZone,
      checkedAt: settings.adsAccountCheckedAt?.toISOString() ?? null,
    },
    uploads: {
      waiting,
      uploaded: totals.uploaded,
      refused: totals.refused,
      skipped: totals.skipped,
      maxAttempts: MAX_UPLOAD_ATTEMPTS,
      recent,
      problems,
    },
    lastRun: {
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      status: run.status,
      uploaded: run.uploaded,
      failed: run.failed,
      skipped: run.skipped,
      lastError: run.lastError,
      running: claimedFor !== null && claimedFor <= STALE_RUN_MS,
      stalled: claimedFor !== null && claimedFor > STALE_RUN_MS,
    },
    spend: {
      checkedAt: run.spendCheckedAt?.toISOString() ?? null,
      failedAt: run.spendFailedAt?.toISOString() ?? null,
      lastError: run.spendLastError,
      importedThrough: run.spendImportedThrough,
      heldFrom: extent.from,
      heldTo: extent.to,
      rowsHeld: extent.rows,
    },
  }
}
