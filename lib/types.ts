// Shared shapes for the Google Shopping feed module.

export const GSF_CONDITIONS = ['new', 'refurbished', 'used'] as const
export type GsfCondition = (typeof GSF_CONDITIONS)[number]

// Where Google's survey opt-in sits on the order confirmation page. These are
// Google's own values, spelled their way, because each one travels verbatim
// into the snippet their script reads.
export const GSF_OPT_IN_STYLES = [
  'CENTER_DIALOG',
  'BOTTOM_RIGHT_DIALOG',
  'BOTTOM_LEFT_DIALOG',
  'TOP_RIGHT_DIALOG',
  'TOP_LEFT_DIALOG',
  'BOTTOM_TRAY',
] as const
export type GsfOptInStyle = (typeof GSF_OPT_IN_STYLES)[number]

export type GsfSettings = {
  enabled: boolean
  // Null until first read mints one (lib/settings.ts). The feed route refuses to
  // serve while it is null, so a token always exists before a URL can work.
  feedToken: string | null
  defaultBrand: string | null
  // Take each product's brand from the supplier the shop files it under
  // (shp_products.supplier), ahead of defaultBrand. Off, the supplier is ignored.
  brandFromSupplier: boolean
  // Publish each row's own product code (shp_products.sku) as Google's `mpn`.
  // Off by default: on a catalogue bought in, that code is the maker's part
  // number and the strongest thing Google can match a barcodeless offer on; on
  // a shop that numbers its own stock it is a private buying reference. Only
  // the owner knows which of the two they have.
  mpnFromSku: boolean
  defaultCondition: GsfCondition
  // The Merchant Center account number the feed is filed under, digits only.
  // Null until typed in, which is the only thing standing between a product and
  // a link straight to its Google listing.
  merchantId: string | null
  // The feed label Google files this feed against, usually the two-letter
  // country the shop sells into. Null leaves it off the link, which Merchant
  // Center answers by asking which feed is meant.
  feedLabel: string | null
  // Send each item's own delivery services and prices, taken from whichever
  // module publishes them. Off by default: an item carrying its own shipping
  // groups OVERRIDES the Merchant Center account's rates for that item, so it
  // is the owner's decision, not a default.
  sendDeliveryOptions: boolean
  // The country those prices apply to, ISO 3166-1 alpha-2. Google requires one
  // on every shipping group and has no default of its own.
  shippingCountry: string
  // The product attribute whose value each item carries as `shipping_label`,
  // which is what Merchant Center matches its own delivery rates against. Null
  // is off, and off is the default: this changes what Google charges for
  // delivery, so it is the owner's decision rather than something an update
  // does to them. The id belongs to whichever module publishes attributes; one
  // that no longer exists finds nothing and leaves the label off.
  shippingLabelAttributeId: string | null
  // Send each item's return policy label - the shop's own non-returnable note -
  // so Merchant Center can judge made-to-order goods by a policy of their own.
  // Off by default: a label matching no policy over there silently falls back to
  // the account default, so the policies have to exist before the labels mean
  // anything, and only the owner knows whether they do.
  returnPolicyLabelsEnabled: boolean
  // Carry the listing's own photographs behind each variation's own, minus any
  // that belong to another variation. Off by default: on a shop whose listing
  // gallery is a parade of its finishes, the pictures nothing on the site knows
  // are a variation's would arrive under the wrong variation's price, and that
  // is not a discovery an update should spring on anyone.
  parentImagesOnVariations: boolean
  // Serve the product REVIEW feed as well as the product feed. Separate switch
  // and separate address: a shop may want its products on Google without
  // republishing what customers wrote about them.
  reviewsFeedEnabled: boolean
  // Serve the PROMOTIONS data source, built from the shop's order-size
  // deduction. Off by default: it advertises a discount, and the advertisement
  // is slightly wider than the rule behind it (see lib/promotions-data.ts).
  promotionsFeedEnabled: boolean
  // Extra terms appended to every promotion. The condition sentence is worked
  // out from the shop's own figures and always leads; this is whatever else the
  // owner needs to say. Null is nothing to add.
  promotionsFinePrint: string | null
  // Show Google's own survey opt-in on the order confirmation page (Google
  // Customer Reviews). Off by default - it hands the customer's email to Google
  // so they can be surveyed after delivery, which is the owner's call.
  customerReviewsEnabled: boolean
  customerReviewsStyle: GsfOptInStyle
  // Working days from order to doorstep, used for the opt-in's estimated
  // delivery date where nothing on the site publishes real delivery timing.
  // Google requires a date and has no default of its own.
  customerReviewsDeliveryDays: number
}

// What the admin settings tab sees. The full feed URL is composed server-side so
// the tab never has to know the site URL or the path shape.
export type GsfSettingsView = {
  enabled: boolean
  feedUrl: string | null
  defaultBrand: string
  brandFromSupplier: boolean
  mpnFromSku: boolean
  defaultCondition: GsfCondition
  merchantId: string
  feedLabel: string
  sendDeliveryOptions: boolean
  shippingCountry: string
  shippingLabelAttributeId: string
  // Every attribute the shop could group by, for the dropdown. Empty where no
  // module publishes any, which makes the setting a promise nothing can keep -
  // so the tab says so rather than offering an empty list.
  shippingLabelAttributes: Array<{ id: string; name: string }>
  // Whether a module publishing delivery services is actually installed. False
  // makes the switch above a promise nothing can keep, so the tab says so
  // instead of leaving the owner wondering why the feed looks unchanged.
  deliveryOptionsAvailable: boolean
  returnPolicyLabelsEnabled: boolean
  parentImagesOnVariations: boolean
  reviewsFeedEnabled: boolean
  // The review feed's own address, null for the same reasons as feedUrl above.
  reviewsFeedUrl: string | null
  promotionsFeedEnabled: boolean
  promotionsFinePrint: string
  // The promotions source's own address, null for the same reasons as feedUrl.
  promotionsFeedUrl: string | null
  // Whether the shop is actually running the order-size deduction. False makes
  // the switch a promise nothing can keep - the source would be empty - so the
  // tab says so rather than leaving the owner wondering where the promotions
  // went.
  promotionsAvailable: boolean
  // Whether any installed module publishes customer reviews at all. False makes
  // the review feed a document with nothing in it, so the tab says so.
  reviewsAvailable: boolean
  customerReviewsEnabled: boolean
  customerReviewsStyle: GsfOptInStyle
  customerReviewsDeliveryDays: number
  // Products the last feed build refused to send, because Google would reject
  // them on sight. `checkedAt` null means no feed has been fetched since this
  // shipped, which is NOT the same as "none" - the tab draws the two
  // differently rather than showing a clean zero it has not earned.
  withheld: { total: number; titles: string[]; checkedAt: string | null }
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

/** One shop category as the Google-taxonomy mapping screen needs it: its name,
 *  where it sits, and what has been said about it. Lives here rather than beside
 *  the database helpers so the admin tab can name the shape without importing a
 *  file that reaches Prisma. */
export type GsfCategoryTaxonomyRow = {
  categoryId: string
  /** "Office Chairs > Reception & Visitor Chairs" - the trail, so two categories
   *  called "Accessories" are tellable apart. */
  path: string
  /** What the owner typed against this category, '' where nothing has been. */
  googleProductCategory: string
  /** What this category ends up sending when nothing is typed against it, taken
   *  from the nearest parent that has one. '' where no parent has one either. */
  inherited: string
}
