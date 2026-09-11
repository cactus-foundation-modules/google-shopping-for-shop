// The promotions source's judgement calls, with nothing underneath them: no
// database, no config, no dates. lib/promotions-data.ts feeds this what the
// catalogue says and lib/promotions-xml.ts renders what comes back, so the one
// part worth arguing about is the one part that is testable on its own.
//
// The rule being advertised is shop's order-size deduction: a per-unit amount
// folded into a product's shelf price that stops being charged once the basket
// holds enough of that supplier's goods. See shop's lib/order-size-deduction.ts
// for the rule itself - this file only translates it into Google's vocabulary,
// and every difference between the two is written down where it happens.

/** One feed item that would lose money if its supplier's threshold were met. */
export type PromotionCandidate = {
  /** The feed item's id - what the product source will carry the mapping on. */
  itemId: string
  /** The supplier the shop files this product under. Blank-supplier products
   *  never reach here: they belong to no rule. */
  supplier: string
  /** The per-unit amount as stored, in pence, which with the supplier is what
   *  makes two items the same offer. Pence rather than pounds so the grouping
   *  key is an integer and 6.10 and 6.1 cannot become two promotions. */
  storedPence: number
  /** That amount grossed at THIS item's tax rate. */
  grossDeduction: number
  /** The supplier's threshold grossed at THIS item's tax rate. */
  grossThreshold: number
}

export type BuiltPromotion = {
  id: string
  moneyOff: number
  minimumPurchase: number
}

export type PromotionGrouping = {
  promotions: BuiltPromotion[]
  /** Feed item id -> the promotion it belongs to. One each: an item's amount and
   *  its supplier settle the question, so nothing can land in two. */
  promotionIdByItem: Map<string, string>
}

const SLUG_MAX = 24

/** Four base-36 characters of a plain string hash. Not a checksum - it only has
 *  to be the same every run and different for different text, so two suppliers
 *  whose names slug identically ("Verco Ltd." and "Verco, Ltd") cannot collapse
 *  into one promotion and quietly share an offer. */
function fingerprint(value: string): string {
  let hash = 5381
  for (let i = 0; i < value.length; i += 1) hash = ((hash * 33) ^ value.charCodeAt(i)) >>> 0
  return hash.toString(36).padStart(4, '0').slice(-4)
}

function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.slice(0, SLUG_MAX).replace(/-+$/, '')
}

/**
 * The promotion id an item belongs to. PURE and stable: the product source and
 * the promotions source are fetched separately, minutes or hours apart, and the
 * only thing joining them is that both spell this the same way from the same
 * two facts.
 */
export function promotionIdFor(supplier: string, storedPence: number): string {
  const name = supplier.trim()
  const body = slug(name)
  return `osd-${body ? `${body}-` : ''}${fingerprint(name.toLowerCase())}-${storedPence}`
}

/**
 * Candidates in, one promotion per (supplier, amount) out.
 *
 * Two figures have to be settled for a group whose items are not all taxed at
 * the same rate, and both are settled in the direction that under-promises:
 *
 *  - money off takes the LOWEST gross amount in the group, so the advertised
 *    discount is never more than the smallest one anybody actually gets;
 *  - the minimum spend takes the HIGHEST gross threshold, so the advertised bar
 *    is never lower than the real one.
 *
 * A shop on one VAT rate - which is nearly all of them - has one figure either
 * way and neither rule does anything.
 */
export function groupPromotions(candidates: readonly PromotionCandidate[]): PromotionGrouping {
  const byId = new Map<string, { moneyOff: number; minimumPurchase: number }>()
  const promotionIdByItem = new Map<string, string>()

  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.grossDeduction) || candidate.grossDeduction <= 0) continue
    if (!Number.isFinite(candidate.grossThreshold) || candidate.grossThreshold <= 0) continue
    const id = promotionIdFor(candidate.supplier, candidate.storedPence)
    promotionIdByItem.set(candidate.itemId, id)
    const existing = byId.get(id)
    if (!existing) {
      byId.set(id, { moneyOff: candidate.grossDeduction, minimumPurchase: candidate.grossThreshold })
      continue
    }
    existing.moneyOff = Math.min(existing.moneyOff, candidate.grossDeduction)
    existing.minimumPurchase = Math.max(existing.minimumPurchase, candidate.grossThreshold)
  }

  // Sorted so two runs of an unchanged catalogue produce byte-identical XML,
  // which is one less thing to wonder about when a source stops validating.
  const promotions = [...byId.entries()]
    .map(([id, figures]) => ({ id, ...figures }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return { promotions, promotionIdByItem }
}

/** A price with the pennies only where there are any: "£420", "£6.50". */
function amount(value: number, symbol: string): string {
  const rounded = Math.round(value * 100) / 100
  return `${symbol}${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(2)}`
}

/** Sixty characters is Google's limit and this has to fit inside it, so it says
 *  the two things that matter and stops. */
export function promotionTitle(promotion: BuiltPromotion, symbol: string): string {
  return `${amount(promotion.moneyOff, symbol)} off when you spend ${amount(promotion.minimumPurchase, symbol)} or more`
}

/**
 * The terms, which is where the difference between what Google can express and
 * what the shop actually does gets written down.
 *
 * Google's minimum spend is judged on the whole basket. The shop's is judged on
 * one supplier's goods, delivery excluded. So the sentence below says which
 * products the total is counted over, because that is the condition Google has
 * no field for and the one a shopper would otherwise be surprised by.
 *
 * It also says the money comes off each item, since Google advertises a single
 * flat figure and a basket of three gets three of them. Erring towards telling
 * a shopper they will get MORE than advertised is the safe half of this.
 */
export function promotionTerms(promotion: BuiltPromotion, symbol: string, extra?: string | null): string {
  const generated =
    `${amount(promotion.moneyOff, symbol)} comes off each of these products, once your basket holds ` +
    `${amount(promotion.minimumPurchase, symbol)} or more of them. The total is counted across these products only, ` +
    `and delivery does not count towards it.`
  const tail = extra?.trim()
  return tail ? `${generated} ${tail}` : generated
}
