// The owner's own product attributes, read from whichever module publishes them
// - Product Attributes today, anything else tomorrow.
//
// An OPTIONAL companion, not a dependency, for the same reasons as
// delivery-timing beside it: the provider is looked up through core's generated
// extension-point registry, which is built from the manifests of the modules
// actually installed. On a shop without one the point is empty and nothing here
// has a path to a module that is not there. Importing the other module directly
// would break the build on every install that has not got it.
import { isPlainSpecName, specAxisOf, type FeedOptionPair } from '@/modules/google-shopping-for-shop/lib/feed-xml'
import { modulePublicExtensionPointComponents as moduleExtensionPointComponents } from '@/lib/modules/extension-points.public'

const POINT = 'shop.product-attribute-values'

export type LabelAttribute = { id: string; name: string }

type ValuesProvider = {
  listAttributes: () => Promise<unknown>
  valuesFor: (attributeId: string, productIds: string[]) => Promise<unknown>
}

function isProvider(value: unknown): value is ValuesProvider {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.listAttributes === 'function' && typeof row.valuesFor === 'function'
}

function provider(): ValuesProvider | null {
  const registered: Record<string, unknown> = moduleExtensionPointComponents[POINT] ?? {}
  return Object.values(registered).find(isProvider) ?? null
}

/** Whether any installed module publishes product attributes at all. The
 *  settings tab asks so it can say plainly that the shipping-label setting has
 *  nothing to read, rather than offering an empty dropdown. */
export function hasAttributeProvider(): boolean {
  return provider() !== null
}

/** Every attribute the owner could group by, or an empty list where nothing
 *  publishes any. Checked rather than trusted: it comes across a registry seam
 *  with no shared types, so a shape that has drifted costs the tab its dropdown
 *  and not the page. */
export async function listLabelAttributes(): Promise<LabelAttribute[]> {
  const source = provider()
  if (!source) return []
  const answered = await source.listAttributes()
  if (!Array.isArray(answered)) return []
  const attributes: LabelAttribute[] = []
  for (const entry of answered) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id : ''
    const name = typeof row.name === 'string' ? row.name.trim() : ''
    if (!id || !name) continue
    attributes.push({ id, name })
  }
  return attributes
}

/** One label per product for the chosen attribute, keyed by product id.
 *
 *  ONE, not all of them: `shipping_label` is a single grouping key, so a product
 *  ticked against two values of the same attribute contributes the first in the
 *  attribute's own order. That is arbitrary but stable, which is what matters -
 *  a label that moved between feed runs would move the item between rate groups
 *  in Merchant Center every time Google fetched it. */
export async function getProductLabels(
  attributeId: string,
  productIds: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (!attributeId || productIds.length === 0) return result

  const source = provider()
  if (!source) return result

  const answered = await source.valuesFor(attributeId, productIds)
  if (!(answered instanceof Map)) return result
  for (const [productId, value] of answered) {
    if (typeof productId !== 'string') continue
    const first = Array.isArray(value) ? value.find((v) => typeof v === 'string' && v.trim() !== '') : null
    if (typeof first === 'string') result.set(productId, first.trim())
  }
  return result
}

/** How many ids go to the provider in one call. It reads them with one bind
 *  parameter each, and Postgres stops at 65,535 of those in a statement. */
const VALUES_CHUNK = 10_000

/** Every value of one attribute ticked against each of these products, keyed
 *  by product id, in the attribute's own value order. Absent where nothing is
 *  ticked. Feed rules read this: a rule asks "is any of its values X", so all
 *  of them matter, not just the first. */
export async function getProductAttributeValues(
  attributeId: string,
  productIds: string[]
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  const ids = [...new Set(productIds)].filter(Boolean)
  if (!attributeId || ids.length === 0) return result
  const source = provider()
  if (!source) return result
  for (let start = 0; start < ids.length; start += VALUES_CHUNK) {
    const answered = await source.valuesFor(attributeId, ids.slice(start, start + VALUES_CHUNK))
    if (!(answered instanceof Map)) continue
    for (const [productId, value] of answered) {
      if (typeof productId !== 'string' || !Array.isArray(value)) continue
      const labels = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim())
      if (labels.length > 0) result.set(productId, labels)
    }
  }
  return result
}

/** The colour and size specs written against each of these products, as name /
 *  value pairs keyed by product id - what the feed falls back on when a
 *  variation's options say nothing about colour or size.
 *
 *  Attributes are picked by NAME, with the same patterns the feed sorts option
 *  names by, so no attribute id has to be configured. One list call plus one
 *  values call per matching attribute (a shop has a handful) covers the whole
 *  run; nothing is asked per item. Empty where nothing publishes attributes.
 *  A product ticked against several values of one attribute contributes the
 *  first, in the attribute's own order, so the feed does not shuffle run to run. */
export async function getSpecAxisPairs(productIds: string[]): Promise<Map<string, FeedOptionPair[]>> {
  const result = new Map<string, FeedOptionPair[]>()
  const ids = [...new Set(productIds)].filter(Boolean)
  if (ids.length === 0 || !provider()) return result
  const wanted = (await listLabelAttributes()).filter((attribute) => specAxisOf(attribute.name) !== null)
  const plain = new Map<string, FeedOptionPair[]>()
  const partial = new Map<string, FeedOptionPair[]>()
  for (const attribute of wanted) {
    const target = isPlainSpecName(attribute.name) ? plain : partial
    const values = await getProductAttributeValues(attribute.id, ids)
    for (const [productId, labels] of values) {
      const first = labels[0]
      if (!first) continue
      const list = target.get(productId) ?? []
      list.push({ name: attribute.name, value: first })
      target.set(productId, list)
    }
  }
  // Per axis: the plain attribute where the product has one, else the part-specs.
  const hasAxis = (pairs: FeedOptionPair[], axis: 'color' | 'size') => pairs.some((pair) => specAxisOf(pair.name) === axis)
  for (const productId of new Set([...plain.keys(), ...partial.keys()])) {
    const own = plain.get(productId) ?? []
    const rest = partial.get(productId) ?? []
    result.set(productId, [
      ...own,
      ...rest.filter((pair) => !hasAxis(own, specAxisOf(pair.name) === 'color' ? 'color' : 'size')),
    ])
  }
  return result
}
