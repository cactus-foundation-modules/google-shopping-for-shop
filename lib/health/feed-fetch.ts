// "Did Google manage to read our feed?"
//
// The one question the Products tab cannot answer. Every count on that screen
// is what WE would send; this is what Google actually took, when, and what it
// thought of it. A feed that has silently stopped being fetched looks perfect
// from this side right up until the sales stop.
//
// Finding which Merchant Center data source is ours, in order:
//   1. the number the owner typed in, which always wins;
//   2. the number we worked out last time and cached;
//   3. a fresh discovery - list the account's data sources and match the URL
//      Google says it fetches against this site's feed address.
// A discovery is cached, so the list call happens roughly once rather than on
// every check. Step 2 is verified on use: if the cached id has gone, we fall
// through to a fresh discovery rather than reporting "not known" for ever.
import { prisma } from '@/lib/db/prisma'
import { getSiteUrlOrNull } from '@/lib/config/env'
import { feedUrl } from '@/modules/google-shopping-for-shop/lib/feed-url'
import { fetchUriForDisplay } from '@/modules/google-shopping-for-shop/lib/health/parse'
import { hasGoogleCredentials } from '@/modules/google-shopping-for-shop/lib/google/credentials'
import { GoogleApiError, GoogleCredentialsError } from '@/modules/google-shopping-for-shop/lib/google/errors'
import {
  findOurDataSource,
  listDataSources,
  readDataSource,
  readLatestFileUpload,
  type DataSourceSummary,
} from '@/modules/google-shopping-for-shop/lib/health/data-source'
import { getGsfSettings, rememberDetectedDataSource } from '@/modules/google-shopping-for-shop/lib/settings'
import {
  storedFetchState,
  type FeedFetchStatus,
  type FetchIssue,
  type FetchUnavailableReason,
} from '@/modules/google-shopping-for-shop/lib/health/types'

/** Where the data source number came from, so the screen can say. */
export type DataSourceOrigin = 'setting' | 'detected' | 'discovered'

export type FeedFetchOutcome =
  | { status: 'ok'; origin: DataSourceOrigin; fetch: FeedFetchStatus }
  | { status: 'unavailable'; reason: FetchUnavailableReason; detail: string | null }

type CallOptions = { attempts?: number; retryBaseMs?: number }

function unavailable(reason: FetchUnavailableReason, detail: string | null = null): FeedFetchOutcome {
  return { status: 'unavailable', reason, detail }
}

/** Google's own sentence when it refused, or nothing when it was something
 *  else. Never a credential - GoogleApiError carries Google's message and a
 *  status, and nothing of ours. */
function reasonFor(error: unknown): FeedFetchOutcome {
  if (error instanceof GoogleCredentialsError) return unavailable('no-credentials', error.message)
  if (error instanceof GoogleApiError && error.forbidden) return unavailable('denied', error.message)
  if (error instanceof GoogleApiError && error.status === 404) return unavailable('not-found', error.message)
  return unavailable('error', error instanceof Error ? error.message : null)
}

type Resolved = { source: DataSourceSummary; origin: DataSourceOrigin }

async function resolveDataSource(merchantId: string, ourFeedUrl: string, options: CallOptions): Promise<Resolved | FeedFetchOutcome> {
  const settings = await getGsfSettings()

  if (settings.feedDataSourceId) {
    // The owner's own answer. Read for its name and URL, but a read that fails
    // is not fatal: the id is still what they said, and the file upload call
    // below is the one that matters.
    const source = await readDataSource(merchantId, settings.feedDataSourceId, options).catch(() => null)
    return { source: source ?? { id: settings.feedDataSourceId, displayName: '', fetchUri: '' }, origin: 'setting' }
  }

  if (settings.feedDataSourceDetectedId) {
    const source = await readDataSource(merchantId, settings.feedDataSourceDetectedId, options).catch(() => null)
    // Still there, and still pointing at us: nothing to re-discover.
    if (source) return { source, origin: 'detected' }
    // Gone, renamed or repointed. Forget it and look again rather than
    // reporting on a feed that is no longer ours.
    await rememberDetectedDataSource(null)
  }

  const sources = await listDataSources(merchantId, options)
  const found = findOurDataSource(sources, ourFeedUrl)
  if (!found) return unavailable('not-found')
  await rememberDetectedDataSource(found.id)
  return { source: found, origin: 'discovered' }
}

/**
 * Asks Google how its last fetch went, and records the answer.
 *
 * Never throws for a Google refusal: every failure comes back as an
 * `unavailable` with a reason, because "we could not find out" has to read
 * differently from "all is well" on the screen, and an exception on the daily
 * cron would take the match refresh down with it.
 */
export async function refreshFeedFetchStatus(options: CallOptions = {}): Promise<FeedFetchOutcome> {
  if (!hasGoogleCredentials()) return unavailable('no-credentials')
  const settings = await getGsfSettings()
  if (!settings.merchantId) return unavailable('no-merchant-id')
  const ourFeedUrl = feedUrl(getSiteUrlOrNull(), settings.feedToken)
  if (!ourFeedUrl) return unavailable('no-site-url')

  let resolved: Resolved | FeedFetchOutcome
  try {
    resolved = await resolveDataSource(settings.merchantId, ourFeedUrl, options)
  } catch (error) {
    return reasonFor(error)
  }
  if ('status' in resolved) return resolved

  const { source, origin } = resolved
  try {
    const upload = await readLatestFileUpload(settings.merchantId, source.id, options)
    const checkedAt = new Date()
    // Host and path only. Google's fetchUri is the feed address we gave it,
    // secret key and all, and this value is read by a screen gated one
    // permission below the one the feed address itself needs. The full URI is
    // used for matching (findOurDataSource) and then deliberately dropped.
    const shownUri = fetchUriForDisplay(source.fetchUri) || null
    await storeFeedFetch({
      dataSourceId: source.id,
      displayName: source.displayName || null,
      fetchUri: shownUri,
      state: upload.state,
      itemsTotal: upload.itemsTotal,
      itemsCreated: upload.itemsCreated,
      itemsUpdated: upload.itemsUpdated,
      issues: upload.issues,
      uploadedAt: upload.uploadedAt?.toISOString() ?? null,
      checkedAt: checkedAt.toISOString(),
    })
    return {
      status: 'ok',
      origin,
      fetch: {
        dataSourceId: source.id,
        displayName: source.displayName || null,
        fetchUri: shownUri,
        state: upload.state,
        itemsTotal: upload.itemsTotal,
        itemsCreated: upload.itemsCreated,
        itemsUpdated: upload.itemsUpdated,
        issues: upload.issues,
        uploadedAt: upload.uploadedAt?.toISOString() ?? null,
        checkedAt: checkedAt.toISOString(),
      },
    }
  } catch (error) {
    // A 404 here means the data source exists but has never been fetched -
    // Google has no "latest" upload to give. That is a real, sayable state
    // rather than an error, and it is not an all clear either.
    return reasonFor(error)
  }
}

/** Writes the latest fetch for one data source, replacing what was there. */
export async function storeFeedFetch(status: FeedFetchStatus): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "gsf_feed_fetch_status"
      ("data_source_id", "display_name", "fetch_uri", "processing_state",
       "items_total", "items_created", "items_updated", "issues", "uploaded_at", "checked_at")
    VALUES (
      ${status.dataSourceId},
      ${status.displayName},
      ${status.fetchUri},
      ${status.state},
      ${status.itemsTotal === null ? null : BigInt(status.itemsTotal)},
      ${status.itemsCreated === null ? null : BigInt(status.itemsCreated)},
      ${status.itemsUpdated === null ? null : BigInt(status.itemsUpdated)},
      ${JSON.stringify(status.issues)}::jsonb,
      ${status.uploadedAt === null ? null : new Date(status.uploadedAt)},
      ${new Date(status.checkedAt)}
    )
    ON CONFLICT ("data_source_id") DO UPDATE SET
      "display_name" = EXCLUDED."display_name",
      "fetch_uri" = EXCLUDED."fetch_uri",
      "processing_state" = EXCLUDED."processing_state",
      "items_total" = EXCLUDED."items_total",
      "items_created" = EXCLUDED."items_created",
      "items_updated" = EXCLUDED."items_updated",
      "issues" = EXCLUDED."issues",
      "uploaded_at" = EXCLUDED."uploaded_at",
      "checked_at" = EXCLUDED."checked_at"
  `
}

type FetchRow = {
  data_source_id: string
  display_name: string | null
  fetch_uri: string | null
  processing_state: string
  items_total: string | null
  items_created: string | null
  items_updated: string | null
  issues: FetchIssue[] | null
  uploaded_at: Date | null
  checked_at: Date
}

function toStatus(row: FetchRow): FeedFetchStatus {
  const count = (value: string | null) => (value === null ? null : Number(value))
  return {
    dataSourceId: row.data_source_id,
    displayName: row.display_name,
    // Stripped again on the way out. It is stripped before it is stored, so
    // this is belt and braces - but the cost of one of these carrying a feed
    // key is a leaked secret, and the cost of stripping twice is nothing.
    fetchUri: fetchUriForDisplay(row.fetch_uri) || null,
    state: storedFetchState(row.processing_state),
    itemsTotal: count(row.items_total),
    itemsCreated: count(row.items_created),
    itemsUpdated: count(row.items_updated),
    issues: row.issues ?? [],
    uploadedAt: row.uploaded_at?.toISOString() ?? null,
    checkedAt: row.checked_at.toISOString(),
  }
}

// bigint columns are cast to text on the way out: Prisma hands a raw int8 back
// as a JavaScript BigInt, which JSON.stringify refuses outright - and these
// three go straight into a JSON response.
const SELECT_FETCH = `
  SELECT "data_source_id", "display_name", "fetch_uri", "processing_state",
         "items_total"::text AS "items_total", "items_created"::text AS "items_created",
         "items_updated"::text AS "items_updated", "issues", "uploaded_at", "checked_at"
  FROM "gsf_feed_fetch_status"
`

/** What we last heard about one data source, without asking Google again. */
export async function readStoredFeedFetch(dataSourceId: string): Promise<FeedFetchStatus | null> {
  const rows = await prisma.$queryRawUnsafe<FetchRow[]>(`${SELECT_FETCH} WHERE "data_source_id" = $1`, dataSourceId)
  const row = rows[0]
  return row ? toStatus(row) : null
}

/** Every data source we have ever recorded a fetch for, most recently checked
 *  first. Normally one; more where the owner has repointed us. */
export async function listStoredFeedFetches(): Promise<FeedFetchStatus[]> {
  const rows = await prisma.$queryRawUnsafe<FetchRow[]>(`${SELECT_FETCH} ORDER BY "checked_at" DESC`)
  return rows.map(toStatus)
}
