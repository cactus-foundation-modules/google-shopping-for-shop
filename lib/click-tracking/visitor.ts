// Who this visitor is, as far as this module is ever allowed to know.
//
// Two identifiers, and the difference between them is the whole privacy design:
//
//   session key    Derived, never stored anywhere but in the row it dedupes,
//                  and rotated every day. It is a keyed hash of the address and
//                  the browser string with the date mixed in, so it cannot be
//                  turned back into either, and yesterday's key for the same
//                  visitor is a different string - there is nothing to join a
//                  person's visits together with. Written for EVERY visitor,
//                  because stopping one refresh counting ten times is not
//                  tracking anybody.
//
//   attribution id A random value in a first-party cookie, written ONLY for a
//                  visitor who has granted the marketing consent category. This
//                  one really is a persistent identifier - it is how a sale
//                  thirty days later is joined back to the click that started
//                  it - which is exactly why it is not set without being asked.
//
// The hash key is the site's own ENCRYPTION_KEY, the same secret the receipt
// tokens are signed with. Without it there is no honest way to derive a key at
// all, so the caller is told so rather than being handed a predictable one.
import { createHmac, randomBytes } from 'crypto'
import type { NextRequest, NextResponse } from 'next/server'
import { getClientIp } from '@/lib/auth/rate-limit'
import { ATTRIBUTION_COOKIE, ATTRIBUTION_COOKIE_DAYS } from '@/modules/google-shopping-for-shop/lib/click-tracking/types'

/** An attribution id is 22 url-safe characters of base64. Anything else in the
 *  cookie was not minted here, and is treated as no cookie at all rather than
 *  sent to the database as a parameter. */
const ATTRIBUTION_ID = /^[A-Za-z0-9_-]{22}$/

function key(): string | null {
  return process.env.ENCRYPTION_KEY?.trim() || null
}

/** The UTC day the rotation is keyed on. UTC rather than local, so a server
 *  moved between regions does not silently re-key everyone mid-afternoon. */
function today(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function digest(purpose: string, parts: string[], secret: string): string {
  return createHmac('sha256', secret).update(`${purpose}:${parts.join('\u0000')}`).digest('base64url').slice(0, 32)
}

export type VisitorKeys = {
  /** Dedupe only. Rotates daily. */
  sessionKey: string
  /** The rate-limit bucket. Same inputs, different purpose string, so one
   *  cannot be used to look the other up. */
  rateKey: string
}

/**
 * The two derived keys for this request, or null when the site has no
 * ENCRYPTION_KEY and nothing can be derived honestly.
 *
 * Null is a refusal, not a fallback: a constant standing in for the key would
 * put every visitor in one dedupe bucket and one rate-limit bucket, which would
 * record roughly one landing an hour for the whole site and look, from the
 * outside, exactly like a shop nobody visits.
 */
export async function visitorKeys(request: NextRequest, now: Date = new Date()): Promise<VisitorKeys | null> {
  const secret = key()
  if (!secret) return null
  const ip = await getClientIp(request)
  // The browser string is in the mix so two people behind one office router are
  // usually two visitors rather than one. Cut, because a user agent is
  // attacker-controlled and there is no reason to hash a kilobyte of it.
  const agent = (request.headers.get('user-agent') ?? '').slice(0, 200)
  const day = today(now)
  return {
    sessionKey: digest('gsf-session', [ip, agent, day], secret),
    rateKey: digest('gsf-rate', [ip, day], secret),
  }
}

/** A fresh attribution id. 128 bits, so one cannot be guessed at, and nothing
 *  in it is derived from the visitor. */
export function mintAttributionId(): string {
  return randomBytes(16).toString('base64url')
}

/** The attribution id this browser is already carrying, or null. Never throws,
 *  and refuses anything that is not the shape we mint. */
export function readAttributionId(request: NextRequest): string | null {
  const raw = request.cookies.get(ATTRIBUTION_COOKIE)?.value?.trim()
  if (!raw || !ATTRIBUTION_ID.test(raw)) return null
  return raw
}

/**
 * Writes the attribution cookie onto the response.
 *
 * httpOnly, so no script on the page can read it, post it somewhere, or hand a
 * different visitor's id to the conversion route. The route reads it off the
 * request itself and takes no such id from a request body, which is what stops
 * anyone claiming somebody else's click.
 *
 * Re-set on every landing by a consenting visitor, which is what makes it "last
 * click wins": the expiry rolls forward and the newest landing is the one the
 * sale is joined to.
 */
export function setAttributionCookie(response: NextResponse, attributionId: string): void {
  response.cookies.set(ATTRIBUTION_COOKIE, attributionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ATTRIBUTION_COOKIE_DAYS * 24 * 60 * 60,
  })
}

/** Drops it. Used when a visitor who once agreed has since withdrawn: the
 *  landing still counts, the link to their next order does not. */
export function clearAttributionCookie(response: NextResponse): void {
  response.cookies.set(ATTRIBUTION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  })
}
