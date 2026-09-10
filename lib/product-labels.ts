// The owner's own product attributes, read from whichever module publishes them
// - Product Attributes today, anything else tomorrow.
//
// An OPTIONAL companion, not a dependency, for the same reasons as
// delivery-timing beside it: the provider is looked up through core's generated
// extension-point registry, which is built from the manifests of the modules
// actually installed. On a shop without one the point is empty and nothing here
// has a path to a module that is not there. Importing the other module directly
// would break the build on every install that has not got it.
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
