import { getProductById } from '@/modules/shop/lib/db'
import { getProductData } from '@/modules/google-shopping-for-shop/lib/product-data'
import { GoogleShoppingPanel } from '@/modules/google-shopping-for-shop/components/GoogleShoppingPanel'

// The Google Shopping tab on the shop product editor, contributed through the
// shop.product-editor-sections point. Server component: reads the product's
// stored Google fields, then hands the editing to the client panel, which saves
// through this module's own admin API.
export async function ProductGoogleShoppingSection({ productId }: { productId: string }) {
  const product = await getProductById(productId)
  // Variant children inherit the parent's Google fields (each variation's own
  // barcode already supplies its GTIN), so the tab only appears on the parent.
  if (!product || product.catalogueHidden) return null
  const data = await getProductData(productId)
  return <GoogleShoppingPanel initial={data} />
}
