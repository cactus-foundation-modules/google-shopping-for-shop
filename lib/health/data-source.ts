// Finding our feed inside Merchant Center, and asking how the last fetch went.
//
// Merchant Center calls a feed a "data source" and gives it a number nobody
// here has ever seen. Rather than make the owner go and find it, the number is
// worked out by listing the account's data sources and matching the URL Google
// says it fetches against the feed address this site serves. The answer is
// cached in settings; an owner who has several feeds pointing at the same path
// can type the right number in and that always wins.
//
// Every call goes through lib/google/client.ts - one token cache, one retry
// policy, one error type. Nothing here ever writes to Google.
//
// API shapes confirmed against Google's own reference on 2026-09-22:
//   GET datasources/v1/accounts/{account}/dataSources
//   GET datasources/v1/accounts/{account}/dataSources/{id}/fileUploads/latest
// 'latest' is the only file upload alias Google accepts.
import { merchantRequest } from '@/modules/google-shopping-for-shop/lib/google/client'
import { isOurFeedUrl, parseFileUpload, type ParsedFileUpload, type RawFileUpload } from '@/modules/google-shopping-for-shop/lib/health/parse'

/** One of the account's data sources, in the two fields we care about. */
export type DataSourceSummary = {
  id: string
  displayName: string
  /** The URL Google fetches, or '' for a source Google does not fetch (a
   *  manual upload, or one fed through the API). */
  fetchUri: string
}

type RawDataSource = {
  name?: string
  dataSourceId?: string
  displayName?: string
  fileInput?: { fetchSettings?: { fetchUri?: string } }
}

type ListResponse = { dataSources?: RawDataSource[]; nextPageToken?: string }

/** Google caps this at 1,000 per page and an account with more data sources
 *  than that has other problems, but the token is followed anyway. */
const PAGE_SIZE = 200

type CallOptions = { attempts?: number; retryBaseMs?: number; signal?: AbortSignal }

/** Every data source on the account. */
export async function listDataSources(merchantId: string, options: CallOptions = {}): Promise<DataSourceSummary[]> {
  const sources: DataSourceSummary[] = []
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) })
    if (pageToken) params.set('pageToken', pageToken)
    const page = await merchantRequest<ListResponse>(
      `datasources/v1/accounts/${merchantId}/dataSources?${params}`,
      { ...options, method: 'GET' },
    )
    for (const raw of page.dataSources ?? []) {
      // The id is its own field, but a response that only carried `name`
      // (accounts/123/dataSources/456) is still usable, so both are tried.
      const id = raw.dataSourceId?.trim() || raw.name?.split('/').pop()?.trim() || ''
      if (!id) continue
      sources.push({
        id,
        displayName: raw.displayName?.trim() ?? '',
        fetchUri: raw.fileInput?.fetchSettings?.fetchUri?.trim() ?? '',
      })
    }
    pageToken = page.nextPageToken
  } while (pageToken)
  return sources
}

/** The data source whose fetch URL is our feed, or null when Google is not
 *  fetching this address at all. The first match wins; a shop with two feeds on
 *  the same address has to say which, which is what the setting is for. */
export function findOurDataSource(sources: readonly DataSourceSummary[], feedUrl: string): DataSourceSummary | null {
  return sources.find((source) => source.fetchUri !== '' && isOurFeedUrl(source.fetchUri, feedUrl)) ?? null
}

/** The state of the last fetch of one data source. */
export async function readLatestFileUpload(merchantId: string, dataSourceId: string, options: CallOptions = {}): Promise<ParsedFileUpload> {
  const raw = await merchantRequest<RawFileUpload>(
    `datasources/v1/accounts/${merchantId}/dataSources/${encodeURIComponent(dataSourceId)}/fileUploads/latest`,
    { ...options, method: 'GET' },
  )
  return parseFileUpload(raw)
}

/** One data source by id, for the display name and fetch URL beside a status
 *  the owner pinned by hand. */
export async function readDataSource(merchantId: string, dataSourceId: string, options: CallOptions = {}): Promise<DataSourceSummary | null> {
  const raw = await merchantRequest<RawDataSource>(
    `datasources/v1/accounts/${merchantId}/dataSources/${encodeURIComponent(dataSourceId)}`,
    { ...options, method: 'GET' },
  )
  const id = raw.dataSourceId?.trim() || raw.name?.split('/').pop()?.trim() || ''
  if (!id) return null
  return {
    id,
    displayName: raw.displayName?.trim() ?? '',
    fetchUri: raw.fileInput?.fetchSettings?.fetchUri?.trim() ?? '',
  }
}
