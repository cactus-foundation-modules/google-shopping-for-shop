// Values already in use in the catalogue, for the rule builder's value boxes
// to suggest. Pure.
import type { RuleSubject } from '@/modules/google-shopping-for-shop/lib/feed-rules/evaluate'

const SUGGESTION_LIMIT = 500

/** Every distinct text value of one fact across the catalogue, items and
 *  listings both, alphabetical, capped. Case is kept as the shop spells it;
 *  two spellings of one name differing only in case collapse to the first. */
export function distinctTextFacts(subjects: readonly RuleSubject[], key: string): string[] {
  const seen = new Map<string, string>()
  const take = (value: unknown) => {
    if (!Array.isArray(value)) return
    for (const entry of value) {
      if (typeof entry !== 'string') continue
      const trimmed = entry.trim()
      const folded = trimmed.toLowerCase()
      if (trimmed && !seen.has(folded)) seen.set(folded, trimmed)
    }
  }
  for (const subject of subjects) {
    take(subject.own[key])
    if (subject.parent) take(subject.parent[key])
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b)).slice(0, SUGGESTION_LIMIT)
}
