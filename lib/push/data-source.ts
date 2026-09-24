// The supplemental data source the live updates send into, and the link that
// makes Merchant Center take any notice of it.
//
// Two facts about Merchant Center shape everything here, both read off Google's
// own datasources_v1 discovery document (revision 20260923) rather than
// remembered from the older Content API:
//
//   1. A SUPPLEMENTAL data source holds partial data that is merged OVER a
//      primary one. That is exactly what this module wants: send a price and an
//      availability, leave the title, images, category and delivery to the feed
//      Google already fetches. Sending into the primary source instead would
//      replace the whole product with three attributes.
//
//   2. A supplemental source that is not LINKED into a primary one is accepted,
//      stored, and then completely ignored. Google says so in as many words on
//      the SupplementalProductDataSource resource: "After creation, you should
//      make sure to link the supplemental product data source into one or more
//      primary product data sources." So "created" and "working" are two
//      different states, and the screen must be able to tell them apart.
//
// Linking is a PATCH of the PRIMARY source's default rule, and Google is blunt
// about the hazard: "The update (patch) and create call replaces the entire
// default rule setup. It doesn't work as an addition." So it is read, merged
// and written back, exactly the way the delivery push handles shipping
// settings - never a blind write, and always with the previous state kept in
// the change log so it can be put back.
//
// The order of that list is FIRST-WINS, and our reference has to be first or
// the whole feature is a no-op. See linkedRule below, which spells out why.
//
// The feed label and content language are deliberately left unset on our
// source. Google allows that only for a data source with no file input - which
// an API source is - and both fields are IMMUTABLE once set. Leaving them off
// means each product input carries its own, and an owner who later changes
// their feed label does not find a data source that can never match again.
import { merchantRequest } from '@/modules/google-shopping-for-shop/lib/google/client'

/** The name Merchant Center shows this source under. Not a setting: an owner
 *  who renames it in Merchant Center keeps their name (nothing here writes the
 *  display name again), and an owner looking for "what is this?" gets a
 *  sentence rather than a code. */
export const PUSH_SOURCE_DISPLAY_NAME = 'Live price and stock updates (from your website)'

type CallOptions = { attempts?: number; retryBaseMs?: number; signal?: AbortSignal }

type RawDataSource = {
  name?: string
  dataSourceId?: string
  displayName?: string
  input?: string
  primaryProductDataSource?: {
    feedLabel?: string
    contentLanguage?: string
    defaultRule?: { takeFromDataSources?: Array<{ self?: boolean; supplementalDataSourceName?: string; primaryDataSourceName?: string }> }
  }
  supplementalProductDataSource?: { feedLabel?: string; contentLanguage?: string; referencingPrimaryDataSources?: unknown[] }
  fileInput?: { fetchSettings?: { fetchUri?: string } }
}

type ListResponse = { dataSources?: RawDataSource[]; nextPageToken?: string }

/** One reference in a primary source's default rule, in the shape Google's
 *  DataSourceReference wants it back. */
export type RuleReference = { self?: boolean; supplementalDataSourceName?: string }

/** What we need to know about one of the account's data sources. */
export type DataSourceDetail = {
  id: string
  /** The full resource name, which is what a rule reference has to spell. */
  name: string
  displayName: string
  kind: 'primary' | 'supplemental' | 'other'
  /** Primary sources only: the default rule as it stands, in order. */
  defaultRule: RuleReference[]
  /** The feed label the source declares, or '' when it declares none.
   *
   *  Carried rather than thrown away because it is half of a product's IDENTITY
   *  at Google (offer id + content language + feed label). A product input sent
   *  under a feed label the primary source does not publish is filed against a
   *  product nobody is advertising, Google accepts it without complaint, and
   *  nothing on the real listings ever moves. See setup.ts, which blocks on it. */
  feedLabel: string
  /** Same, for the two-letter content language. */
  contentLanguage: string
  fetchUri: string
}

const PAGE_SIZE = 200

function referenceOf(entry: { self?: boolean; supplementalDataSourceName?: string; primaryDataSourceName?: string }): RuleReference | null {
  if (entry.self === true) return { self: true }
  const supplemental = entry.supplementalDataSourceName?.trim()
  if (supplemental) return { supplementalDataSourceName: supplemental }
  // `primaryDataSourceName` is Google's own deprecated way of spelling `self`.
  // Carried across as `self` so a merge does not quietly drop it, which would
  // take the owner's own feed out of its own rule.
  if (entry.primaryDataSourceName?.trim()) return { self: true }
  return null
}

function detailOf(raw: RawDataSource, merchantId: string): DataSourceDetail | null {
  const id = raw.dataSourceId?.trim() || raw.name?.split('/').pop()?.trim() || ''
  if (!id) return null
  const kind: DataSourceDetail['kind'] = raw.primaryProductDataSource
    ? 'primary'
    : raw.supplementalProductDataSource ? 'supplemental' : 'other'
  return {
    id,
    name: raw.name?.trim() || `accounts/${merchantId}/dataSources/${id}`,
    displayName: raw.displayName?.trim() ?? '',
    kind,
    defaultRule: (raw.primaryProductDataSource?.defaultRule?.takeFromDataSources ?? [])
      .map(referenceOf)
      .filter((entry): entry is RuleReference => entry !== null),
    // Read off whichever half of the resource this source is. Both are optional
    // on both halves - a source with no file input may declare neither - so ''
    // means "declares none", which is a real and different answer from a
    // mismatch.
    feedLabel: (raw.primaryProductDataSource?.feedLabel ?? raw.supplementalProductDataSource?.feedLabel ?? '').trim(),
    contentLanguage: (raw.primaryProductDataSource?.contentLanguage ?? raw.supplementalProductDataSource?.contentLanguage ?? '').trim(),
    fetchUri: raw.fileInput?.fetchSettings?.fetchUri?.trim() ?? '',
  }
}

/** Every data source on the account, in the detail the link needs. */
export async function listDataSourceDetails(merchantId: string, options: CallOptions = {}): Promise<DataSourceDetail[]> {
  const details: DataSourceDetail[] = []
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) })
    if (pageToken) params.set('pageToken', pageToken)
    const page = await merchantRequest<ListResponse>(
      `datasources/v1/accounts/${merchantId}/dataSources?${params}`,
      { ...options, method: 'GET' },
    )
    for (const raw of page.dataSources ?? []) {
      const detail = detailOf(raw, merchantId)
      if (detail) details.push(detail)
    }
    pageToken = page.nextPageToken
  } while (pageToken)
  return details
}

/** One data source by id, or null when Google's answer had no id in it. */
export async function readDataSourceDetail(merchantId: string, dataSourceId: string, options: CallOptions = {}): Promise<DataSourceDetail | null> {
  const raw = await merchantRequest<RawDataSource>(
    `datasources/v1/accounts/${merchantId}/dataSources/${encodeURIComponent(dataSourceId)}`,
    { ...options, method: 'GET' },
  )
  return detailOf(raw, merchantId)
}

/**
 * Makes the supplemental source.
 *
 * Google's own note on this method is "This method always creates a new data
 * source", so nothing here may call it speculatively: the caller checks for one
 * we already own first. Returns null when Google accepted the create and its
 * reply could not be read, which is NOT a success - the caller has to go and
 * look rather than record an id it invented.
 */
export async function createSupplementalDataSource(merchantId: string, options: CallOptions = {}): Promise<DataSourceDetail | null> {
  const raw = await merchantRequest<RawDataSource>(`datasources/v1/accounts/${merchantId}/dataSources`, {
    ...options,
    method: 'POST',
    body: {
      displayName: PUSH_SOURCE_DISPLAY_NAME,
      // Empty on purpose: feedLabel and contentLanguage are immutable, and an
      // API source with neither accepts products carrying their own.
      supplementalProductDataSource: {},
    },
  })
  const detail = detailOf(raw, merchantId)
  return detail && detail.kind === 'supplemental' ? detail : null
}

/**
 * Where our source stands in a primary source's default rule.
 *
 * 'missing'  it is not in the list at all.
 * 'behind'   it is in the list, but AFTER `self` - so the fetched feed answers
 *            first and everything this module sends is ignored.
 * 'ahead'    it is in the list before `self`, which is the only arrangement in
 *            which any of this does anything.
 *
 * Membership is not the question, and that is the whole point of this function
 * existing. Asking `.some()` whether our source is in the list would call
 * [self, ours] linked - which is exactly the arrangement that made the feature
 * a silent no-op the first time round. A rule can be reordered after we wrote
 * it (an owner edits it in Merchant Center, another tool inserts a source), and
 * nothing would ever say so, so the thing that verifies the link has to verify
 * the ORDER.
 *
 * A rule with no `self` in it means Google ignores the primary feed's own
 * attributes entirely, so anything of ours in such a list wins by default:
 * present is 'ahead'.
 */
export type LinkPlacement = 'missing' | 'behind' | 'ahead'

export function linkPlacement(current: readonly RuleReference[], supplementalName: string): LinkPlacement {
  const ours = current.findIndex((entry) => entry.supplementalDataSourceName === supplementalName)
  if (ours === -1) return 'missing'
  const self = current.findIndex((entry) => entry.self === true)
  return self === -1 || ours < self ? 'ahead' : 'behind'
}

/**
 * The default rule a primary source should end up with, or null when ours is
 * already in front and there is nothing to do.
 *
 * OUR REFERENCE GOES FIRST, and getting that wrong is the difference between
 * this feature working and doing absolutely nothing.
 *
 * `takeFromDataSources` is FIRST-WINS. Google's own words on the field: "the
 * following list: [`1001`, `self`] will take attribute values from supplemental
 * data source `1001`, and fallback to `self` if the attribute is not set in
 * `1001`." So a list of [self, ours] means our price is consulted only for
 * attributes the primary feed leaves out - and lib/feed-xml.ts emits
 * `g:availability` and `g:price` on every single item, with `g:sale_price`
 * whenever there is an offer. Putting ourselves last would have left the live
 * values permanently outranked by the very feed they exist to get ahead of,
 * with no error anywhere to say so.
 *
 * So this also REPAIRS a rule where ours has fallen behind: it is taken out of
 * wherever it ended up and put back at the front, everything else keeping its
 * order. Without that, a rule reordered after we wrote it would leave the panel
 * saying "connected", the setup saying "nothing to do", and not one price
 * reaching a shopper.
 *
 * The rest of the merge:
 *   - an EMPTY list gets `self` added, because Google requires the list to be
 *     non-empty and says "If `self` is missing from the list of
 *     `take_from_data_sources`, the API will ignore attributes from the primary
 *     data source itself" - and an empty rule would leave the feed with nothing
 *     to read at all;
 *   - a NON-EMPTY list that happens to have no `self` is carried across exactly
 *     as it is, `self` and all its absence. That is somebody's deliberate
 *     setup - they have told Google to ignore the primary feed's own values -
 *     and quietly adding `self` back would be this module changing a decision
 *     it was not asked about;
 *   - everything already there is carried across untouched, in order, after us.
 *
 * SAID OUT LOUD: going first also puts us ahead of any OTHER supplemental
 * source the owner has. That is right for this one - a live price from the shop
 * that sells the thing should beat a price from a spreadsheet uploaded last
 * Tuesday - but it is a real change to their setup, so the preview says so and
 * the previous rule is kept in the change log.
 */
export function linkedRule(current: readonly RuleReference[], supplementalName: string): RuleReference[] | null {
  const placement = linkPlacement(current, supplementalName)
  if (placement === 'ahead') return null
  const carried = current.length > 0
    ? current.filter((entry) => entry.supplementalDataSourceName !== supplementalName)
    : [{ self: true }]
  return [{ supplementalDataSourceName: supplementalName }, ...carried]
}

/** The default rule with our reference taken back out. Null when it was not
 *  there. Never returns an empty list: Google refuses one, so a rule that held
 *  nothing but ours falls back to the primary source on its own. */
export function unlinkedRule(current: readonly RuleReference[], supplementalName: string): RuleReference[] | null {
  if (!current.some((entry) => entry.supplementalDataSourceName === supplementalName)) return null
  const kept = current.filter((entry) => entry.supplementalDataSourceName !== supplementalName)
  return kept.length > 0 ? kept : [{ self: true }]
}

/**
 * Writes one primary source's default rule.
 *
 * `updateMask` names exactly the one field, because Google deletes any field
 * named in the mask that the body leaves out - a mask of the whole resource
 * with a partial body would empty the source.
 */
export async function writeDefaultRule(
  merchantId: string,
  primaryId: string,
  takeFromDataSources: readonly RuleReference[],
  options: CallOptions = {},
): Promise<DataSourceDetail | null> {
  const raw = await merchantRequest<RawDataSource>(
    `datasources/v1/accounts/${merchantId}/dataSources/${encodeURIComponent(primaryId)}?updateMask=${encodeURIComponent('primaryProductDataSource.defaultRule')}`,
    {
      ...options,
      method: 'PATCH',
      body: { primaryProductDataSource: { defaultRule: { takeFromDataSources } } },
    },
  )
  return detailOf(raw, merchantId)
}
