// A rule as the admin routes receive it: parsed, tidied and checked against
// the fields this shop actually has, with the first problem in the owner's
// words. One place, so create, edit and preview refuse exactly the same drafts.
import { listLabelAttributes } from '@/modules/google-shopping-for-shop/lib/product-labels'
import { attributeIdOf, fieldMeta, type FieldKind } from '@/modules/google-shopping-for-shop/lib/feed-rules/fields'
import { normaliseDraft, ruleProblems, RuleDraftSchema, type RuleDraft } from '@/modules/google-shopping-for-shop/lib/feed-rules/types'

export type DraftCheck = { ok: true; draft: RuleDraft } | { ok: false; error: string }

/** The kind of every field this shop has, null for one it has not. Attribute
 *  fields are checked against the attributes that exist today; option fields
 *  are taken on trust, since an option name that matches nothing matches no
 *  item and harms nothing. */
export async function shopFieldKinds(): Promise<(field: string) => FieldKind | null> {
  const attributes = new Set((await listLabelAttributes()).map((attribute) => attribute.id))
  return (field: string) => {
    const attributeId = attributeIdOf(field)
    if (attributeId && !attributes.has(attributeId)) return null
    return fieldMeta(field)?.kind ?? null
  }
}

export async function checkDraft(input: unknown): Promise<DraftCheck> {
  const parsed = RuleDraftSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'That rule is not complete' }
  const draft = normaliseDraft(parsed.data)
  const problems = ruleProblems(draft, await shopFieldKinds())
  if (problems.length > 0) return { ok: false, error: problems[0] ?? 'That rule is not complete' }
  return { ok: true, draft }
}
