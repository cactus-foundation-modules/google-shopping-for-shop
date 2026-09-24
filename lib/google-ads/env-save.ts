// Saving the Google Ads sign-in details from the Health tab.
//
// The panel does not write anything itself. It posts to core's own environment
// route (`POST /api/admin/env`), which is admin-only, trims each value, refuses
// any key no installed module DECLARES in its manifest, writes the rest to the
// hosting project and then raises the "this site needs redeploying" notice.
// This module's manifest already declares all six GOOGLE_ADS_* names, so that
// route accepts them with no core edit.
//
// Everything here is pure: what to send, and what to say about what came back.
// Nothing touches the network, so the sentences an owner reads can be tested
// without a browser, a session or a Vercel token - which is the whole point,
// because the failure cases (no token, local mode, not an admin) are exactly
// the ones nobody can reproduce on the machine they are writing them on.
import { ADS_ENV_COPY, type AdsEnvVar } from '@/modules/google-shopping-for-shop/lib/google-ads/types'

/**
 * The details the form offers, in the order it shows them.
 *
 * GOOGLE_ADS_DEVELOPER_TOKEN is deliberately NOT among them. Google retired
 * developer tokens on 9 September 2026 and ignores the ones still being sent;
 * a box asking for one would be a box nobody can fill in any more. The panel
 * still says so in words, so an owner waiting on an application can stop.
 */
export const ADS_ENV_FIELDS: readonly AdsEnvVar[] = [
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_REFRESH_TOKEN',
  'GOOGLE_ADS_CUSTOMER_ID',
  'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
]

export type AdsEnvEntry = { key: AdsEnvVar; value: string }

/**
 * The details actually filled in, trimmed.
 *
 * A blank box leaves that setting exactly as it is. Core's route skips blanks
 * too, but they are dropped here as well so a save of nothing never reaches
 * the network and never draws a "saved" message over a write that did not
 * happen.
 */
export function adsEnvVarsToSave(values: Partial<Record<AdsEnvVar, string>>): AdsEnvEntry[] {
  const entries: AdsEnvEntry[] = []
  for (const key of ADS_ENV_FIELDS) {
    const value = (values[key] ?? '').trim()
    if (value !== '') entries.push({ key, value })
  }
  return entries
}

function name(key: string): string {
  return key in ADS_ENV_COPY ? ADS_ENV_COPY[key as AdsEnvVar].label : key
}

function list(keys: string[]): string {
  const labels = keys.map(name)
  const last = labels.pop()
  if (last === undefined) return ''
  return labels.length === 0 ? last : `${labels.join(', ')} and ${last}`
}

/**
 * What to say after a save that went through.
 *
 * The redeploy notice is core's doing, not ours - it is raised inside the same
 * route, on the same success. Saying so here is only safe because this is
 * never called for a response that was not ok.
 */
export function describeAdsEnvSave(written: number, skipped: string[]): string {
  const saved = written === 1 ? 'One detail was saved.' : `${written} details were saved.`
  const parts = [saved]
  if (skipped.length > 0) {
    parts.push(
      `${list(skipped)} ${skipped.length === 1 ? 'was' : 'were'} not saved - this site does not manage `
      + `${skipped.length === 1 ? 'that setting' : 'those settings'}. It usually means the Google Shopping module `
      + 'needs updating before it will take them.',
    )
  }
  parts.push(
    'Nothing changes until the site is rebuilt: the details only reach the running site on its next deployment. '
    + 'A notice has been raised on the dashboard to remind you.',
  )
  return parts.join(' ')
}

/**
 * What to say after a save that did not.
 *
 * Every one of these is core's own refusal turned into a sentence an owner can
 * act on. The raw message is never shown: two of the three 503s read
 * identically to somebody who has never heard of a deploy token.
 */
export function describeAdsEnvSaveFailure(status: number, message: string): string {
  if (status === 401) {
    return 'You are not signed in any more. Sign in again and have another go.'
  }
  if (status === 403) {
    return 'Only an administrator can save these details. Ask whoever looks after this site to enter them.'
  }
  if (status === 503) {
    // The route has two 503s and they want opposite things doing. The local one
    // names the file it wants edited; the other names the two deploy settings.
    if (/local[- ]development|\.env\.local/i.test(message)) {
      return 'This site is running on your own machine, where these details live in the .env.local file rather than '
        + 'on the hosting account. Put them in that file and restart the development server.'
    }
    return 'This site is not connected to its hosting account, so nothing can be saved from here. Add these details in '
      + 'the hosting dashboard by hand, or connect the hosting account first and try again.'
  }
  if (status === 400) {
    // Core answers 400 when it manages NONE of the keys sent. Its own sentence
    // names them, but in their raw spelling, which is not what is on screen.
    return 'This site does not manage those settings, so none of them were saved. It usually means the Google Shopping '
      + 'module needs updating before it will take them.'
  }
  if (status === 502) {
    return 'The hosting account refused to store them, so nothing was saved. Nothing has been half-done - try again in a '
      + 'moment, and if it keeps happening the hosting account is the place to look.'
  }
  return message.trim() !== '' ? message : 'Those details could not be saved. Try again in a moment.'
}
