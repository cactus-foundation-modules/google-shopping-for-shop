// What a Google Ads refusal looks like, and how to get the real complaint out
// of it.
//
// EXTENDS lib/google/errors.ts rather than replacing it: GoogleApiError,
// GoogleAuthError, GoogleCredentialsError and GoogleNetworkError already mean
// the right things and are already caught in the right places. What Google Ads
// adds is a second envelope - the HTTP status and the top-level message say
// almost nothing, and the sentence worth showing is two levels down:
//
//   { "error": { "code": 400, "message": "Request contains an invalid argument.",
//                "status": "INVALID_ARGUMENT",
//                "details": [ { "@type": ".../GoogleAdsFailure",
//                               "errors": [ { "errorCode": { "authorizationError": "..." },
//                                             "message": "...",
//                                             "location": { "fieldPathElements": [...] } } ],
//                               "requestId": "..." } ] } }
//
// `errorCode` is a protobuf oneof, so in JSON it is an object with exactly one
// key: the name of the error family, and the value is the enum. Both halves are
// worth keeping - the family says where the trouble is and the enum says what
// it was - and neither can be read off the HTTP status.
//
// The same shape turns up again inside a successful response, as
// `partialFailureError`, which is where a per-row refusal lives. So the parser
// below is used on both and knows nothing about which.
//
// NOTHING here may carry a credential: not the access token, not the refresh
// token, not the client secret. The messages are Google's own text and ours.
import { GoogleApiError } from '@/modules/google-shopping-for-shop/lib/google/errors'

/** One complaint out of a GoogleAdsFailure. */
export type AdsFailureItem = {
  /** The oneof's key, e.g. 'authorizationError', 'conversionUploadError'. */
  family: string | null
  /** The enum value, e.g. 'CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE'. */
  code: string | null
  message: string
  /** Which operation in the batch it was about, where Google said. -1 when it
   *  did not - a complaint about the request as a whole. */
  operationIndex: number
}

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null
}

/** The one key of the `errorCode` oneof, and its value. */
function readErrorCode(value: unknown): { family: string | null; code: string | null } {
  const record = asRecord(value)
  if (!record) return { family: null, code: null }
  for (const [family, enumValue] of Object.entries(record)) {
    if (typeof enumValue === 'string' && enumValue.trim() !== '') return { family, code: enumValue.trim() }
  }
  return { family: null, code: null }
}

/**
 * Which operation in the batch a complaint is about.
 *
 * Google reports it as a field path: the first element is named `operations`
 * or `conversions` and carries an `index`. Absent means the complaint is about
 * the request rather than about a row, and -1 says so rather than 0 - filing a
 * whole-request refusal against the first sale in the batch would leave the
 * other forty-nine looking as though they had gone through.
 */
function readOperationIndex(location: unknown): number {
  const elements = asRecord(location)?.fieldPathElements
  if (!Array.isArray(elements)) return -1
  for (const element of elements) {
    const index = asRecord(element)?.index
    if (typeof index === 'number' && Number.isInteger(index) && index >= 0) return index
    // int32 inside a repeated message still arrives as a number in JSON, but a
    // string is cheap to accept and costs nothing to be wrong about.
    if (typeof index === 'string' && /^\d+$/.test(index)) return Number(index)
  }
  return -1
}

/** Every complaint inside a `GoogleAdsFailure`-shaped object (a top-level
 *  `error`, or a `partialFailureError`). Empty when there is nothing to read,
 *  which the caller must treat as "we do not know" rather than "it was fine". */
export function parseAdsFailure(payload: unknown): AdsFailureItem[] {
  const root = asRecord(payload)
  if (!root) return []
  // A top-level failure nests the GoogleAdsFailure inside error.details[];
  // a partialFailureError IS the Status, with details[] directly on it.
  const status = asRecord(root.error) ?? root
  const details = Array.isArray(status.details) ? status.details : []
  const items: AdsFailureItem[] = []
  for (const detail of details) {
    const failure = asRecord(detail)
    const errors = failure && Array.isArray(failure.errors) ? failure.errors : []
    for (const entry of errors) {
      const error = asRecord(entry)
      if (!error) continue
      const { family, code } = readErrorCode(error.errorCode)
      items.push({
        family,
        code,
        message: typeof error.message === 'string' && error.message.trim() !== ''
          ? error.message.trim()
          : 'Google refused it and did not say why.',
        operationIndex: readOperationIndex(error.location),
      })
    }
  }
  return items
}

/** Google's `requestId`, which its own support asks for first. Never shown to a
 *  site owner; logged, so a developer can quote it. */
export function parseAdsRequestId(payload: unknown): string | null {
  const root = asRecord(payload)
  const status = asRecord(root?.error) ?? root
  const details = Array.isArray(status?.details) ? status.details : []
  for (const detail of details) {
    const id = asRecord(detail)?.requestId
    if (typeof id === 'string' && id.trim() !== '') return id.trim()
  }
  return null
}

/**
 * A refusal from the Google Ads API.
 *
 * Carries the HTTP status (so the shared retry rules still apply unchanged) and
 * the complaints underneath it. `message` is Google's own innermost sentence
 * where there is one, because the outer "Request contains an invalid argument"
 * tells nobody anything.
 */
export class GoogleAdsApiError extends GoogleApiError {
  readonly failures: AdsFailureItem[]
  readonly requestId: string | null

  constructor(input: {
    status: number
    /** The outer message, used only when there is nothing better underneath. */
    fallbackMessage: string
    failures: AdsFailureItem[]
    requestId: string | null
    retryAfter?: string | null
  }) {
    const first = input.failures[0]
    super(
      first?.message ?? input.fallbackMessage,
      input.status,
      first?.code ?? null,
      input.retryAfter ?? null,
    )
    this.name = 'GoogleAdsApiError'
    this.failures = input.failures
    this.requestId = input.requestId
  }

  /** The first enum Google gave, e.g. 'CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE'. */
  get code(): string | null {
    return this.failures[0]?.code ?? null
  }
}

export {
  GoogleApiError,
  GoogleAuthError,
  GoogleCredentialsError,
  GoogleNetworkError,
} from '@/modules/google-shopping-for-shop/lib/google/errors'
