// Where the Google Ads sign-in comes from, and what is missing when it is not
// all there.
//
// Deliberately NOT lib/google/credentials.ts. That file holds a Merchant Center
// service-account key: a private key this module signs an assertion with. This
// is a completely different thing - an OAuth client and a refresh token granted
// by a person, against a different API with a different scope - and sharing one
// "credentials" shape between them would mean every caller had to ask which
// kind it was holding.
//
// Read on every call rather than held in a module variable. That is not a way
// of picking up a change without a deploy - it cannot be: saving on the
// settings tab posts to core's own environment route, which writes the value to
// the hosting project and triggers a redeploy, so the new value arrives with
// the new build like every other environment variable. Reading per call simply
// means no stale copy survives inside a warm serverless instance.
//
// None of these values is ever returned to a route, put into an error, or
// logged.
import {
  ADS_ENV_COPY,
  ADS_ENV_VARS,
  ADS_REQUIRED_ENV_VARS,
  type AdsEnvVar,
} from '@/modules/google-shopping-for-shop/lib/google-ads/types'

export type GoogleAdsCredentials = {
  clientId: string
  clientSecret: string
  refreshToken: string
  /** Digits only. Google Ads account numbers are written 123-456-7890 and the
   *  API wants 1234567890. */
  customerId: string
  /** The manager account above this one, where there is one. Sent as the
   *  `login-customer-id` header. Null when the account is stood alone. */
  loginCustomerId: string | null
  /**
   * The old developer token, if this install still carries one.
   *
   * OPTIONAL, and that is not an oversight. Google sunset developer tokens on
   * 9 September 2026: its own guide says "You can continue sending developer
   * tokens in your API call headers, but this is optional and ignored by the
   * API servers", and that access is now decided by the Google Cloud project
   * that owns the OAuth client above. So a token is passed along when there is
   * one and nothing is gated on it - gating on it would leave this feature
   * permanently switched off on every install, because there is no longer any
   * way to obtain one.
   */
  developerToken: string | null
}

/** A Google Ads account number as the API wants it: digits, no dashes. Owners
 *  paste them with dashes, spaces or an "ID:" in front. Nothing left is "not
 *  set" rather than an empty string, so there is one answer to "is it there?". */
export function asAdsCustomerId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.replace(/\D+/g, '') || null
}

function read(name: AdsEnvVar): string | null {
  const value = process.env[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** Which of the environment variables are set. Presence only - never a value. */
export function adsEnvPresence(): Record<AdsEnvVar, boolean> {
  const present = {} as Record<AdsEnvVar, boolean>
  for (const name of ADS_ENV_VARS) present[name] = read(name) !== null
  return present
}

/** The required ones that are not there, in the order the screen lists them.
 *  Empty means the sign-in can be attempted. */
export function missingAdsEnvVars(): AdsEnvVar[] {
  return ADS_REQUIRED_ENV_VARS.filter((name) => read(name) === null)
}

/**
 * The sign-in, or null when it is not all there.
 *
 * Null carries no explanation on purpose: the caller that needs one asks
 * missingAdsEnvVars(), which names the variables and can be put on a screen
 * beside what each one is for.
 */
export function googleAdsCredentialsFromEnv(): GoogleAdsCredentials | null {
  const clientId = read('GOOGLE_ADS_CLIENT_ID')
  const clientSecret = read('GOOGLE_ADS_CLIENT_SECRET')
  const refreshToken = read('GOOGLE_ADS_REFRESH_TOKEN')
  const customerId = asAdsCustomerId(read('GOOGLE_ADS_CUSTOMER_ID'))
  if (!clientId || !clientSecret || !refreshToken || !customerId) return null
  return {
    clientId,
    clientSecret,
    refreshToken,
    customerId,
    loginCustomerId: asAdsCustomerId(read('GOOGLE_ADS_LOGIN_CUSTOMER_ID')),
    developerToken: read('GOOGLE_ADS_DEVELOPER_TOKEN'),
  }
}

/** Whether anything Google Ads-facing can run at all. */
export function hasGoogleAdsCredentials(): boolean {
  return googleAdsCredentialsFromEnv() !== null
}

/** What each missing variable is and where the owner gets it. Re-exported here
 *  so a screen needs one import rather than two. */
export { ADS_ENV_COPY, ADS_ENV_VARS, type AdsEnvVar }
