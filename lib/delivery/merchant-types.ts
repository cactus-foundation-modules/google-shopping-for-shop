// Merchant API shipping settings, as Google's own reference spells them.
//
// Verified against the accounts_v1 discovery document (revision 20260921) and
// the published reference, not from memory:
//   GET  accounts/v1/accounts/{account}/shippingSettings
//   POST accounts/v1/accounts/{account}/shippingSettings:insert
// The insert REPLACES the whole resource, which is why every push here is a
// read-merge-write rather than a patch: anything left out of the body is gone.
//
// Field names are Google's, camelCase as the REST surface uses them, and are
// not ours to tidy. Money is `amountMicros`, a STRING of millionths - 10.00 GBP
// is "10000000" - which is the single easiest thing in this file to get wrong.
//
// Limits are Merchant Center's, not the API's, and the Merchant API reference
// does not restate them; they are taken from the Content API resource-limits
// page, which is the only place Google publishes numbers:
//   20 shipping services per country
//   20 rate groups per service
//   30 labels per rate group
//   100 characters per shipping label
//   50 characters per shipping service name
// Nothing here may exceed them, and anything that would has to be said out
// loud rather than trimmed quietly.
//
// The last two are different numbers for different things and have been
// confused once already: a LABEL gets 100 characters and a SERVICE NAME gets
// 50. The longest label on the live shop is 99 characters and is perfectly
// legal; nothing may "fix" it by cutting it to 50.

/** Shipping services allowed per country in one account. */
export const MAX_SERVICES_PER_COUNTRY = 20
/** Rate groups allowed in one shipping service. */
export const MAX_RATE_GROUPS_PER_SERVICE = 20
/** Shipping labels allowed in one rate group. */
export const MAX_LABELS_PER_RATE_GROUP = 30
/** Characters allowed in one shipping SERVICE name. Not the label limit: see
 *  the note above. Google refuses the whole payload over this, so a name that
 *  does not fit costs every other service in the push as well. */
export const MAX_SERVICE_NAME_LENGTH = 50

/** Google's Weekday enum, indexed by JavaScript's own 0 = Sunday. */
export const WEEKDAY_NAMES = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
] as const

export type MerchantPrice = {
  /** Millionths of one unit of currency, as a string. */
  amountMicros: string
  currencyCode: string
}

export type MerchantValue = {
  flatRate?: MerchantPrice
  noShipping?: boolean
  pricePercentage?: string
  carrierRate?: string
  subtable?: string
}

export type MerchantRateGroup = {
  name?: string
  /** A disjunction: one matching label is enough. May be empty ONLY on the
   *  last rate group of a service, where it means "everything else". */
  applicableShippingLabels: string[]
  singleValue?: MerchantValue
  /** Present on rate groups we did not write. Carried, never built. */
  mainTable?: unknown
  subtables?: unknown[]
  carrierRates?: unknown[]
}

export type MerchantBusinessDayConfig = { businessDays: string[] }

export type MerchantCutoffTime = {
  hour: number
  minute: number
  /** IANA identifier, e.g. "Europe/London". */
  timeZone: string
}

export type MerchantDeliveryTime = {
  minTransitDays?: number
  maxTransitDays?: number
  minHandlingDays?: number
  maxHandlingDays?: number
  cutoffTime?: MerchantCutoffTime
  handlingBusinessDayConfig?: MerchantBusinessDayConfig
  transitBusinessDayConfig?: MerchantBusinessDayConfig
  transitTimeTable?: unknown
  warehouseBasedDeliveryTimes?: unknown[]
}

/** One shipping service. Unknown fields are kept as-is on anything we did not
 *  write, so a push cannot quietly drop a setting somebody made by hand. */
export type MerchantService = {
  serviceName?: string
  active?: boolean
  deliveryCountries?: string[]
  currencyCode?: string
  deliveryTime?: MerchantDeliveryTime
  rateGroups?: MerchantRateGroup[]
  shipmentType?: string
  minimumOrderValue?: MerchantPrice
  [key: string]: unknown
}

export type MerchantShippingSettings = {
  name?: string
  /** Required on every insert. Empty string on the very first one. */
  etag?: string
  services?: MerchantService[]
  warehouses?: unknown[]
  [key: string]: unknown
}

/** Major units to Google's micros. Rounded to the penny first, because a
 *  figure like 12.345 would otherwise become a price no shop ever charged. */
export function toAmountMicros(amount: number): string {
  const pennies = Math.round(amount * 100)
  return String(pennies * 10_000)
}

/** Google's micros back to major units, for reading what is already there. */
export function fromAmountMicros(micros: string | number | null | undefined): number | null {
  if (micros === null || micros === undefined) return null
  const value = Number(micros)
  if (!Number.isFinite(value)) return null
  return Math.round(value / 10_000) / 100
}

/** "HH:MM" to the hour and minute Google wants as separate integers. */
export function splitCutoff(cutoffTime: string): { hour: number; minute: number } {
  const [hour = '0', minute = '0'] = cutoffTime.split(':')
  return { hour: Number(hour), minute: Number(minute) }
}

/** Weekday numbers (0 = Sunday) as Google's enum names, in week order. */
export function businessDays(shipDays: number[]): string[] {
  return [...new Set(shipDays)]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b)
    .map((day) => WEEKDAY_NAMES[day] as string)
}
