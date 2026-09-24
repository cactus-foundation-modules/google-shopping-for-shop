// Where the Google service-account key comes from, and what shape it has to be.
//
// The key is a Vercel environment variable the owner pastes in on the settings
// tab (see components/SettingsTab.tsx). The file-path fallbacks are for a
// self-hosted install that already mounts a credentials file for something else.
//
// The private key never leaves this module: it is used to sign one assertion in
// client.ts and is never returned to a route, put in an error, or logged.
import { readFileSync } from 'fs'

/** The Merchant API scope. Everything this module asks Google for lives under it. */
export const CONTENT_SCOPE = 'https://www.googleapis.com/auth/content'

export type GoogleCredentials = {
  /** The service account's own address, e.g. cactus@project.iam.gserviceaccount.com.
   *  An identifier, not a secret - it is what the owner adds as a Merchant
   *  Center user, so the settings tab shows it back to them. */
  clientEmail: string
  privateKey: string
  tokenUri: string
}

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token'

/** Parses a service-account JSON file's contents, or null if it is not one. */
export function parseGoogleCredentials(raw: string): GoogleCredentials | null {
  try {
    const parsed = JSON.parse(raw) as { client_email?: unknown; private_key?: unknown; token_uri?: unknown }
    if (typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') return null
    return {
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
      tokenUri: typeof parsed.token_uri === 'string' && parsed.token_uri ? parsed.token_uri : DEFAULT_TOKEN_URI,
    }
  } catch {
    return null
  }
}

/** The configured key, or null when there is none to be had. Read on every call
 *  rather than cached, so pasting a new key on the settings tab takes effect on
 *  the next request rather than the next deploy. */
export function googleCredentialsFromEnv(): GoogleCredentials | null {
  const inline = process.env.GOOGLE_SHOPPING_SERVICE_ACCOUNT_JSON ?? process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (inline) return parseGoogleCredentials(inline)

  const file = process.env.GOOGLE_SHOPPING_SERVICE_ACCOUNT_FILE ?? process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (!file) return null
  try {
    return parseGoogleCredentials(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Whether anything Google-facing can run at all. */
export function hasGoogleCredentials(): boolean {
  return googleCredentialsFromEnv() !== null
}

/** Set, but not a service-account key we can use - worth saying out loud, since
 *  "not set" and "the wrong file" need different advice. */
export function googleCredentialsAreMalformed(): boolean {
  const inline = process.env.GOOGLE_SHOPPING_SERVICE_ACCOUNT_JSON ?? process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (!inline) return false
  return parseGoogleCredentials(inline) === null
}
