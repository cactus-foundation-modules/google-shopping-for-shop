// GET/PATCH /api/m/google-shopping-for-shop/admin/product-data/variations?productId=...
// The owner's own feed choice for each variation of one listing: follow the
// rules, always send, or never send. A variation's own choice beats its
// listing's; "follow the rules" on a variation defers to the listing. Saved
// as one change log entry, so the whole save can be undone at once.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { getEditorPayload } from '@/modules/shop-variations/lib/variants-service'
import { getFeedChoices, setFeedChoices } from '@/modules/google-shopping-for-shop/lib/feed-choice'
import { variationChoicesSummary } from '@/modules/google-shopping-for-shop/lib/feed-choice-copy'
import { FEED_CHOICES } from '@/modules/google-shopping-for-shop/lib/types'
import { changedBy } from '@/modules/google-shopping-for-shop/lib/workbench-actor'

async function variationsOf(productId: string) {
  const payload = await getEditorPayload(productId)
  return (payload?.variants ?? []).map((variant) => ({ id: variant.childProductId, label: variant.label, enabled: variant.enabled }))
}

export async function GET(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const productId = new URL(request.url).searchParams.get('productId')
  if (!productId) return NextResponse.json({ error: 'productId is required' }, { status: 400 })
  const variations = await variationsOf(productId)
  const choices = await getFeedChoices(variations.map((variation) => variation.id))
  return NextResponse.json({ variations: variations.map((variation) => ({ ...variation, choice: choices.get(variation.id) ?? 'rules' })) })
}

const PatchBody = z.object({
  productId: z.string().min(1).max(100),
  choices: z.array(z.object({
    variationId: z.string().min(1).max(100),
    choice: z.enum(FEED_CHOICES),
  })).min(1).max(2000),
})

export async function PATCH(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const parsed = PatchBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid choices' }, { status: 400 })

  const payload = await getEditorPayload(parsed.data.productId)
  if (!payload) return NextResponse.json({ error: 'No such product' }, { status: 404 })
  // Only this listing's own variations: an id from anywhere else is refused
  // rather than quietly written against some other product.
  const own = new Set(payload.variants.map((variant) => variant.childProductId))
  if (parsed.data.choices.some((entry) => !own.has(entry.variationId))) {
    return NextResponse.json({ error: 'One of those is not a variation of this product. Reload the page and try again.' }, { status: 400 })
  }

  try {
    const result = await setFeedChoices(
      parsed.data.choices.map((entry) => ({ productId: entry.variationId, choice: entry.choice })),
      { summary: variationChoicesSummary(payload.product.name), createdBy: changedBy(gate.user) },
    )
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    console.error('[google-shopping] variation choices save failed:', error)
    return NextResponse.json({ error: 'Could not save the variation choices. Nothing was changed.' }, { status: 500 })
  }
}
