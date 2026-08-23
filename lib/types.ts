// Shared shapes for the Google Shopping feed module.

export const GSF_CONDITIONS = ['new', 'refurbished', 'used'] as const
export type GsfCondition = (typeof GSF_CONDITIONS)[number]

export type GsfSettings = {
  enabled: boolean
  // Null until first read mints one (lib/settings.ts). The feed route refuses to
  // serve while it is null, so a token always exists before a URL can work.
  feedToken: string | null
  defaultBrand: string | null
  // Take each product's brand from the supplier the shop files it under
  // (shp_products.supplier), ahead of defaultBrand. Off, the supplier is ignored.
  brandFromSupplier: boolean
  defaultCondition: GsfCondition
  // The Merchant Center account number the feed is filed under, digits only.
  // Null until typed in, which is the only thing standing between a product and
  // a link straight to its Google listing.
  merchantId: string | null
  // The feed label Google files this feed against, usually the two-letter
  // country the shop sells into. Null leaves it off the link, which Merchant
  // Center answers by asking which feed is meant.
  feedLabel: string | null
}

// What the admin settings tab sees. The full feed URL is composed server-side so
// the tab never has to know the site URL or the path shape.
export type GsfSettingsView = {
  enabled: boolean
  feedUrl: string | null
  defaultBrand: string
  brandFromSupplier: boolean
  defaultCondition: GsfCondition
  merchantId: string
  feedLabel: string
}

// Per-product Google fields, as stored (gsf_product_data). All-null plus
// excluded=false is the same as having no row at all.
export type GsfProductData = {
  productId: string
  brand: string | null
  gtin: string | null
  mpn: string | null
  googleProductCategory: string | null
  condition: GsfCondition | null
  excluded: boolean
}

export const EMPTY_PRODUCT_DATA: Omit<GsfProductData, 'productId'> = {
  brand: null,
  gtin: null,
  mpn: null,
  googleProductCategory: null,
  condition: null,
  excluded: false,
}
