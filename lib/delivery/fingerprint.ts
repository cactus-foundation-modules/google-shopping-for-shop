// A short, stable fingerprint of exactly what a push would send.
//
// The preview and the send are two separate requests, and the send rebuilds the
// plan from the database rather than trusting the browser - which is right, but
// on its own it means the thing sent need not be the thing read. Change a
// delivery price, or a feed rule that moves products between groups, in another
// tab between looking and pressing, and the owner confirms one payload and
// sends another.
//
// So the preview hands out this fingerprint, the send has to echo it back, and
// a send whose fingerprint no longer matches is refused with "this has changed
// since you looked" rather than going ahead. It is a guard against a race, not
// against an attacker: anyone who can call the route can read the current
// fingerprint, and that is fine - the point is that they then send what they
// have seen.
import { createHash } from 'crypto'
import type { MappedService } from '@/modules/google-shopping-for-shop/lib/delivery/mapping'

/**
 * Fingerprints the payload and the services that would be retired.
 *
 * The PAYLOAD, not the preview: two plans that would send byte-for-byte the
 * same thing to Google are the same plan, however the screen happens to word
 * it. Hashing the notes as well would refuse a send because a count in a
 * sentence had moved.
 */
export function planFingerprint(services: MappedService[], previouslyManaged: string[]): string {
  const payload = services
    .map((service) => service.payload)
    .sort((a, b) => String(a.serviceName ?? '').localeCompare(String(b.serviceName ?? '')))
  const retired = [...previouslyManaged].sort((a, b) => a.localeCompare(b))
  return createHash('sha256').update(JSON.stringify({ payload, retired })).digest('hex').slice(0, 16)
}
