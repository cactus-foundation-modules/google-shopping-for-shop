// Feed rules, applied: what an item's rule outcome changes about the row the
// feed sends.
//
// Pure, and apart from the evaluator because this half has to know how the
// feed resolves identifiers and titles, and the evaluator must not. The feed
// build holds each item's raw inputs until the rules have run, then hands them
// here once.
//
// Where the owner's own hand-typed answer and a rule disagree, the owner wins:
//  - a brand typed on the product beats a rule's brand, which in turn beats
//    the supplier and the shop-wide default;
//  - a typed-in GTIN or MPN on a product keeps its identifiers, whatever a
//    "no identifiers" rule says;
//  - a title template set on the item itself beats a rule's template.
import { clipCodePoints } from '@/modules/google-shopping-for-shop/lib/feed-xml'
import { identifiersOf, type RowCodes } from '@/modules/google-shopping-for-shop/lib/identifiers'
import {
  buildTitleTemplateContext,
  renderTitleTemplate,
  type TitleTemplateContext,
  type TitleTemplateContextInput,
} from '@/modules/google-shopping-for-shop/lib/title-template-render'
import { CUSTOM_LABEL_MAX, CUSTOM_LABEL_SLOTS } from '@/modules/google-shopping-for-shop/lib/feed-rules/types'
import type { RuleOutcome } from '@/modules/google-shopping-for-shop/lib/feed-rules/evaluate'
import type { GsfProductData } from '@/modules/google-shopping-for-shop/lib/types'

/** Everything identifiersOf needs, held until the rules have had their say. */
export type IdentityInputs = {
  data: Pick<GsfProductData, 'brand' | 'gtin' | 'mpn'>
  fallbacks: { supplier: string | null; defaultBrand: string | null; useSupplier: boolean }
  codes: RowCodes
  standalone: boolean
  /** The shop-wide setting. A rule can switch it on for the items it matches;
   *  it cannot switch it off. */
  mpnFromSku: boolean
}

export type ResolvedIdentifiers = { brand?: string; gtin?: string; mpn?: string; identifierExists: boolean }

/** Brand, GTIN and MPN after the rules. */
export function identifiersAfterRules(inputs: IdentityInputs, outcome: RuleOutcome): ResolvedIdentifiers {
  const typedBrand = inputs.data.brand?.trim() || null
  const data = { ...inputs.data, brand: typedBrand ?? outcome.identifiers.brand?.value ?? null }
  const resolved = identifiersOf(data, inputs.fallbacks, inputs.codes, {
    standalone: inputs.standalone,
    mpnFromSku: inputs.mpnFromSku || Boolean(outcome.identifiers.mpnFromSku),
  })
  if (!outcome.identifiers.noIdentifiers) return resolved
  // Only the listings entitled to a typed-in code have one to protect.
  const typedCode = inputs.standalone && Boolean(inputs.data.gtin?.trim() || inputs.data.mpn?.trim())
  if (typedCode) return resolved
  // Google reads identifier_exists "no" beside a GTIN or MPN as a
  // contradiction and disapproves the item, so both go. The brand stays: it is
  // not an identifier on its own, and it is what the listing is filed under.
  return { ...(resolved.brand ? { brand: resolved.brand } : {}), identifierExists: false }
}

/** The title inputs an item carries before its identifiers are known. */
export type TitleInputs = Omit<TitleTemplateContextInput, 'mpn' | 'gtin' | 'brand'>

export type ResolvedTitle = {
  title: string
  context: TitleTemplateContext
}

/** The title after the rules: the item's own template, else the first rule's,
 *  else the item's ordinary title. */
export function titleAfterRules(
  inputs: TitleInputs,
  identifiers: ResolvedIdentifiers,
  ownTemplate: string | undefined,
  outcome: RuleOutcome,
): ResolvedTitle {
  const context = buildTitleTemplateContext({ ...inputs, mpn: identifiers.mpn, gtin: identifiers.gtin, brand: identifiers.brand })
  const template = ownTemplate?.trim() || outcome.titleTemplate?.template
  return { title: renderTitleTemplate(template, context, inputs.originalTitle).title, context }
}

/** The five custom labels as the feed renders them: index = slot, undefined
 *  where nothing set one. Undefined as a whole when no slot is filled, so an
 *  item untouched by label rules carries nothing extra. */
export function customLabelsOf(outcome: RuleOutcome): Array<string | undefined> | undefined {
  const labels = CUSTOM_LABEL_SLOTS.map((slot) => {
    const value = outcome.labels[slot]?.value.trim()
    return value ? clipCodePoints(value, CUSTOM_LABEL_MAX) : undefined
  })
  return labels.some((label) => label !== undefined) ? labels : undefined
}
