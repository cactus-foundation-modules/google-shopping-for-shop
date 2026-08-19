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

export type FeedDeliveryTiming = {
  /** Working days from order to dispatch. */
  handlingDays: number
  /** Working days from dispatch to doorstep. */
  transitDays: number
  /** ISO instant the item can first be dispatched, on a pre-ordered or
   *  backordered product only. Null on anything already in stock. */
  availabilityDate: string | null
}

type TimingProvider = (productIds: string[]) => Promise<Map<string, unknown>>

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
  return { handlingDays: handlingDays as number, transitDays: transitDays as number, availabilityDate }
}

/** Timing for the given products, keyed by product id. Empty when no module
 *  publishes it; products the shop cannot deliver are absent from the map, and
 *  a caller must leave their attributes off rather than print a zero. */
export async function getDeliveryTiming(productIds: string[]): Promise<Map<string, FeedDeliveryTiming>> {
  const result = new Map<string, FeedDeliveryTiming>()
  if (productIds.length === 0) return result

  const registered: Record<string, unknown> = moduleExtensionPointComponents[POINT] ?? {}
  const provider = Object.values(registered).find((entry): entry is TimingProvider => typeof entry === 'function')
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
