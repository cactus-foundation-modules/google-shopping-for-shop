// A short, stable fingerprint of a string, for the rare case where a name has
// to be made unique and there is nothing left to distinguish it by.
//
// Shared by the two places that name something Google matches on - shipping
// labels and shipping service names - because both need the same property and
// neither may invent its own: the fingerprint must be the SAME on every run
// for the same input. A random suffix, a counter, or anything derived from
// insertion order would rename a label or a service between one push and the
// next, and every push would then read as a change to settings nobody touched.
//
// FNV-1a, base 36. Not a cryptographic hash and not used as one: it exists to
// separate two names, not to hide anything.

/** Six base-36 characters, deterministic for the same input. */
export function shortHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).slice(0, 6)
}
