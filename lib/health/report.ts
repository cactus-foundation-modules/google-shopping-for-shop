// Everything the Health tab shows, gathered in one read.
//
// Deliberately cheap: counts and one page of items straight out of our own
// tables, plus the last feed fetch as we last recorded it. Nothing here calls
// Google - refreshing is a button, not a page load, because a Merchant API
// round trip on every open would make this the slowest screen in the admin and
// would burn the account's quota on people glancing at it.
//
// Honesty rule throughout: "we have never asked" and "we asked and everything
// is fine" are different answers and are never merged into one cheerful zero.
import { merchantCentreItemUrl } from '@/modules/google-shopping-for-shop/lib/merchant-centre-url'
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { hasGoogleCredentials } from '@/modules/google-shopping-for-shop/lib/google/credentials'
import { readStoredFeedFetch } from '@/modules/google-shopping-for-shop/lib/health/feed-fetch'
import {
  readAffectedItems,
  readIssueTotals,
  readTopIssueCodes,
  type AffectedItem,
  type IssueCodeCount,
  type IssueTotals,
} from '@/modules/google-shopping-for-shop/lib/health/item-issues'
import type { FeedFetchStatus, IssueSeverity } from '@/modules/google-shopping-for-shop/lib/health/types'
import type { DataSourceOrigin } from '@/modules/google-shopping-for-shop/lib/health/feed-fetch'

/** One item on the Health list, with somewhere to go and do something about it. */
export type HealthItem = AffectedItem & {
  /** Merchant Center's own page for this item, or null where the account
   *  number has not been filled in and there is no address to build. */
  merchantCentreUrl: string | null
}

export type HealthReport = {
  /** Null means item issues have never been read from Google. Not the same as
   *  "no issues", and the screen says so. */
  checkedAt: string | null
  totals: IssueTotals
  topCodes: IssueCodeCount[]
  items: { rows: HealthItem[]; total: number; page: number; pageCount: number; perPage: number }
  feed: {
    /** What we last recorded, or null when we have never recorded anything. */
    status: FeedFetchStatus | null
    /** Which data source we are reporting on, and how we know. */
    dataSourceId: string | null
    origin: DataSourceOrigin | null
  }
  /** Whether a refresh could even be attempted, and what is missing if not. */
  can: { refresh: boolean; credentials: boolean; merchantId: boolean }
  settings: {
    disapprovalAlertThreshold: number
    alertEmailEnabled: boolean
    /** Present so the tab can say where alerts go without a second fetch. The
     *  owner typed it in themselves and can see it on the settings tab. */
    alertEmail: string | null
  }
}

export type HealthQuery = {
  page: number
  perPage: number
  code?: string
  severity?: IssueSeverity
}

export const HEALTH_PAGE_SIZES = [25, 50, 100] as const

export async function readHealthReport(query: HealthQuery): Promise<HealthReport> {
  const settings = await getGsfSettings()
  const perPage = Math.min(Math.max(1, Math.trunc(query.perPage)), 200)
  const page = Math.max(1, Math.trunc(query.page))

  const [totals, topCodes, affected] = await Promise.all([
    readIssueTotals(),
    readTopIssueCodes(),
    readAffectedItems({
      limit: perPage,
      offset: (page - 1) * perPage,
      ...(query.code ? { code: query.code } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
    }),
  ])

  // A filter that shrank the list should not strand the owner on page 9 of 2 -
  // but the rows have already been read for the page they asked for, so the
  // honest answer is the page count beside an empty page rather than a second
  // query. The tab sends them back to page 1.
  const pageCount = Math.max(1, Math.ceil(affected.total / perPage))

  const dataSourceId = settings.feedDataSourceId ?? settings.feedDataSourceDetectedId
  const origin: DataSourceOrigin | null = settings.feedDataSourceId
    ? 'setting'
    : settings.feedDataSourceDetectedId
      ? 'detected'
      : null
  const status = dataSourceId ? await readStoredFeedFetch(dataSourceId) : null

  const credentials = hasGoogleCredentials()
  return {
    checkedAt: settings.issuesCheckedAt?.toISOString() ?? null,
    totals,
    topCodes,
    items: {
      rows: affected.rows.map((row) => ({
        ...row,
        merchantCentreUrl: settings.merchantId
          ? merchantCentreItemUrl({ merchantId: settings.merchantId, offerId: row.itemId, feedLabel: settings.feedLabel })
          : null,
      })),
      total: affected.total,
      page,
      pageCount,
      perPage,
    },
    feed: { status, dataSourceId, origin },
    can: {
      refresh: credentials && settings.merchantId !== null,
      credentials,
      merchantId: settings.merchantId !== null,
    },
    settings: {
      disapprovalAlertThreshold: settings.disapprovalAlertThreshold,
      alertEmailEnabled: settings.alertEmailEnabled,
      alertEmail: settings.alertEmail,
    },
  }
}
