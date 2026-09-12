// Google's own product taxonomy, held against the shop's categories.
//
// The feed already sends `product_type`, which is the shop's own category trail
// in the shop's own words. Useful for reporting and useless for anything else:
// Google has a published taxonomy of its own, and `google_product_category` is
// what decides which shopping surfaces an item is eligible for and how its
// attributes are read.
//
// Kept per category and not per product on purpose. A shop with twelve thousand
// products has perhaps forty categories, so this is a morning's typing rather
// than a fortnight's, and a category added later inherits from its parent
// instead of arriving blank. A product that says otherwise on its own Google
// Shopping tab still wins.
import { prisma } from '@/lib/db/prisma'
import type { GsfCategoryTaxonomyRow } from '@/modules/google-shopping-for-shop/lib/types'

/** Google takes either the numeric id or the full "A > B > C" path. Neither is
 *  checked against the published list: Google revises it, and a shop refused a
 *  save because this module's idea of the taxonomy was a year old would be the
 *  worse failure. Merchant Center says so plainly if the value is wrong. */
export const GOOGLE_CATEGORY_MAX = 255

type CategoryNode = { id: string; name: string; parentId: string | null }

/**
 * What each category sends, resolved through its ancestors.
 *
 * Returns a lookup rather than a map, because the answer for a category with
 * nothing of its own is its nearest mapped parent's, and walking that per
 * product is the same walk twenty thousand times. The depth guard matches
 * buildCategoryPaths in feed-data.ts: a cycle in parent ids must not hang the
 * feed, whatever put it there.
 */
export function googleCategoryResolver(
  categories: CategoryNode[],
  mapping: Map<string, string>,
): (categoryId: string | null | undefined) => string | undefined {
  const byId = new Map(categories.map((c) => [c.id, c]))
  const resolved = new Map<string, string | undefined>()
  return (categoryId) => {
    if (!categoryId) return undefined
    if (resolved.has(categoryId)) return resolved.get(categoryId)
    // Every category walked past shares the answer, so a deep tree is walked
    // once rather than once per level.
    const chain: string[] = []
    let current: CategoryNode | undefined = byId.get(categoryId)
    let answer: string | undefined
    for (let hops = 0; current && hops < 20; hops++) {
      chain.push(current.id)
      const own = mapping.get(current.id)
      if (own) { answer = own; break }
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
    for (const id of chain) resolved.set(id, answer)
    return answer
  }
}

/** Category id -> the value typed against it. Absent means nothing was. */
export async function getCategoryTaxonomy(): Promise<Map<string, string>> {
  const rows = await prisma.$queryRaw<Array<{ category_id: string; google_product_category: string }>>`
    SELECT "category_id", "google_product_category" FROM "gsf_category_taxonomy"
  `
  return new Map(rows.map((r) => [r.category_id, r.google_product_category]))
}

/** Writes one category's value, or clears it. Nothing to say is no row rather
 *  than an empty string, so "is this set" has one answer and not two. */
export async function setCategoryTaxonomy(categoryId: string, value: string | null): Promise<void> {
  const trimmed = value?.trim().slice(0, GOOGLE_CATEGORY_MAX) || null
  if (!trimmed) {
    await prisma.$executeRaw`DELETE FROM "gsf_category_taxonomy" WHERE "category_id" = ${categoryId}`
    return
  }
  await prisma.$executeRaw`
    INSERT INTO "gsf_category_taxonomy" ("category_id", "google_product_category", "updated_at")
    VALUES (${categoryId}, ${trimmed}, CURRENT_TIMESTAMP)
    ON CONFLICT ("category_id") DO UPDATE
      SET "google_product_category" = EXCLUDED."google_product_category",
          "updated_at" = CURRENT_TIMESTAMP
  `
}

/**
 * The mapping screen's rows: every category the shop has, in tree order, each
 * carrying its own value and what it would inherit without one.
 *
 * The trail is built here rather than borrowed from feed-data.ts because that
 * file reaches half the shop to do its job and this screen needs none of it.
 */
export function taxonomyRows(categories: CategoryNode[], mapping: Map<string, string>): GsfCategoryTaxonomyRow[] {
  const byId = new Map(categories.map((c) => [c.id, c]))
  const pathOf = (category: CategoryNode): string => {
    const names: string[] = []
    let current: CategoryNode | undefined = category
    for (let hops = 0; current && hops < 20; hops++) {
      names.unshift(current.name)
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
    return names.join(' > ')
  }
  // Inheritance is asked of the PARENT, not of the category itself: a category
  // with a value of its own would otherwise report itself as its own fallback.
  const resolve = googleCategoryResolver(categories, mapping)
  return categories
    .map((category) => ({
      categoryId: category.id,
      path: pathOf(category),
      googleProductCategory: mapping.get(category.id) ?? '',
      inherited: (mapping.get(category.id) ? undefined : resolve(category.parentId)) ?? '',
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}
