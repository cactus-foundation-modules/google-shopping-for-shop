// Why Google refused a delivery push, in Google's words and in the owner's.
//
// This file exists because of an hour nobody will get back. A push was refused,
// the change log recorded the word 'failed' and nothing else, and the screen
// said "Could not send your delivery settings to Google. Compare them again to
// see what Merchant Center holds now." That sentence is true of every possible
// failure, which is another way of saying it is useful for none of them: it
// sent somebody off to look at the etag, because comparing is what it told them
// to do, when Google had already said plainly that the account was over its
// limit of delivery services.
//
// So two things, and the first matters more than the second:
//
//   1. Google's own account of the refusal is WRITTEN DOWN - status, message
//      and the validation codes out of `error.details` - onto the change log
//      entry for that push. Whatever we fail to understand today is then still
//      there to be read next week.
//   2. Where the cause is one we can name, the owner gets a sentence about
//      THAT rather than the generic one. Where it is not, they get the generic
//      sentence AND Google's own words underneath it, so the detail is never
//      only in a server log.
//
// Nothing here guesses. A code we do not recognise is passed through verbatim
// and described as unrecognised; inventing a plausible explanation for an error
// we have not seen is how the last hour was lost.
import {
  GoogleApiError,
  GoogleAuthError,
  GoogleCredentialsError,
  GoogleNetworkError,
} from '@/modules/google-shopping-for-shop/lib/google/errors'
import { MAX_SERVICES_PER_COUNTRY } from '@/modules/google-shopping-for-shop/lib/delivery/merchant-types'

/** Google's refusal, kept. Written to the change log entry and shown on screen.
 *
 *  Every field is optional-ish in practice - a network failure has no status
 *  and no codes - but the shape is fixed so a reader written next year can rely
 *  on it. It is jsonb by the time anybody reads it back. */
export type PushFailure = {
  /** HTTP status Google answered with, or null where it never answered. */
  status: number | null
  /** Google's machine-readable status, e.g. 'INVALID_ARGUMENT'. */
  reason: string | null
  /** Google's own sentence, verbatim. Never our paraphrase of it. */
  message: string
  /** The rules Google says were broken, out of its `error.details` - e.g.
   *  'TOO_MANY_SHIPPING_SERVICES_PER_COUNTRY'. Empty where it named none. */
  validationErrors: string[]
  /** What it means for the owner, in their terms. Generic ONLY where the cause
   *  is genuinely one we cannot name. */
  explanation: string
  /** True where `explanation` is the generic one, so the screen knows to lean
   *  on Google's own words rather than on ours. */
  generic: boolean
}

/** What the sentence needs to know about the push it is explaining. */
export type PushFailureContext = {
  /** Delivery services the refused payload held for this country, including
   *  ones this site does not manage. The cap counts all of them, so this is
   *  the figure the owner needs rather than the number we sent. */
  servicesInPayload: number
}

/** A run of capital letters and underscores - how Google writes every one of
 *  these codes. Deliberately narrow: a word in a sentence never matches. */
const CODE_PATTERN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g

/** Codes that only say "something was invalid" and name nothing. Kept out of
 *  the list so it holds causes rather than wrappers. */
const WRAPPER_CODES = new Set(['VALIDATION_ERRORS', 'INVALID_ARGUMENT', 'FAILED_PRECONDITION'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function codesIn(text: string): string[] {
  return (text.match(CODE_PATTERN) ?? []).filter((code) => !WRAPPER_CODES.has(code))
}

/**
 * The rules Google says were broken.
 *
 * `error.details` first, because that is where Google puts the real cause: a
 * shipping settings insert answers with an ErrorInfo whose reason is
 * VALIDATION_ERRORS and whose metadata names the rule. The message is only
 * fallen back on where the details held nothing, which is the case on older
 * responses and on APIs that never send details at all.
 *
 * Everything is read defensively. The shape of `details` is Google's to change
 * and this must never throw while trying to explain a failure - an explanation
 * that crashes is worse than the generic sentence it was meant to replace.
 */
export function validationCodes(details: unknown[], message: string): string[] {
  const found = new Set<string>()

  for (const detail of details) {
    if (!isRecord(detail)) continue
    if (typeof detail.reason === 'string') for (const code of codesIn(detail.reason)) found.add(code)
    const metadata = detail.metadata
    if (!isRecord(metadata)) continue
    for (const value of Object.values(metadata)) {
      if (typeof value !== 'string') continue
      for (const code of codesIn(value)) found.add(code)
    }
  }

  if (found.size === 0) for (const code of codesIn(message)) found.add(code)
  return [...found]
}

/** The causes we can put into the owner's own words. One entry per code, and a
 *  code goes in here only once somebody has seen Google send it. */
const NAMED: Record<string, (context: PushFailureContext) => string> = {
  TOO_MANY_SHIPPING_SERVICES_PER_COUNTRY: (context) =>
    `Google allows ${MAX_SERVICES_PER_COUNTRY} delivery services per country and this would make ${context.servicesInPayload} - `
    + 'remove some in Merchant Center, or ask fewer services to be sent.',
}

const GENERIC =
  'Google would not accept your delivery settings, so nothing has been changed. Its own words are below - if they mean nothing to '
  + 'you, they will mean something to whoever set the account up.'

/** The sentence for a refusal with no code in it, decided by what Google's
 *  answer can be relied on to mean. Each of these is a different thing for the
 *  owner to do, which is the whole test for whether it earns its own sentence. */
function byStatus(status: number): string | null {
  if (status === 401 || status === 403) {
    return 'Google would not let this site change your delivery settings. The key needs the "Admin" access level in Merchant Center, '
      + 'under People and access - "Standard" can read them but not write them.'
  }
  if (status === 429) {
    return 'Google is asking this site to slow down, so nothing has been sent. Wait a few minutes and send it again.'
  }
  if (status >= 500) {
    return 'Google was having a moment and could not take your delivery settings, so nothing has been changed. It is worth trying '
      + 'again shortly.'
  }
  return null
}

/**
 * What went wrong, kept and explained.
 *
 * Takes anything that was thrown, because the caller's catch does. Errors that
 * are not Google refusing - a network that dropped, a key that will not sign -
 * still get an entry, because "nothing was recorded" is the failure this whole
 * file exists to stop happening twice.
 */
export function describePushFailure(error: unknown, context: PushFailureContext): PushFailure {
  if (error instanceof GoogleApiError) {
    const validationErrors = validationCodes(error.details, error.message)
    const named = validationErrors.map((code) => NAMED[code]).find((make) => make !== undefined)
    const explanation = named ? named(context) : byStatus(error.status)
    return {
      status: error.status,
      reason: error.reason,
      message: error.message,
      validationErrors,
      explanation: explanation ?? GENERIC,
      generic: explanation === null,
    }
  }

  if (error instanceof GoogleCredentialsError) {
    return {
      status: null,
      reason: 'credentials',
      message: error.message,
      validationErrors: [],
      explanation: 'No usable Google key is saved on this site, so nothing could be sent. Paste the key file again on the Google '
        + 'Shopping settings tab.',
      generic: false,
    }
  }

  if (error instanceof GoogleAuthError) {
    return {
      status: null,
      reason: 'auth',
      message: error.message,
      validationErrors: [],
      explanation: 'Google would not accept this site\'s key, so nothing has been sent. Check the key on the Google Shopping '
        + 'settings tab is the current one for this account.',
      generic: false,
    }
  }

  if (error instanceof GoogleNetworkError) {
    return {
      status: null,
      reason: 'network',
      message: error.message,
      validationErrors: [],
      // Deliberately not "nothing was changed": the request left this site and
      // the answer never came back, so whether Google acted on it is exactly
      // what nobody knows.
      explanation: 'Google could not be reached, so it is not known whether your delivery settings went through. Compare them and '
        + 'you will see what Merchant Center holds now.',
      generic: false,
    }
  }

  return {
    status: null,
    reason: null,
    message: error instanceof Error ? error.message : String(error),
    validationErrors: [],
    explanation: GENERIC,
    generic: true,
  }
}

/** Google's own account of the refusal, as one line for the screen and the
 *  change log. Always shown, named cause or not: our sentence is a reading of
 *  Google's and the owner is entitled to the original. */
export function failureDetail(failure: PushFailure): string {
  const parts: string[] = []
  if (failure.status !== null) parts.push(`Google said ${failure.status}${failure.reason ? ` ${failure.reason}` : ''}`)
  else if (failure.reason) parts.push(`Google said ${failure.reason}`)
  if (failure.message) parts.push(failure.message)
  if (failure.validationErrors.length > 0) parts.push(failure.validationErrors.join(', '))
  return parts.join(': ')
}

/** Whether a stored snapshot holds one of these. Written by this build, read by
 *  a later one, so it is checked rather than cast. */
export function readPushFailure(value: unknown): PushFailure | null {
  if (!isRecord(value)) return null
  if (typeof value.message !== 'string' || typeof value.explanation !== 'string') return null
  return {
    status: typeof value.status === 'number' ? value.status : null,
    reason: typeof value.reason === 'string' ? value.reason : null,
    message: value.message,
    validationErrors: Array.isArray(value.validationErrors)
      ? value.validationErrors.filter((code): code is string => typeof code === 'string')
      : [],
    explanation: value.explanation,
    generic: value.generic === true,
  }
}
