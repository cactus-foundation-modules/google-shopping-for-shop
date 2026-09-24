// The facts feed rules are asked about, gathered for every item in the feed.
//
// Most facts are already in hand while the feed builds each row (price, stock,
// supplier, photos) and are written straight onto the subject there. Two need
// a read of their own and live here: the categories a product is filed in,
// with every category above them, and product attribute values, which come
// from whichever module publishes attributes.
//
// Attributes are read only for the ones a rule actually names (plus the range
// attribute). Asking for all of them would be one read per attribute over the
// whole catalogue, on every feed fetch, for answers nothing uses.
import { prisma } from '@/lib/db/prisma'
import { getProductAttributeValues } from '@/modules/google-shopping-for-shop/lib/product-labels'
import { attributeFieldKey, attributeIdOf } from '@/modules/google-shopping-for-shop/lib/feed-rules/fields'
import { flattenConditions, type RuleGroup } from '@/modules/google-shopping-for-shop/lib/feed-rules/types'
import type { FactValue, RuleFacts, RuleSubject } from '@/modules/google-shopping-for-shop/lib/feed-rules/evaluate'

/** A text fact from one value that may be missing or blank. */
export function textFact(value: string | null | undefined): readonly string[] {
  const trimmed = value?.trim()
  return trimmed ? [trimmed] : []
}

/** Every category these ids sit in or under, each once. Walks up the tree from
 *  each, with a hop limit so a loop in the parent ids cannot hang the feed. */
export function categoryTrail(categoryIds: Iterable<string>, parentOf: ReadonlyMap<string, string | null>): string[] {
  const seen = new Set<string>()
  for (const start of categoryIds) {
    let current: string | null | undefined = start
    for (let hops = 0; current && hops < 20 && !seen.has(current); hops++) {
      seen.add(current)
      current = parentOf.get(current)
    }
  }
  return [...seen]
}

/** Every category each product is filed in, by product id. One read, with the
 *  ids as a single array parameter so a catalogue-sized list has no ceiling. */
export async function readProductCategories(productIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  const ids = [...new Set(productIds)].filter(Boolean)
  if (ids.length === 0) return map
  const rows = await prisma.$queryRaw<Array<{ product_id: string; category_id: string }>>`
    SELECT "product_id", "category_id" FROM "shp_product_categories"
    WHERE "product_id" = ANY(${ids}::text[])
  `
  for (const row of rows) {
    const list = map.get(row.product_id) ?? []
    list.push(row.category_id)
    map.set(row.product_id, list)
  }
  return map
}

/** The attributes these rules (or drafts) name, each once. */
export function attributeIdsIn(rules: ReadonlyArray<{ conditions: RuleGroup }>): string[] {
  const ids = new Set<string>()
  for (const rule of rules) {
    for (const condition of flattenConditions(rule.conditions)) {
      const id = attributeIdOf(condition.field)
      if (id) ids.add(id)
    }
  }
  return [...ids]
}

/**
 * Writes each attribute's values onto every subject: the row's own ticks on
 * `own`, the listing's on the shared parent facts. An attribute with nothing
 * ticked is written as an empty list rather than left out, so "is empty" can
 * tell "read, and blank" from "never read".
 *
 * `rangeAttributeId`, when it is one of these, also answers as the Range field.
 */
export async function fillAttributeFacts(
  subjects: readonly RuleSubject[],
  attributeIds: readonly string[],
  rangeAttributeId: string | null,
): Promise<void> {
  if (subjects.length === 0 || attributeIds.length === 0) return
  const parents = new Map<string, RuleFacts>()
  for (const subject of subjects) {
    if (subject.parentId && subject.parent) parents.set(subject.parentId, subject.parent)
  }
  const ids = [...subjects.map((subject) => subject.itemId), ...parents.keys()]

  for (const attributeId of attributeIds) {
    const values = await getProductAttributeValues(attributeId, ids)
    const key = attributeFieldKey(attributeId)
    const write = (facts: RuleFacts, productId: string) => {
      const value: FactValue = values.get(productId) ?? []
      facts[key] = value
      if (attributeId === rangeAttributeId) facts.range = value
    }
    for (const subject of subjects) write(subject.own, subject.itemId)
    for (const [parentId, facts] of parents) write(facts, parentId)
  }
}

/** Makes sure every attribute `rules` name has its values on the subjects,
 *  reading only the ones not read already. The preview calls this for a draft
 *  that names an attribute no saved rule does. Recorded only once written, so
 *  a request arriving mid-read reads it again rather than using half of it. */
export async function ensureAttributeFacts(
  run: { subjects: readonly RuleSubject[]; attributesRead: Set<string>; rangeAttributeId: string | null },
  rules: ReadonlyArray<{ conditions: RuleGroup }>,
): Promise<void> {
  const missing = attributeIdsIn(rules).filter((id) => !run.attributesRead.has(id))
  if (missing.length === 0) return
  await fillAttributeFacts(run.subjects, missing, run.rangeAttributeId)
  for (const id of missing) run.attributesRead.add(id)
}
