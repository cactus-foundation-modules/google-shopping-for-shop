// The shapes and the vocabulary Google Ads work is done in.
//
// Pure: no database, no fetch, no Prisma, no Node built-ins. Both the server
// and the browser import this, the same way lib/performance/types.ts and
// lib/health/types.ts are shared - so Google's words are translated at this one
// edge and a rename costs one mapping table rather than a search of every
// screen.
//
// Everything here was checked against Google's published reference for Google
// Ads API v25 on 2026-09-23, not remembered. The Google Ads API is not the
// Merchant API: different host, different sign-in, a version in the URL path,
// and an error envelope with the real complaint buried two levels down.

/**
 * The major version in the URL path.
 *
 * Google Ads puts its version in the path (`/v25/customers/...`) and issues a
 * new major roughly quarterly; minor releases (v25.1, v25.2) reuse the same
 * path and never break anything. v25 was current on 2026-09-23. When this is
 * raised, every field name below has to be checked again - a field removed in a
 * major version is a 400 at run time and nothing at all before it.
 */
export const ADS_API_VERSION = 'v25'

/** The host. Nothing else in this module talks to it. */
export const ADS_API_BASE = 'https://googleads.googleapis.com'

/** The one OAuth scope the Google Ads API accepts. Note it is NOT the Merchant
 *  API's `.../auth/content` - the two sign-ins have nothing in common. */
export const ADWORDS_SCOPE = 'https://www.googleapis.com/auth/adwords'

/** Google's token endpoint for swapping a refresh token for an access token. */
export const OAUTH_TOKEN_URI = 'https://oauth2.googleapis.com/token'

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** The environment variables this module reads, in the order the screen lists
 *  them. Named here so the settings tab, the connection check and the jobs all
 *  agree on the spelling. */
export const ADS_ENV_VARS = [
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_REFRESH_TOKEN',
  'GOOGLE_ADS_CUSTOMER_ID',
  'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
  'GOOGLE_ADS_DEVELOPER_TOKEN',
] as const
export type AdsEnvVar = (typeof ADS_ENV_VARS)[number]

/** The four that have to be there before anything can happen. */
export const ADS_REQUIRED_ENV_VARS: readonly AdsEnvVar[] = [
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_REFRESH_TOKEN',
  'GOOGLE_ADS_CUSTOMER_ID',
]

/** What each one is and where it comes from, for the owner rather than for a
 *  developer. Shown next to whichever ones are missing. */
export const ADS_ENV_COPY: Record<AdsEnvVar, { label: string; where: string; required: boolean }> = {
  GOOGLE_ADS_CLIENT_ID: {
    label: 'Google Ads sign-in ID',
    where: 'From the OAuth client you created in the Google Cloud console, under APIs and services, Credentials.',
    required: true,
  },
  GOOGLE_ADS_CLIENT_SECRET: {
    label: 'Google Ads sign-in secret',
    where: 'The secret that came with the same OAuth client. Treat it like a password.',
    required: true,
  },
  GOOGLE_ADS_REFRESH_TOKEN: {
    label: 'Google Ads permission token',
    where: 'Granted once, when you let that OAuth client read your Google Ads account. It does not expire on its own.',
    required: true,
  },
  GOOGLE_ADS_CUSTOMER_ID: {
    label: 'Google Ads account number',
    where: 'The ten-digit number at the top right of Google Ads. Dashes are fine - they are stripped out.',
    required: true,
  },
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: {
    label: 'Manager account number',
    where: 'Only needed if your Google Ads account sits underneath a manager account. Leave it empty otherwise.',
    required: false,
  },
  GOOGLE_ADS_DEVELOPER_TOKEN: {
    label: 'Developer token',
    where: 'No longer needed. Google retired developer tokens on 9 September 2026 and ignores the ones still being sent. '
      + 'If you have one, it is passed along and does no harm; if you are waiting on an application for one, you can stop.',
    required: false,
  },
}

// ---------------------------------------------------------------------------
// Why something did not happen
// ---------------------------------------------------------------------------

/** Every way a Google Ads job can decline to run. Each one is a sentence an
 *  owner can act on; no code is ever put in front of one. */
export const ADS_SKIP_REASONS = [
  'off',
  'spend-off',
  'upload-off',
  'no-credentials',
  'no-account',
  'no-conversion-action',
  'action-missing',
  'action-is-primary',
  'action-unchecked',
  'action-stale',
  'nothing-to-do',
  'already-running',
] as const
export type AdsSkipReason = (typeof ADS_SKIP_REASONS)[number]

export const ADS_SKIP_COPY: Record<AdsSkipReason, string> = {
  off: 'Google Ads is switched off for this site.',
  'spend-off': 'Fetching what your ads cost is switched off, so nothing was brought in.',
  'upload-off': 'Sending your sales to Google Ads is switched off, so nothing was sent.',
  'no-credentials': 'Google Ads is not connected yet. The settings tab lists exactly which details are missing.',
  'no-account': 'No Google Ads account number has been saved, so there is nothing to ask about.',
  'no-conversion-action': 'The sales tracker at Google Ads has not been set up yet. Press "Set it up" and this can start.',
  'action-missing': 'Google Ads no longer has the sales tracker this site was using - it looks as though it has been deleted over '
    + 'there. Nothing has been sent. Press "Set it up" to make a new one.',
  // The one refusal that protects the owner's money rather than their data.
  'action-is-primary': 'Google says the sales tracker this site uses is a PRIMARY one, which would have your sales counted twice - '
    + 'once by the tag in the shopper’s browser and once by this site. Nothing has been sent. Press "Set it up" to put it right.',
  'action-unchecked': 'Google has not been asked yet whether the sales tracker is set to secondary, and nothing is sent until it says so.',
  'action-stale': 'Google could not be asked whether the sales tracker is still set to secondary, and the last answer is too old to '
    + 'rely on - so nothing has been sent rather than risk your sales being counted twice. This usually sorts itself out on the next run.',
  'nothing-to-do': 'Everything is up to date - there is nothing new to send or fetch.',
  'already-running': 'A run is already under way.',
}

// ---------------------------------------------------------------------------
// The conversion upload
// ---------------------------------------------------------------------------

/** Google Ads click identifiers this module will upload.
 *
 *  `srsltid` is deliberately NOT here. Google appends it to free Shopping
 *  clicks and to ordinary search results as well as to ads; it is not a Google
 *  Ads click identifier, `ClickConversion` has no field for it, and stage 5
 *  already counts a bare `srsltid` as a FREE click. Uploading one would be a
 *  refusal at best and an invented ad click at worst. */
export const UPLOADABLE_CLICK_ID_KINDS = ['gclid', 'gbraid', 'wbraid'] as const
export type UploadableClickIdKind = (typeof UPLOADABLE_CLICK_ID_KINDS)[number]

export function isUploadableClickIdKind(value: unknown): value is UploadableClickIdKind {
  return typeof value === 'string' && (UPLOADABLE_CLICK_ID_KINDS as readonly string[]).includes(value)
}

/** How an upload of one order ended. */
export const UPLOAD_STATUSES = ['uploaded', 'refused', 'skipped'] as const
export type UploadStatus = (typeof UPLOAD_STATUSES)[number]

export function asUploadStatus(value: unknown): UploadStatus {
  return UPLOAD_STATUSES.includes(value as UploadStatus) ? (value as UploadStatus) : 'skipped'
}

/**
 * Google's `Consent.ConsentStatus`. Only GRANTED is ever sent from here,
 * because only a shopper who granted marketing consent has a stored click
 * identifier in the first place - stage 5 erases it on withdrawal.
 *
 * `adPersonalization` is NOT set. Google's own reference for `Consent` says of
 * it, in as many words: "This can only be set for OfflineUserDataJobService and
 * UserDataService." A click conversion upload is neither, and every one of
 * Google's own code samples for this call sets `adUserData` alone.
 */
export type AdsConsent = { adUserData: 'GRANTED' }

/** One `ClickConversion`, as the REST interface wants it: lowerCamelCase, and
 *  exactly one of the three click identifiers set. */
export type ClickConversionBody = {
  conversionAction: string
  /** "yyyy-mm-dd hh:mm:ss+|-hh:mm", and it must be AFTER the click. */
  conversionDateTime: string
  conversionValue: number
  currencyCode: string
  orderId: string
  consent: AdsConsent
  gclid?: string
  gbraid?: string
  wbraid?: string
}

/** The body of `customers/{id}:uploadClickConversions`.
 *
 *  `partialFailure` is Required and Google's reference says "This should always
 *  be set to true" - without it one bad row throws away the whole batch. */
export type UploadClickConversionsBody = {
  conversions: ClickConversionBody[]
  partialFailure: true
  validateOnly?: boolean
}

// ---------------------------------------------------------------------------
// Error codes worth telling apart
// ---------------------------------------------------------------------------

/**
 * The account, or the Google Cloud project behind the sign-in, is not allowed
 * to upload offline conversions at all.
 *
 * This is the likeliest answer a site will get, and it is not a bug here.
 * Google restricted offline conversion uploads on 15 June 2026 to tokens that
 * had already been using them, and points everybody else at its separate Data
 * Manager API. A brand new connection has no such history. The screens say so
 * in plain English rather than showing Google's code.
 */
export const NOT_ALLOWLISTED = 'CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE'

/** The Google Cloud project behind the sign-in only has Test access, so it may
 *  not touch a real account. v25's own error code for it. */
export const PROJECT_NOT_APPROVED = 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION'

/** Google could not find the click. Ordinary and per-row: the click is older
 *  than the account's window, belongs to another account, or was never an ad
 *  click. Worth retrying never, and worth alarming nobody. */
export const PER_ROW_CODES = new Set([
  'CLICK_NOT_FOUND',
  'EXPIRED_CLICK',
  'TOO_RECENT_CLICK',
  'CONVERSION_PRECEDES_EVENT',
  'DUPLICATE_ORDER_ID',
  'ORDER_ID_ALREADY_IN_USE',
  'INVALID_CONVERSION_ACTION_TYPE',
])

/**
 * A refusal about the whole account rather than about one sale.
 *
 * The difference decides whether the Health panel says "three of yesterday's
 * clicks were too old for Google" or "nothing is getting through at all", and
 * whether an alert goes up. Any code NOT in PER_ROW_CODES is treated as
 * account-wide, which is the cautious way round: a new per-row code Google adds
 * later raises a notice that a person then reads, rather than being silently
 * filed under "one of those things".
 */
export function isAccountWideCode(code: string | null): boolean {
  if (code === null) return true
  return !PER_ROW_CODES.has(code.trim().toUpperCase())
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** Google sends money as a whole number of millionths of a currency unit.
 *  Returns null for anything that is not a whole number, so "we could not read
 *  it" and "it was nothing" never look the same. */
export function microsToUnits(micros: bigint | number | null): number | null {
  if (micros === null) return null
  return Number(micros) / 1_000_000
}

/** Spend over sales, or null where there were no sales to divide by. A cost per
 *  sale with no sales is not zero - it is no answer. */
export function costPerSale(spend: number, sales: number): number | null {
  return sales > 0 ? spend / sales : null
}
