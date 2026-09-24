// GET/PATCH /api/m/google-shopping-for-shop/admin/product-data?productId=...
// The per-product Google fields behind the product editor's Google Shopping tab,
// and the owner's own feed choice for the product (follow the rules, always
// send, never send). A change of choice is logged and can be undone.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { requireShopUser } from '@/modules/shop/lib/access'
import { getProductById } from '@/modules/shop/lib/db'
import { getProductData, upsertProductData } from '@/modules/google-shopping-for-shop/lib/product-data'
import { feedChoiceSummary } from '@/modules/google-shopping-for-shop/lib/feed-choice-copy'
import { setFeedChoices } from '@/modules/google-shopping-for-shop/lib/feed-choice'
import { FEED_CHOICES, GSF_CONDITIONS } from '@/modules/google-shopping-for-shop/lib/types'
import { changedBy } from '@/modules/google-shopping-for-shop/lib/workbench-actor'

export async function GET(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const productId = new URL(request.url).searchParams.get('productId')
  if (!productId) return NextResponse.json({ error: 'productId is required' }, { status: 400 })
  return NextResponse.json({ data: await getProductData(productId) })
}

const PatchBody = z.object({
  productId: z.string().min(1).max(100),
  brand: z.string().max(70).nullable(),
  gtin: z.string().max(50).nullable(),
  mpn: z.string().max(70).nullable(),
  googleProductCategory: z.string().max(300).nullable(),
  // Null means "use the shop-wide default".
  condition: z.enum(GSF_CONDITIONS).nullable(),
  feedChoice: z.enum(FEED_CHOICES),
})

export async function PATCH(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const parsed = PatchBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid fields' }, { status: 400 })
  // The row is keyed on the product with a foreign key behind it, so a made-up
  // id would fail anyway - but a plain "no such product" reads better.
  const product = await getProductById(parsed.data.productId)
  if (!product) return NextResponse.json({ error: 'No such product' }, { status: 404 })

  const { feedChoice, ...fields } = parsed.data
  try {
    const choice = await prisma.$transaction(async (tx) => {
      await upsertProductData(fields, tx)
      return setFeedChoices(
        [{ productId: product.id, choice: feedChoice }],
        { summary: feedChoiceSummary(product.name, feedChoice), createdBy: changedBy(gate.user) },
        tx,
      )
    }, { timeout: 50_000, maxWait: 10_000 })
    return NextResponse.json({ data: await getProductData(product.id), changeId: choice.changeId })
  } catch (error) {
    console.error('[google-shopping] product data save failed:', error)
    return NextResponse.json({ error: 'Could not save the Google details. Nothing was changed.' }, { status: 500 })
  }
}
