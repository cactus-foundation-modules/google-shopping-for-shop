// "Can this key actually do what we are about to ask of it?"
//
// A service account with the wrong access level in Merchant Center fails at the
// moment of use, with Google's own wording, halfway through a job the owner
// started. This asks the three questions up front and answers them in English:
//
//   reports        the match snapshot, benchmark prices and (later) the
//                  performance figures. Read-only access is enough.
//   shipping       reading the account's delivery settings, which the Delivery
//                  tab diffs against what the site charges.
//   write          whether anything may be sent back to Merchant Center at all.
//                  STANDARD is enough for this one - it is what product updates
//                  will need.
//   delivery-push  SENDING the delivery settings, which is a stricter bar than
//                  the one above and has to be asked separately.
//
// The last two are NOT one question, and treating them as one told owners with
// a Standard key that they were ready to push delivery settings, right up until
// Google answered 403 halfway through. Google's own accounts_v1 discovery
// document says of shippingSettings.insert, in as many words: "Executing this
// method requires admin access." Nothing below may soften that.
//
// The write probe NEVER writes. It reads the service account's own entry in the
// account's user list, which carries the access rights Merchant Center granted
// it, and reads the answer off that.
//
// The service-account email is shown back to the owner on purpose: it is the
// thing they have to add as a user in Merchant Center, and it is an address,
// not a secret. The private key is never read here at all.
//
// Both endpoints below were checked against the Merchant API accounts_v1
// discovery document (revision 20260921) rather than remembered, because a
// probe against a path that does not exist answers 404 and reads as "you have
// not set that up" - the most misleading answer this file could give:
//   shipping  GET accounts/v1/{name}   name = accounts/{account}/shippingSettings
//   write     GET accounts/v1/{name}   name = accounts/{account}/users/{user}
// The access rights checked for are Google's own enum values on that user
// resource: ACCESS_RIGHT_UNSPECIFIED, STANDARD, READ_ONLY, ADMIN,
// PERFORMANCE_REPORTING, API_DEVELOPER - of which only STANDARD and ADMIN may
// change anything.
import {
  googleCredentialsAreMalformed,
  googleCredentialsFromEnv,
} from '@/modules/google-shopping-for-shop/lib/google/credentials'
import { merchantRequest } from '@/modules/google-shopping-for-shop/lib/google/client'
import { GoogleApiError, GoogleAuthError, GoogleCredentialsError } from '@/modules/google-shopping-for-shop/lib/google/errors'

export const ACCESS_PROBES = ['reports', 'shipping', 'write', 'delivery-push'] as const
export type AccessProbeId = (typeof ACCESS_PROBES)[number]

/** ok: it worked. denied: Google understood and said no. unknown: something
 *  else went wrong, so the honest answer is that we do not know. */
export type AccessProbeStatus = 'ok' | 'denied' | 'unknown'

export type AccessProbe = {
  id: AccessProbeId
  /** What this lets the site do, in the owner's terms. */
  label: string
  status: AccessProbeStatus
  /** One or two sentences: what we found and, when it is not good news, what to do. */
  detail: string
}

export type AccessReport = {
  checkedAt: string
  credentials: 'set' | 'missing' | 'malformed'
  /** The address to add as a Merchant Center user. Null when no key is set. */
  serviceAccountEmail: string | null
  /** Null when the account number has not been filled in, which stops every probe. */
  merchantId: string | null
  probes: AccessProbe[]
}

const LABELS: Record<AccessProbeId, string> = {
  reports: 'Read your Google reports',
  shipping: 'Read your Merchant Center delivery settings',
  write: 'Send product changes to Merchant Center',
  'delivery-push': 'Send your delivery settings to Merchant Center',
}

/** Access rights Merchant Center hands out, as Google's own `accessRights`
 *  enum spells them: ACCESS_RIGHT_UNSPECIFIED, STANDARD, READ_ONLY, ADMIN,
 *  PERFORMANCE_REPORTING, API_DEVELOPER.
 *
 *  Only these two may change anything at all; the rest can look but not touch. */
const WRITE_RIGHTS = new Set(['ADMIN', 'STANDARD'])

/** And only THIS one may replace the account's shipping settings. Google's
 *  discovery document says so of the insert method itself, so a Standard key
 *  that sails through the write probe above will still be refused the push. */
const ADMIN_RIGHTS = new Set(['ADMIN'])

type UserResource = { name?: string; state?: string; accessRights?: string[] }

/** One retry and no more. The owner pressed a button and is watching; a check
 *  that sits there for seven seconds working through a full backoff is worse
 *  than one that says "not known" and invites another press. */
const PROBE_ATTEMPTS = 2

export type ProbeOptions = {
  /** Total attempts per call, first included. */
  attempts?: number
  /** First backoff in milliseconds; 0 in tests. */
  retryBaseMs?: number
}

const NO_ACCOUNT = 'Fill in your Merchant Center account number above and this check can run.'

const ADD_THE_USER =
  'In Merchant Center, open Settings, then People and access, and add the address above as a user. '
  + 'Reading reports needs no more than the "Performance and insights" level.'

function probe(id: AccessProbeId, status: AccessProbeStatus, detail: string): AccessProbe {
  return { id, label: LABELS[id], status, detail }
}

/** Turns one failed call into an answer, without pretending to know more than
 *  Google said. A 401 or 403 is a real no; anything else is a shrug. */
function fromError(id: AccessProbeId, error: unknown, deniedAdvice: string): AccessProbe {
  if (error instanceof GoogleApiError && error.forbidden) {
    return probe(id, 'denied', `Google turned this down: ${error.message} ${deniedAdvice}`)
  }
  if (error instanceof GoogleApiError) {
    return probe(id, 'unknown', `Google answered with an error, so this one is unproven: ${error.message}`)
  }
  if (error instanceof GoogleAuthError) {
    return probe(id, 'denied', `Google would not accept the key at all: ${error.message} Paste the service-account JSON into the box above again.`)
  }
  return probe(id, 'unknown', `The check could not be completed: ${error instanceof Error ? error.message : 'no answer from Google'}`)
}

async function checkReports(merchantId: string, options: ProbeOptions): Promise<AccessProbe> {
  try {
    await merchantRequest(`reports/v1/accounts/${merchantId}/reports:search`, {
      ...options,
      method: 'POST',
      // One row is all it takes to prove the door opens.
      body: { query: 'SELECT product_view.offer_id FROM product_view', pageSize: 1 },
    })
    return probe('reports', 'ok', 'Google answered a report query, so match status and benchmark prices can be refreshed.')
  } catch (error) {
    return fromError('reports', error, ADD_THE_USER)
  }
}

async function checkShipping(merchantId: string, options: ProbeOptions): Promise<AccessProbe> {
  try {
    // accounts/v1/{name} with name = accounts/{account}/shippingSettings. The
    // same path the Delivery tab reads and writes, so a green tick here really
    // does mean the tab will work.
    await merchantRequest(`accounts/v1/accounts/${merchantId}/shippingSettings`, { ...options, method: 'GET' })
    return probe('shipping', 'ok', 'Your Merchant Center delivery settings can be read.')
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 404) {
      return probe('shipping', 'unknown', 'Merchant Center did not return any delivery settings for this account. If you have set some up, this check could not read them.')
    }
    return fromError(
      'shipping',
      error,
      'Delivery settings need at least the "Standard" access level, which is a step up from reporting.',
    )
  }
}

// The service account's own entry in the account's user list, which carries the
// access rights Merchant Center granted it. Read once and answered twice, so
// the two probes below cannot disagree with each other and so one press of the
// button is one call rather than two.
type UserLookup =
  | { status: 'ok'; rights: string[] }
  | { status: 'failed'; probeFor: (id: AccessProbeId, advice: string) => AccessProbe }

async function lookUpUser(merchantId: string, email: string, options: ProbeOptions): Promise<UserLookup> {
  try {
    const user = await merchantRequest<UserResource>(
      `accounts/v1/accounts/${merchantId}/users/${encodeURIComponent(email)}`,
      { ...options, method: 'GET' },
    )
    return { status: 'ok', rights: (user.accessRights ?? []).map((right) => right.toUpperCase()) }
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 404) {
      return {
        status: 'failed',
        probeFor: (id) => probe(id, 'denied', `Merchant Center has no user with that address on account ${merchantId}. ${ADD_THE_USER}`),
      }
    }
    return { status: 'failed', probeFor: (id, advice) => fromError(id, error, advice) }
  }
}

function checkWrite(lookup: UserLookup): AccessProbe {
  if (lookup.status === 'failed') return lookup.probeFor('write', 'Sending changes needs the "Standard" or "Admin" access level.')
  if (lookup.rights.some((right) => WRITE_RIGHTS.has(right))) {
    return probe('write', 'ok', 'This key may send product changes to Merchant Center.')
  }
  if (lookup.rights.length === 0) {
    return probe('write', 'unknown', 'Merchant Center did not say what this key is allowed to do. Check its access level under People and access.')
  }
  return probe(
    'write',
    'denied',
    'This key can look but not change anything. Raise it to "Standard" or "Admin" in Merchant Center under People and access.',
  )
}

function checkDeliveryPush(lookup: UserLookup): AccessProbe {
  if (lookup.status === 'failed') return lookup.probeFor('delivery-push', 'Sending delivery settings needs the "Admin" access level.')
  if (lookup.rights.some((right) => ADMIN_RIGHTS.has(right))) {
    return probe('delivery-push', 'ok', 'This key may send your delivery settings to Merchant Center.')
  }
  if (lookup.rights.length === 0) {
    return probe('delivery-push', 'unknown', 'Merchant Center did not say what this key is allowed to do. Check its access level under People and access.')
  }
  // The one place where "nearly enough" has to be said out loud. Standard is
  // enough for everything else this module sends and is not enough for this.
  return probe(
    'delivery-push',
    'denied',
    lookup.rights.includes('STANDARD')
      ? 'Sending delivery settings is the one thing Google insists on "Admin" for - "Standard" is not enough, and the send would be '
        + 'refused halfway through. Raise this key to "Admin" in Merchant Center under People and access.'
      : 'This key may not replace your delivery settings. Google insists on the "Admin" access level for that one, which you can set '
        + 'in Merchant Center under People and access.',
  )
}

/**
 * Just the one question: may this key change anything at all?
 *
 * For callers about to offer somebody a button that writes to their Merchant
 * Center account. checkGoogleAccess below asks all four, which is three API
 * calls; this asks the one that matters for a product write, which is one.
 *
 * It exists because the live price updates were offering to create and link a
 * data source on the strength of a `dataSources.list` succeeding - and a
 * reports-only key passes that, so the preview said yes and the write then came
 * back as a raw Google 403 with no advice attached to it. The probe's own
 * wording already says what to do about it.
 */
export async function checkWriteAccess(merchantId: string, options: ProbeOptions = {}): Promise<AccessProbe> {
  const request: ProbeOptions = { attempts: options.attempts ?? PROBE_ATTEMPTS, ...(options.retryBaseMs === undefined ? {} : { retryBaseMs: options.retryBaseMs }) }
  const credentials = googleCredentialsFromEnv()
  if (!credentials) {
    return probe(
      'write',
      'unknown',
      googleCredentialsAreMalformed()
        ? 'What is stored is not a Google service-account key. Download the JSON key file again and paste the whole thing into the box above.'
        : 'No service-account key has been saved yet, so there is nothing to check with.',
    )
  }
  return checkWrite(await lookUpUser(merchantId, credentials.clientEmail, request))
}

/**
 * Runs every probe.
 *
 * Sequential rather than parallel: several calls against the same account at
 * the same instant is exactly the shape Google rate-limits, and the whole thing
 * still finishes in about a second. The two access-level questions share one
 * lookup, so this is three calls and not four.
 */
export async function checkGoogleAccess(merchantId: string | null, options: ProbeOptions = {}): Promise<AccessReport> {
  const request: ProbeOptions = { attempts: options.attempts ?? PROBE_ATTEMPTS, ...(options.retryBaseMs === undefined ? {} : { retryBaseMs: options.retryBaseMs }) }
  const credentials = googleCredentialsFromEnv()
  const checkedAt = new Date().toISOString()

  if (!credentials) {
    const malformed = googleCredentialsAreMalformed()
    return {
      checkedAt,
      credentials: malformed ? 'malformed' : 'missing',
      serviceAccountEmail: null,
      merchantId,
      probes: ACCESS_PROBES.map((id) => probe(
        id,
        'unknown',
        malformed
          ? 'What is stored is not a Google service-account key. Download the JSON key file again and paste the whole thing into the box above.'
          : 'No service-account key has been saved yet, so there is nothing to check with.',
      )),
    }
  }

  if (!merchantId) {
    return {
      checkedAt,
      credentials: 'set',
      serviceAccountEmail: credentials.clientEmail,
      merchantId: null,
      probes: ACCESS_PROBES.map((id) => probe(id, 'unknown', NO_ACCOUNT)),
    }
  }

  const probes: AccessProbe[] = []
  try {
    probes.push(await checkReports(merchantId, request))
    probes.push(await checkShipping(merchantId, request))
    const lookup = await lookUpUser(merchantId, credentials.clientEmail, request)
    probes.push(checkWrite(lookup))
    probes.push(checkDeliveryPush(lookup))
  } catch (error) {
    // Only a missing key gets this far - every probe catches its own trouble.
    if (!(error instanceof GoogleCredentialsError)) throw error
    for (const id of ACCESS_PROBES) {
      if (!probes.some((existing) => existing.id === id)) probes.push(probe(id, 'unknown', error.message))
    }
  }

  return {
    checkedAt,
    credentials: 'set',
    serviceAccountEmail: credentials.clientEmail,
    merchantId,
    probes,
  }
}
