import { getProductById } from '@/modules/shop/lib/db'
import { getEditorPayload } from '@/modules/shop-variations/lib/variants-service'
import { getProductData } from '@/modules/google-shopping-for-shop/lib/product-data'
import { getFeedChoices } from '@/modules/google-shopping-for-shop/lib/feed-choice'
import { getMerchantCentreLinks } from '@/modules/google-shopping-for-shop/lib/merchant-centre'
import { GoogleShoppingPanel } from '@/modules/google-shopping-for-shop/components/GoogleShoppingPanel'
import { MerchantCentreLinks } from '@/modules/google-shopping-for-shop/components/MerchantCentreLinks'

// The Google Shopping tab on the shop product editor, contributed through the
// shop.product-editor-sections point. Server component: reads the product's
// stored Google fields, then hands the editing to the client panel, which saves
// through this module's own admin API.
export async function ProductGoogleShoppingSection({ productId }: { productId: string }) {
  const product = await getProductById(productId)
  // Variant children inherit the parent's Google fields (each variation's own
  // barcode already supplies its GTIN), so the tab only appears on the parent.
  if (!product || product.catalogueHidden) return null
  const [data, links, payload] = await Promise.all([
    getProductData(productId),
    getMerchantCentreLinks(productId),
    getEditorPayload(productId),
  ])
  const variants = payload?.variants ?? []
  const choices = await getFeedChoices(variants.map((variant) => variant.childProductId))
  const variations = variants.map((variant) => ({
    id: variant.childProductId,
    label: variant.label,
    enabled: variant.enabled,
    choice: choices.get(variant.childProductId) ?? 'rules',
  }))
  return (
    <>
      <MerchantCentreLinks view={links} />
      <GoogleShoppingPanel initial={data} variations={variations} />
    </>
  )
}
