// "Is Google Ads actually connected, and what will it let this site do?"
//
// The same idea as lib/google/access-check.ts next door, for the other API. It
// exists for the same reason: a connection that is almost right fails at the
// moment of use, halfway through a job the owner started, with Google's own
// wording and no advice attached. This asks up front, on a button press, and
// answers in English.
//
// Four questions, because they fail independently and need different fixes:
//
//   sign-in      the OAuth client, secret and refresh token are accepted, and
//                the account number names an account this sign-in can see.
//   spend        the shopping report can be queried. Read-only.
//   trackers     the conversion actions can be listed. Read-only.
//   send-sales   Google would accept an imported sale from this connection.
//
// THE LAST ONE SENDS A REQUEST AND WRITES NOTHING. Google's upload takes a
// `validateOnly` flag whose own reference says "the request is validated but
// not executed. Only errors are returned, not results", so the probe sends one
// deliberately fictitious click through that flag. Nothing is recorded at
// Google's end, no real shopper's data leaves this site, and the answer
// separates the two things an owner needs to tell apart: "this connection is
// not allowed to import sales at all" from "that particular click was not one
// Google recognised". There is no way to learn the first without asking.
//
// Nothing here returns or logs a credential. The account number is shown back
// because the owner typed it in.
import {
  googleAdsCredentialsFromEnv,
  missingAdsEnvVars,
} from '@/modules/google-shopping-for-shop/lib/google-ads/credentials'
import { adsRequest, searchAds } from '@/modules/google-shopping-for-shop/lib/google-ads/client'
import {
  ADS_ACCOUNT_QUERY,
  ADS_CONVERSION_ACTIONS_QUERY,
  adsSpendQuery,
} from '@/modules/google-shopping-for-shop/lib/google-ads/query'
import { parseAdsAccount } from '@/modules/google-shopping-for-shop/lib/google-ads/parse'
import {
  GoogleAdsApiError,
  GoogleAuthError,
  GoogleCredentialsError,
  parseAdsFailure,
} from '@/modules/google-shopping-for-shop/lib/google-ads/errors'
import { NOT_ALLOWLISTED, PROJECT_NOT_APPROVED, type AdsEnvVar } from '@/modules/google-shopping-for-shop/lib/google-ads/types'
import { conversionDateTime, explainBlock } from '@/modules/google-shopping-for-shop/lib/google-ads/upload'
import { addDays, todayUtc } from '@/modules/google-shopping-for-shop/lib/performance/days'

export const ADS_PROBES = ['sign-in', 'spend', 'trackers', 'send-sales'] as const
export type AdsProbeId = (typeof ADS_PROBES)[number]

/** ok: it worked. denied: Google understood and said no. unknown: something
 *  else went wrong, so the honest answer is that we do not know. */
export type AdsProbeStatus = 'ok' | 'denied' | 'unknown'

export type AdsProbe = {
  id: AdsProbeId
  /** What this lets the site do, in the owner's terms. */
  label: string
  status: AdsProbeStatus
  /** One or two sentences: what we found and, when it is not good news, what to
   *  do about it. */
  detail: string
}

export type AdsAccessReport = {
  checkedAt: string
  /** The environment variables that still have to be filled in, in the order
   *  the screen lists them. Empty means the sign-in can be attempted. */
  missing: AdsEnvVar[]
  /** The account number being asked about, digits only. Null when it is not
   *  set, which stops every probe. */
  customerId: string | null
  /** The manager account, when the sign-in goes through one. */
  loginCustomerId: string | null
  /** What Google calls the account, when it answered. */
  accountName: string | null
  currency: string | null
  timeZone: string | null
  probes: AdsProbe[]
}

const LABELS: Record<AdsProbeId, string> = {
  'sign-in': 'Sign in to your Google Ads account',
  spend: 'Read what your ads cost',
  trackers: 'See your sales trackers',
  'send-sales': 'Send your sales to Google Ads',
}

/** One retry and no more. The owner pressed a button and is watching; a check
 *  that sits there working through a full backoff is worse than one that says
 *  "not known" and invites another press. */
const PROBE_ATTEMPTS = 2

export type AdsProbeOptions = { attempts?: number; retryBaseMs?: number }

/**
 * The fictitious click the send-sales probe offers Google under `validateOnly`.
 *
 * Deliberately not a plausible click identifier. Google will always refuse it -
 * that is the point - and what matters is WHICH refusal comes back: a complaint
 * about this click means the connection is allowed to import sales, and a
 * complaint about the account means it is not.
 */
const PROBE_CLICK_ID = 'CACTUS-CONNECTION-CHECK-NOT-A-REAL-CLICK'
const PROBE_ORDER_ID = 'cactus-connection-check'

function probe(id: AdsProbeId, status: AdsProbeStatus, detail: string): AdsProbe {
  return { id, label: LABELS[id], status, detail }
}

/** Turns one failed call into an answer, without pretending to know more than
 *  Google said. */
function fromError(id: AdsProbeId, error: unknown, deniedAdvice: string): AdsProbe {
  if (error instanceof GoogleAuthError) {
    return probe(id, 'denied', error.message)
  }
  if (error instanceof GoogleAdsApiError && error.forbidden) {
    return probe(id, 'denied', `${explainBlock(error.code, error.message)} ${deniedAdvice}`.trim())
  }
  if (error instanceof GoogleAdsApiError) {
    return probe(id, 'unknown', `Google Ads answered with an error, so this one is unproven: ${error.message}`)
  }
  return probe(id, 'unknown', `The check could not be completed: ${error instanceof Error ? error.message : 'no answer from Google Ads'}`)
}

const CHECK_THE_ACCOUNT =
  'Check the account number, and that the Google account you granted access with can actually open that Google Ads account.'

export async function checkGoogleAdsAccess(input: {
  /** The conversion action already set up, when there is one. Without it the
   *  send-sales probe has nothing to offer a conversion against. */
  conversionAction: string | null
  options?: AdsProbeOptions
}): Promise<AdsAccessReport> {
  const options = input.options ?? {}
  const request: AdsProbeOptions = {
    attempts: options.attempts ?? PROBE_ATTEMPTS,
    ...(options.retryBaseMs === undefined ? {} : { retryBaseMs: options.retryBaseMs }),
  }
  const checkedAt = new Date().toISOString()
  const missing = missingAdsEnvVars()
  const credentials = googleAdsCredentialsFromEnv()

  if (!credentials) {
    const detail = 'Google Ads is not connected yet. The list above says exactly which details are still needed.'
    return {
      checkedAt,
      missing,
      customerId: null,
      loginCustomerId: null,
      accountName: null,
      currency: null,
      timeZone: null,
      probes: ADS_PROBES.map((id) => probe(id, 'unknown', detail)),
    }
  }

  const probes: AdsProbe[] = []
  let accountName: string | null = null
  let currency: string | null = null
  let timeZone: string | null = null

  // ---- 1. Sign in ----------------------------------------------------------
  let signedIn = false
  try {
    const rows = await searchAds(credentials.customerId, ADS_ACCOUNT_QUERY, request)
    const account = parseAdsAccount(rows[0])
    accountName = account.name
    currency = account.currency
    timeZone = account.timeZone
    signedIn = true
    probes.push(probe(
      'sign-in',
      'ok',
      account.name
        ? `Signed in and reading ${account.name}${currency ? `, which bills in ${currency}` : ''}.`
        : 'Signed in, and Google Ads answered for this account number.',
    ))
  } catch (error) {
    probes.push(fromError('sign-in', error, CHECK_THE_ACCOUNT))
  }

  const cannotAsk = 'The sign-in above has to work before this one can be checked.'
  if (!signedIn) {
    for (const id of ADS_PROBES) {
      if (!probes.some((held) => held.id === id)) probes.push(probe(id, 'unknown', cannotAsk))
    }
    return { checkedAt, missing, customerId: credentials.customerId, loginCustomerId: credentials.loginCustomerId, accountName, currency, timeZone, probes }
  }

  // ---- 2. The spend report -------------------------------------------------
  try {
    const today = todayUtc()
    await searchAds(credentials.customerId, adsSpendQuery({ from: addDays(today, -1), to: today }), request)
    probes.push(probe('spend', 'ok', 'Google Ads answered the shopping spend report, so the Reports tab can show what your ads cost.'))
  } catch (error) {
    probes.push(fromError('spend', error, 'This needs no more than read access to the account.'))
  }

  // ---- 3. The conversion actions -------------------------------------------
  try {
    const actions = await searchAds(credentials.customerId, ADS_CONVERSION_ACTIONS_QUERY, request)
    probes.push(probe(
      'trackers',
      'ok',
      actions.length === 0
        ? 'Your sales trackers can be read. There is no "Import from clicks" tracker on the account yet; "Set it up" makes one.'
        : `Your sales trackers can be read. The account has ${actions.length === 1 ? 'one' : actions.length} of the "Import from clicks" kind, switched on or off.`,
    ))
  } catch (error) {
    probes.push(fromError('trackers', error, 'Reading them needs no more than read access to the account.'))
  }

  // ---- 4. Would Google take a sale from us? --------------------------------
  probes.push(await checkSendSales(credentials.customerId, input.conversionAction, request))

  return {
    checkedAt,
    missing,
    customerId: credentials.customerId,
    loginCustomerId: credentials.loginCustomerId,
    accountName,
    currency,
    timeZone,
    probes,
  }
}

async function checkSendSales(
  customerId: string,
  conversionAction: string | null,
  request: AdsProbeOptions,
): Promise<AdsProbe> {
  if (!conversionAction) {
    return probe(
      'send-sales',
      'unknown',
      'There is nothing to send sales against yet. Press "Set it up" on the Health tab first, and this can be checked.',
    )
  }
  try {
    const reply = await adsRequest<{ partialFailureError?: unknown }>(`customers/${customerId}:uploadClickConversions`, {
      ...request,
      body: {
        // NOTHING IS RECORDED. Google's own reference for this flag: "the
        // request is validated but not executed. Only errors are returned, not
        // results."
        validateOnly: true,
        partialFailure: true,
        conversions: [{
          conversionAction,
          conversionDateTime: conversionDateTime(new Date()),
          conversionValue: 1,
          currencyCode: 'GBP',
          orderId: PROBE_ORDER_ID,
          consent: { adUserData: 'GRANTED' },
          gclid: PROBE_CLICK_ID,
        }],
      },
    })
    // Google took the request and complained only about the made-up click,
    // which is exactly what it should do - so the door is open.
    const failures = reply?.partialFailureError === undefined ? [] : parseAdsFailure({ error: reply.partialFailureError })
    const blocked = failures.find((failure) => {
      const code = failure.code?.toUpperCase()
      return code === NOT_ALLOWLISTED || code === PROJECT_NOT_APPROVED
    })
    if (blocked) return probe('send-sales', 'denied', explainBlock(blocked.code?.toUpperCase() ?? null, blocked.message))
    return probe(
      'send-sales',
      'ok',
      'Google Ads would accept imported sales from this site. Nothing was recorded by this check - it offered Google a '
      + 'deliberately made-up click and only asked whether the door was open.',
    )
  } catch (error) {
    if (error instanceof GoogleCredentialsError) return probe('send-sales', 'unknown', error.message)
    if (error instanceof GoogleAdsApiError) {
      const code = error.code?.toUpperCase() ?? null
      if (code === NOT_ALLOWLISTED || code === PROJECT_NOT_APPROVED) {
        return probe('send-sales', 'denied', explainBlock(code, error.message))
      }
      // Any other refusal was almost certainly about the made-up click, which
      // is the answer we were hoping for - but it is not proof, so it is not
      // reported as one.
      return probe(
        'send-sales',
        'unknown',
        `Google Ads answered, and its complaint was about the made-up click rather than about your account - which is the right `
        + `shape of answer, but not proof. Google said: ${error.message}`,
      )
    }
    return fromError('send-sales', error, '')
  }
}
