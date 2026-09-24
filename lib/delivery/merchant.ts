// Reading and writing the Merchant Center account's shipping settings.
//
// The only two calls in this module that touch Google's delivery settings at
// all. Everything above this file works on plain objects.
//
// Both endpoints were checked against the accounts_v1 discovery document
// (revision 20260921) rather than remembered:
//   GET  accounts/v1/accounts/{account}/shippingSettings
//   POST accounts/v1/accounts/{account}/shippingSettings:insert   parent = accounts/{account}
//
// The insert REPLACES the resource. There is no patch, no per-service call and
// no way to add one service without sending them all, which is why every write
// starts with a read and why the etag matters: it is Google's guarantee that
// nothing changed in between. Getting this wrong does not throw - it quietly
// deletes whatever somebody else added in Merchant Center this morning.
import { z } from 'zod'
import { merchantRequest, type RequestOptions } from '@/modules/google-shopping-for-shop/lib/google/client'
import { GoogleApiError } from '@/modules/google-shopping-for-shop/lib/google/errors'
import type { MerchantShippingSettings } from '@/modules/google-shopping-for-shop/lib/delivery/merchant-types'

// Lenient on purpose, and `passthrough` everywhere on purpose too.
//
// This is a validator, not a filter. Anything Google holds that this module
// does not model - a minimum order value, a carrier rate, a store config, a
// field added next quarter - has to survive the round trip untouched, because
// the write sends back everything the read returned. A schema that stripped
// unknown keys would delete a setting the owner made by hand, and it would do
// it silently.
const CutoffTime = z.object({
  hour: z.number().optional(),
  minute: z.number().optional(),
  timeZone: z.string().optional(),
}).passthrough()

const BusinessDayConfig = z.object({
  businessDays: z.array(z.string()).optional(),
}).passthrough()

const DeliveryTime = z.object({
  minTransitDays: z.number().optional(),
  maxTransitDays: z.number().optional(),
  minHandlingDays: z.number().optional(),
  maxHandlingDays: z.number().optional(),
  cutoffTime: CutoffTime.optional(),
  handlingBusinessDayConfig: BusinessDayConfig.optional(),
  transitBusinessDayConfig: BusinessDayConfig.optional(),
}).passthrough()

const Price = z.object({
  // Google documents amountMicros as a string; older responses have been seen
  // to send a number, and either is readable.
  amountMicros: z.union([z.string(), z.number()]).optional(),
  currencyCode: z.string().optional(),
}).passthrough()

const RateGroup = z.object({
  name: z.string().optional(),
  applicableShippingLabels: z.array(z.string()).optional(),
  singleValue: z.object({
    flatRate: Price.optional(),
    noShipping: z.boolean().optional(),
    pricePercentage: z.string().optional(),
  }).passthrough().optional(),
}).passthrough()

const Service = z.object({
  serviceName: z.string().optional(),
  active: z.boolean().optional(),
  deliveryCountries: z.array(z.string()).optional(),
  currencyCode: z.string().optional(),
  deliveryTime: DeliveryTime.optional(),
  rateGroups: z.array(RateGroup).optional(),
}).passthrough()

const ShippingSettings = z.object({
  name: z.string().optional(),
  etag: z.string().optional(),
  services: z.array(Service).optional(),
  warehouses: z.array(z.unknown()).optional(),
}).passthrough()

export type ShippingSettingsRead = {
  settings: MerchantShippingSettings
  /** Sent straight back on the insert. Empty string where the account has no
   *  shipping settings yet, which is what Google asks for on a first write. */
  etag: string
  /** False where Google has no shipping settings for this account at all. */
  exists: boolean
}

function path(merchantId: string): string {
  return `accounts/v1/accounts/${encodeURIComponent(merchantId)}/shippingSettings`
}

/**
 * What Merchant Center currently holds.
 *
 * An account with nothing set up answers 404, which is a normal state and not
 * a failure: it comes back as empty settings with an empty etag, exactly what
 * a first insert wants.
 */
export async function readShippingSettings(
  merchantId: string,
  options: Omit<RequestOptions, 'body' | 'method'> = {},
): Promise<ShippingSettingsRead> {
  try {
    const body = await merchantRequest<unknown>(path(merchantId), { ...options, method: 'GET' })
    const parsed = ShippingSettings.safeParse(body)
    if (!parsed.success) {
      throw new Error('Google sent back delivery settings in a shape this site does not recognise, so nothing has been changed.')
    }
    const settings = parsed.data as MerchantShippingSettings
    return { settings, etag: settings.etag ?? '', exists: true }
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 404) {
      return { settings: { services: [] }, etag: '', exists: false }
    }
    throw error
  }
}

/**
 * Replaces the account's shipping settings.
 *
 * `settings.etag` must be the one from the read this payload was built on.
 * Google refuses the write if anything changed in between, and that refusal is
 * the whole point - see isEtagConflict below.
 *
 * Returns what GOOGLE now holds, or null where the write went through but its
 * reply could not be understood. Null rather than the payload we sent, which is
 * what this used to do: substituting our own prediction made the caller's
 * "could not read the reply" branch unreachable, and quietly recorded a guess
 * as the snapshot Undo later compares against.
 */
export async function writeShippingSettings(
  merchantId: string,
  settings: MerchantShippingSettings,
  options: Omit<RequestOptions, 'body' | 'method'> = {},
): Promise<MerchantShippingSettings | null> {
  const body = await merchantRequest<unknown>(
    `accounts/v1/accounts/${encodeURIComponent(merchantId)}/shippingSettings:insert`,
    { ...options, method: 'POST', body: settings },
  )
  const parsed = ShippingSettings.safeParse(body)
  // The write went through either way - this is only about reading the answer
  // back - so an unrecognisable reply is not a failure. It is an admission, and
  // the caller decides what to do about it.
  return parsed.success ? (parsed.data as MerchantShippingSettings) : null
}

/** Google refusing the write because the settings moved under us.
 *
 *  There is no documented status code for it, so this reads Google's own
 *  wording as well as the statuses it could plausibly come back as. Treated
 *  conservatively: a false positive tells the owner to look again, which is
 *  never the wrong advice, while a false negative would have us insist a push
 *  worked when it did not. */
export function isEtagConflict(error: unknown): boolean {
  if (!(error instanceof GoogleApiError)) return false
  if (error.status !== 400 && error.status !== 409 && error.status !== 412) return false
  const text = `${error.message} ${error.reason ?? ''}`.toLowerCase()
  return text.includes('etag') || text.includes('aborted') || text.includes('conflict')
}
