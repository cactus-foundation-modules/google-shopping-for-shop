// The shop's delivery services, read from whichever module publishes them.
//
// An OPTIONAL companion, not a dependency, for exactly the reasons set out in
// lib/delivery-timing.ts next door: the provider is looked up through core's
// generated extension-point registry, which is built from the manifests of the
// modules actually installed. On a shop without one the point is empty and
// nothing here has a path to a module that is not there. Importing
// '@/modules/advanced-shipping-for-shop/...' directly would break the build on
// every install that has not got it.
//
// The SERVER registry rather than the public one: everything this reaches is a
// database read of the whole shop's delivery pricing, which belongs nowhere
// near a browser bundle. Only server code may import this file.
//
// Checked rather than trusted, again like delivery-timing. It arrives across a
// registry seam with no shared types, so a shape that has drifted must cost the
// Delivery tab its contents and say so, not throw halfway through a push.
//
// RELEASE ORDER, and it is not expressible in a manifest. This reader
// understands both shapes `scopesForProducts` has ever answered with, so a NEW
// google-shopping against an OLD advanced-shipping is fine. The other way round
// is NOT: an OLD google-shopping handed the newer object where it expects a
// bare string drops every label silently, and every item in the feed falls to
// Merchant Center's catch-all rate. `requiresModules` cannot catch it - it
// guards imports, and this is a change in the SHAPE of an answer - so the rule
// has to be carried by hand:
//
//   release google-shopping no later than advanced-shipping.
//
// Same for any future change to what a provider answers with: widen the reader
// FIRST, ship it, and only then change what the other module sends.
import { moduleServerExtensionPointComponents as moduleExtensionPointComponents } from '@/lib/modules/extension-points.server'

const POINT = 'shop.delivery-services-catalogue'

/** The kinds of group a delivery price can be written against. Mirrors the
 *  publishing module's own vocabulary; nothing here is Google's. */
export const DELIVERY_SCOPE_KINDS = ['RANGE', 'CATEGORY', 'SUPPLIER', 'DEFAULT'] as const
export type DeliveryScopeKind = (typeof DELIVERY_SCOPE_KINDS)[number]

export type DeliveryScope = {
  id: string
  kind: DeliveryScopeKind
  ref: string | null
  label: string
}

export type DeliveryScopeRate = {
  scopeId: string
  available: boolean
  /** NET, in major units, per unit. */
  price: number
  transitDays: number
  minLeadDays: number | null
}

export type DeliveryServiceEntry = {
  key: string
  label: string
  description: string | null
  position: number
  transitDays: number
  minLeadDays: number | null
  rates: DeliveryScopeRate[]
  isDefault: boolean
}

export type DeliveryDispatchRules = {
  /** "HH:MM" wall-clock in `timezone`. */
  cutoffTime: string
  timezone: string
  /** 0 = Sunday. */
  shipDays: number[]
  dispatchLeadDays: number
}

export type DeliveryCatalogue = {
  scopeOrder: DeliveryScopeKind[]
  pricing: 'per-unit' | 'per-order'
  scopes: DeliveryScope[]
  services: DeliveryServiceEntry[]
  dispatch: DeliveryDispatchRules
  holidays: Array<{ date: string; name: string }>
}

type CatalogueProvider = {
  catalogue: () => Promise<unknown>
  scopesForProducts: (productIds: string[]) => Promise<unknown>
}

function isProvider(value: unknown): value is CatalogueProvider {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.catalogue === 'function' && typeof row.scopesForProducts === 'function'
}

function provider(): CatalogueProvider | null {
  const registered: Record<string, unknown> = moduleExtensionPointComponents[POINT] ?? {}
  return Object.values(registered).find(isProvider) ?? null
}

/** Whether any installed module publishes delivery services at all. The tab
 *  asks so it can say plainly that there is nothing to compare, rather than
 *  drawing an empty table that looks like a shop with no delivery charges. */
export function hasDeliveryCatalogue(): boolean {
  return provider() !== null
}

function isKind(value: unknown): value is DeliveryScopeKind {
  return typeof value === 'string' && (DELIVERY_SCOPE_KINDS as readonly string[]).includes(value)
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readDayCount(value: unknown): number | null {
  const number = readNumber(value)
  if (number === null || !Number.isInteger(number) || number < 0) return null
  return number
}

function readScope(value: unknown): DeliveryScope | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id.trim() : ''
  const label = typeof row.label === 'string' ? row.label.trim() : ''
  if (!id || !label || !isKind(row.kind)) return null
  return { id, kind: row.kind, ref: typeof row.ref === 'string' ? row.ref : null, label }
}

function readRate(value: unknown): DeliveryScopeRate | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  const scopeId = typeof row.scopeId === 'string' ? row.scopeId.trim() : ''
  const price = readNumber(row.price)
  const transitDays = readDayCount(row.transitDays)
  if (!scopeId || price === null || price < 0 || transitDays === null) return null
  const minLead = row.minLeadDays == null ? null : readDayCount(row.minLeadDays)
  return {
    scopeId,
    available: row.available !== false,
    price,
    transitDays,
    minLeadDays: minLead,
  }
}

function readService(value: unknown): DeliveryServiceEntry | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  const key = typeof row.key === 'string' ? row.key.trim() : ''
  const label = typeof row.label === 'string' ? row.label.trim() : ''
  const transitDays = readDayCount(row.transitDays)
  if (!key || !label || transitDays === null) return null
  const rates: DeliveryScopeRate[] = []
  for (const entry of Array.isArray(row.rates) ? row.rates : []) {
    const rate = readRate(entry)
    // One malformed rate is dropped on its own: the other scopes are still
    // true, and losing a whole service because one price came across the seam
    // badly would take a working delivery charge off Google.
    if (rate) rates.push(rate)
  }
  return {
    key,
    label,
    description: typeof row.description === 'string' ? row.description : null,
    position: readNumber(row.position) ?? 0,
    transitDays,
    minLeadDays: row.minLeadDays == null ? null : readDayCount(row.minLeadDays),
    rates,
    isDefault: row.isDefault === true,
  }
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

function readDispatch(value: unknown): DeliveryDispatchRules | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  const cutoffTime = typeof row.cutoffTime === 'string' && TIME_RE.test(row.cutoffTime) ? row.cutoffTime : null
  const timezone = typeof row.timezone === 'string' && row.timezone.trim() !== '' ? row.timezone.trim() : null
  const dispatchLeadDays = readDayCount(row.dispatchLeadDays)
  if (!cutoffTime || !timezone || dispatchLeadDays === null) return null
  const shipDays = (Array.isArray(row.shipDays) ? row.shipDays : [])
    .filter((day): day is number => Number.isInteger(day) && (day as number) >= 0 && (day as number) <= 6)
  // A shop that dispatches on no day at all cannot be described, and sending
  // Google an empty business-day list is a request it refuses outright.
  if (shipDays.length === 0) return null
  return { cutoffTime, timezone, shipDays: [...new Set(shipDays)].sort((a, b) => a - b), dispatchLeadDays }
}

/** The whole catalogue, or null where nothing publishes one - or where what
 *  came back could not be understood, which the caller must treat the same
 *  way: something to say out loud, never something to paper over. */
export async function getDeliveryCatalogue(): Promise<DeliveryCatalogue | null> {
  const source = provider()
  if (!source) return null

  const answered = await source.catalogue()
  if (typeof answered !== 'object' || answered === null) return null
  const row = answered as Record<string, unknown>

  const dispatch = readDispatch(row.dispatch)
  if (!dispatch) return null

  const scopes: DeliveryScope[] = []
  for (const entry of Array.isArray(row.scopes) ? row.scopes : []) {
    const scope = readScope(entry)
    if (scope) scopes.push(scope)
  }
  const known = new Set(scopes.map((scope) => scope.id))

  const services: DeliveryServiceEntry[] = []
  for (const entry of Array.isArray(row.services) ? row.services : []) {
    const service = readService(entry)
    if (!service) continue
    // A price written against a group that is not in the list is a price
    // nothing can be grouped by, so it is dropped here rather than turned into
    // a rate group with no products in it.
    service.rates = service.rates.filter((rate) => known.has(rate.scopeId))
    services.push(service)
  }

  const scopeOrder = (Array.isArray(row.scopeOrder) ? row.scopeOrder : []).filter(isKind)

  const holidays: Array<{ date: string; name: string }> = []
  for (const entry of Array.isArray(row.holidays) ? row.holidays : []) {
    if (typeof entry !== 'object' || entry === null) continue
    const holiday = entry as Record<string, unknown>
    if (typeof holiday.date !== 'string' || typeof holiday.name !== 'string') continue
    holidays.push({ date: holiday.date, name: holiday.name })
  }

  return {
    scopeOrder: scopeOrder.length > 0 ? scopeOrder : [...DELIVERY_SCOPE_KINDS],
    // Unknown means per-order, because per-order is the assumption that makes a
    // consumer understate nothing: a per-unit price read as per-order would be
    // quoted to Google as the whole delivery charge when it is only the first
    // unit's share.
    pricing: row.pricing === 'per-unit' ? 'per-unit' : 'per-order',
    scopes,
    services: services.sort((a, b) => a.position - b.position || a.label.localeCompare(b.label, 'en-GB')),
    dispatch,
    holidays,
  }
}

/** How many ids go to the provider in one call. It reads them with one bind
 *  parameter each, and Postgres stops at 65,535 of those in a statement. */
const SCOPE_CHUNK = 10_000

/** Which group a product falls in, and what else it equally matched. */
export type ProductScopeAnswer = {
  scopeId: string
  /** Other groups of the same specificity the product ALSO matched. Empty on
   *  nearly every product, and on any provider too old to publish it. */
  tiedWith: string[]
}

// The answer for one product, from a provider that may be older than this
// build. A bare string is what the first version of this seam published, and it
// still means exactly what it meant then: this group, no ties known.
function readScopeAnswer(value: unknown): ProductScopeAnswer | null {
  if (typeof value === 'string') return value ? { scopeId: value, tiedWith: [] } : null
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (typeof row.scopeId !== 'string' || !row.scopeId) return null
  const tiedWith = Array.isArray(row.tiedWith)
    ? row.tiedWith.filter((id): id is string => typeof id === 'string' && id !== '')
    : []
  return { scopeId: row.scopeId, tiedWith }
}

/** Which delivery group each product falls in, keyed by product id. Products
 *  in no group at all are absent, and a caller must leave their label off
 *  rather than invent one. */
export async function getProductDeliveryScopes(productIds: string[]): Promise<Map<string, ProductScopeAnswer>> {
  const result = new Map<string, ProductScopeAnswer>()
  const ids = [...new Set(productIds)].filter(Boolean)
  if (ids.length === 0) return result

  const source = provider()
  if (!source) return result

  for (let start = 0; start < ids.length; start += SCOPE_CHUNK) {
    const answered = await source.scopesForProducts(ids.slice(start, start + SCOPE_CHUNK))
    if (!(answered instanceof Map)) continue
    for (const [productId, value] of answered) {
      if (typeof productId !== 'string') continue
      const answer = readScopeAnswer(value)
      if (answer) result.set(productId, answer)
    }
  }
  return result
}
