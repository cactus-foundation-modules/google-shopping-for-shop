// The ways a call to Google can go wrong, as types rather than bare strings.
//
// Everything here is caught somewhere that shows the message to a site owner,
// so each error carries a sentence that means something to one. The `status`
// and `reason` are for the code deciding whether to retry, and for the access
// check deciding between "your key is not allowed to do that" and "Google was
// having a moment".
//
// NOTHING in this file, or anything that builds one of these, may carry a
// credential: no private key, no access token, no Authorization header. The
// messages are Google's own text plus our own words, and that is all.

/** No usable service-account key is configured, or the JSON is not one. */
export class GoogleCredentialsError extends Error {
  constructor(message = 'Google credentials are not configured') {
    super(message)
    this.name = 'GoogleCredentialsError'
  }
}

/** Google refused to mint an access token for the key we hold. */
export class GoogleAuthError extends Error {
  constructor(message = 'Google would not accept these credentials') {
    super(message)
    this.name = 'GoogleAuthError'
  }
}

/** Google answered, and said no. */
export class GoogleApiError extends Error {
  /** HTTP status Google replied with. */
  readonly status: number
  /** Google's own machine-readable reason, e.g. 'PERMISSION_DENIED', when it sent one. */
  readonly reason: string | null
  /** The Retry-After header verbatim, when Google sent one. Seconds, as a string. */
  readonly retryAfter: string | null

  constructor(message: string, status: number, reason: string | null = null, retryAfter: string | null = null) {
    super(message)
    this.name = 'GoogleApiError'
    this.status = status
    this.reason = reason
    this.retryAfter = retryAfter
  }

  /** True while the same request stands a chance of working shortly: rate
   *  limits and Google's own wobbles. A 403 never does. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500
  }

  /** The service account is authenticated but is not allowed to do this. */
  get forbidden(): boolean {
    return this.status === 401 || this.status === 403
  }
}

/** The request never reached Google, or the answer never came back. */
export class GoogleNetworkError extends Error {
  constructor(message = 'Could not reach Google') {
    super(message)
    this.name = 'GoogleNetworkError'
  }
}
