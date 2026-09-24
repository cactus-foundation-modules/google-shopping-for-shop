// The ONE place a Merchant Center shipping service gets its name.
//
// Nothing else in this module may build a service name by joining strings
// together, and the rule is structural rather than stylistic. Google allows a
// service name 50 characters and refuses the WHOLE payload over it - not the
// offending service, the whole thing - so one over-long name loses every other
// service in the same push. A name built in two places is a limit enforced in
// one of them.
//
// Three properties, and all three are load-bearing:
//
//   fits      50 characters, always. The caller checks the answer again at the
//             point it assembles the payload, because "always" is a claim this
//             file makes and the payload is where being wrong costs a push.
//   unique    two services may never share a name. Merchant Center identifies
//             a service BY its name - there is no id - so two the same is two
//             things this site cannot tell apart afterwards, including when it
//             works out which services are its own to replace.
//   stable    the same catalogue names the same services the same way on every
//             run. Anything order-dependent or random would make every push
//             read as a change to settings nobody touched.
//
// Where a name cannot be made to fit AND stay unique, the answer is null and
// the caller refuses the push. Truncating into a duplicate is the one outcome
// worse than not sending.
import { MAX_SERVICE_NAME_LENGTH } from '@/modules/google-shopping-for-shop/lib/delivery/merchant-types'
import { shortHash } from '@/modules/google-shopping-for-shop/lib/delivery/short-hash'

/** One service wanting a name.
 *
 *  A site delivery service that takes different lengths of time for different
 *  groups becomes several of these - one per distinct speed - because Google
 *  holds one delivery time per service. See lib/delivery/mapping.ts. */
export type ServiceNameRequest = {
  /** Stable for this service and speed. Never shown to anybody: it is what the
   *  fingerprint of last resort is taken of, so it must not move between runs.
   *
   *  It is NOT how the answers are identified. Two requests may hand over the
   *  same key - two site services sharing a name is odd but not impossible -
   *  and returning a map keyed by this would have silently handed both of them
   *  the same Merchant Center service name, which is the exact failure the
   *  uniqueness rule exists to prevent. The answers come back positionally. */
  key: string
  /** What this site calls the delivery service. */
  label: string
  /** Working days to get it out of the door, at this speed. */
  handlingDays: number
  /** Working days on the road, at this speed. */
  transitDays: number
  /** True on the ONE speed that keeps the plain name - normally the speed most
   *  of the shop is delivered at, so the common case reads unchanged. */
  plain: boolean
}

function days(count: number): string {
  return `${count} ${count === 1 ? 'day' : 'days'}`
}

/**
 * A name cut to Google's 50 characters, with a fingerprint of the request on
 * anything that had to be cut.
 *
 * The fingerprint is what stops two long names that begin the same way from
 * becoming one name after truncation - the same trick, for the same reason, as
 * fitShippingLabel uses on labels next door. Cutting at the last space keeps
 * the result readable where there is a word boundary near enough to the end to
 * be worth using.
 */
function fit(text: string, key: string): string | null {
  const clean = text.trim().replace(/\s+/g, ' ')
  if (!clean) return null
  if (clean.length <= MAX_SERVICE_NAME_LENGTH) return clean

  const suffix = ` ~${shortHash(key)}`
  const room = MAX_SERVICE_NAME_LENGTH - suffix.length
  if (room <= 0) return null
  const hard = clean.slice(0, room)
  const lastSpace = hard.lastIndexOf(' ')
  const head = (lastSpace > room - 20 ? hard.slice(0, lastSpace) : hard).trimEnd()
  return head ? `${head}${suffix}` : null
}

/**
 * The names to try, in order, for one service.
 *
 * Each is a whole name rather than a fragment, so there is exactly one place a
 * service name is composed. Later entries say more about the speed, which is
 * what makes them different from the earlier ones when an earlier one is taken.
 */
function candidates(request: ServiceNameRequest): string[] {
  const wording = [
    // The speed in the owner's own terms, from the numbers rather than from an
    // invented word for "slow". A service whose groups all deliver at the same
    // speed never reaches this - it keeps the plain name.
    `${request.label} - ${days(request.transitDays)}`,
    // Two speeds that share a transit time and differ in the sending time need
    // both figures before they are different names.
    `${request.label} - ${days(request.transitDays)}, ${request.handlingDays} to send`,
    // Nothing readable left to distinguish them by. Stable, because the key is.
    `${request.label} ~${shortHash(request.key)}`,
  ]
  return request.plain ? [request.label, ...wording] : wording
}

/**
 * A unique, Google-legal name for every request, assigned in the order given.
 *
 * One answer per request, in the SAME ORDER, because that is the only thing
 * that cannot collide: the answers are the caller's to line back up by
 * position, never to look up by anything two requests might share.
 *
 * Order matters and must be stable: the first request to want a name keeps it.
 * The caller hands them over in catalogue order with the plain-named speed of
 * each service first, so the shop's ordinary services keep their ordinary
 * names and it is the unusual speeds that get qualified.
 *
 * A null entry means no name could be found that both fits and is unique. It
 * is not a name to be patched up by the caller - it is a refusal, and the push
 * says so rather than sending a duplicate.
 */
export function assignServiceNames(requests: ServiceNameRequest[]): Array<string | null> {
  const names: Array<string | null> = []
  const taken = new Set<string>()

  for (const request of requests) {
    let chosen: string | null = null
    for (const candidate of candidates(request)) {
      const name = fit(candidate, request.key)
      if (!name || taken.has(name)) continue
      chosen = name
      break
    }
    if (chosen) taken.add(chosen)
    names.push(chosen)
  }

  return names
}
