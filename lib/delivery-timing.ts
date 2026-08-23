// How long each product takes to arrive, read from whichever module publishes
// delivery timing - Advanced Shipping today, anything else tomorrow.
//
// An OPTIONAL companion, not a dependency: a shop with no delivery-timing
// module simply gets no shipping-time attributes on its items, and Google falls
// back to the handling and transit times set in the Merchant Center account.
// So the provider is looked up through core's generated extension-point
// registry rather than imported: the registry is built from the manifests of
// the modules actually installed, so on a shop without one the point is empty
// and nothing here has a path to a module that is not there. Importing
// '@/modules/advanced-shipping-for-shop/...' directly would break the build on
// every install that has not got it.
import { moduleExtensionPointComponents } from '@/lib/modules/extension-points'

const POINT = 'shop.product-delivery-timing'

/** One delivery service the product can be bought with. */
export type FeedDeliveryOption = {
  /** The service's own name, as the shop calls it - "Express Flat-Pack". */
  label: string
  /** NET price in major units, on the same side of tax as the product's stored
   *  price. The caller grosses it up exactly as it grosses that price. */
  price: number
  handlingDays: number
  transitDays: number
}

export type FeedDeliveryTiming = {
  /** Working days from order to dispatch. */
  handlingDays: number
  /** Working days from dispatch to doorstep. */
  transitDays: number
  /** ISO instant the item can first be dispatched, on a pre-ordered or
   *  backordered product only. Null on anything already in stock. */
  availabilityDate: string | null
  /** Every service the product is offered, priced and timed. Empty where the
   *  provider is too old to publish the menu, which simply costs the feed its
   *  shipping groups and leaves the account rates in charge. */
  options: FeedDeliveryOption[]
}

type TimingProvider = (productIds: string[]) => Promise<Map<string, unknown>>

// One service off the provider's menu, checked the same way as the rest. An
// option missing a usable price or count is dropped on its own: the others are
// still true, and a shop offering three services should not lose all three
// because one of them came across the seam malformed.
function readOption(value: unknown): FeedDeliveryOption | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  const label = typeof row.label === 'string' ? row.label.trim() : ''
  if (!label) return null
  const price = row.price
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) return null
  const handlingDays = row.handlingDays
  const transitDays = row.transitDays
  if (!Number.isInteger(handlingDays) || !Number.isInteger(transitDays)) return null
  if ((handlingDays as number) < 0 || (transitDays as number) < 0) return null
  return { label, price, handlingDays: handlingDays as number, transitDays: transitDays as number }
}

// The provider's answer, checked rather than trusted. It comes from another
// module across a registry seam with no shared types, so a shape that has
// drifted must cost the feed one attribute, not the whole run.
function readTiming(value: unknown): FeedDeliveryTiming | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  const handlingDays = row.handlingDays
  const transitDays = row.transitDays
  if (!Number.isInteger(handlingDays) || !Number.isInteger(transitDays)) return null
  if ((handlingDays as number) < 0 || (transitDays as number) < 0) return null
  const availabilityDate = typeof row.availabilityDate === 'string' ? row.availabilityDate : null
  // Two services under one name would render as two shipping groups Google
  // cannot tell apart, so the first of a name wins and the rest are dropped.
  const seen = new Set<string>()
  const options: FeedDeliveryOption[] = []
  for (const entry of Array.isArray(row.options) ? row.options : []) {
    const option = readOption(entry)
    if (!option || seen.has(option.label)) continue
    seen.add(option.label)
    options.push(option)
  }
  return { handlingDays: handlingDays as number, transitDays: transitDays as number, availabilityDate, options }
}

// The registered provider, or null where no module publishes delivery timing.
function timingProvider(): TimingProvider | null {
  const registered: Record<string, unknown> = moduleExtensionPointComponents[POINT] ?? {}
  return Object.values(registered).find((entry): entry is TimingProvider => typeof entry === 'function') ?? null
}

/** Whether any installed module publishes delivery timing at all. The settings
 *  tab asks so it can say plainly that the delivery-options switch has nothing
 *  to read, rather than leaving the owner to wonder at an unchanged feed. */
export function hasDeliveryTimingProvider(): boolean {
  return timingProvider() !== null
}

/** Timing for the given products, keyed by product id. Empty when no module
 *  publishes it; products the shop cannot deliver are absent from the map, and
 *  a caller must leave their attributes off rather than print a zero. */
export async function getDeliveryTiming(productIds: string[]): Promise<Map<string, FeedDeliveryTiming>> {
  const result = new Map<string, FeedDeliveryTiming>()
  if (productIds.length === 0) return result

  const provider = timingProvider()
  if (!provider) return result

  const answered = await provider(productIds)
  if (!(answered instanceof Map)) return result
  for (const [productId, value] of answered) {
    if (typeof productId !== 'string') continue
    const timing = readTiming(value)
    if (timing) result.set(productId, timing)
  }
  return result
}
