// GET/PATCH /api/m/google-shopping-for-shop/admin/product-data?productId=...
// The per-product Google fields behind the product editor's Google Shopping tab.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { getProductById } from '@/modules/shop/lib/db'
import { getProductData, upsertProductData } from '@/modules/google-shopping-for-shop/lib/product-data'
import { GSF_CONDITIONS } from '@/modules/google-shopping-for-shop/lib/types'

export async function GET(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const productId = new URL(request.url).searchParams.get('productId')
  if (!productId) return NextResponse.json({ error: 'productId is required' }, { status: 400 })
  return NextResponse.json({ data: await getProductData(productId) })
}

const PatchBody = z.object({
  productId: z.string().min(1),
  brand: z.string().max(70).nullable(),
  gtin: z.string().max(50).nullable(),
  mpn: z.string().max(70).nullable(),
  googleProductCategory: z.string().max(300).nullable(),
  // Null means "use the shop-wide default".
  condition: z.enum(GSF_CONDITIONS).nullable(),
  excluded: z.boolean(),
})

export async function PATCH(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const parsed = PatchBody.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid fields' }, { status: 400 })
  // The row is keyed on the product with a foreign key behind it, so a made-up
  // id would fail anyway - but a plain "no such product" reads better.
  const product = await getProductById(parsed.data.productId)
  if (!product) return NextResponse.json({ error: 'No such product' }, { status: 404 })
  await upsertProductData(parsed.data)
  return NextResponse.json({ data: await getProductData(parsed.data.productId) })
}
