// GET/PATCH /api/m/google-shopping-for-shop/admin/category-taxonomy
//
// Google's own product taxonomy, one value per shop category. Its own address
// rather than a corner of the settings route because it is a list as long as
// the shop's category tree, and the settings tab has no business re-fetching
// forty rows every time somebody ticks a box.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { listCategories } from '@/modules/shop/lib/db/catalogue'
import {
  GOOGLE_CATEGORY_MAX,
  getCategoryTaxonomy,
  setCategoryTaxonomy,
  taxonomyRows,
} from '@/modules/google-shopping-for-shop/lib/category-taxonomy'

async function view() {
  const [categories, mapping] = await Promise.all([listCategories(), getCategoryTaxonomy()])
  return taxonomyRows(categories, mapping)
}

export async function GET() {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error
  return NextResponse.json({ categories: await view() })
}

const PatchBody = z.object({
  categoryId: z.string().min(1).max(64),
  // Empty clears it. Not checked against Google's published list on purpose -
  // see the note on GOOGLE_CATEGORY_MAX; the cap only stops a paste of half a
  // page reaching the column.
  googleProductCategory: z.string().max(GOOGLE_CATEGORY_MAX * 4),
})

export async function PATCH(request: NextRequest) {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error
  const parsed = PatchBody.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid category' }, { status: 400 })
  // A category that is no longer there would fail on the foreign key as a 500;
  // it is a 404, and the refreshed list the tab gets back says why.
  const categories = await listCategories()
  if (!categories.some((c) => c.id === parsed.data.categoryId)) {
    return NextResponse.json({ error: 'That category no longer exists' }, { status: 404 })
  }
  await setCategoryTaxonomy(parsed.data.categoryId, parsed.data.googleProductCategory)
  return NextResponse.json({ categories: taxonomyRows(categories, await getCategoryTaxonomy()) })
}
