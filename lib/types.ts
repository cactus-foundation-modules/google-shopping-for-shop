// Shared shapes for the Google Shopping feed module.
import type { BestSellerGranularity } from '@/modules/google-shopping-for-shop/lib/best-sellers/types'

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

// Where each product's `shipping_label` - the group Merchant Center matches its
// delivery rates against - is taken from.
//
//   attribute          the value of a product attribute the owner picked. What
//                      every install did before delivery sync existed, and
//                      still the right answer where the groups an owner wants
//                      are not the groups their delivery prices are written
//                      against.
//   delivery-services  the group the product's own delivery price is written
//                      against - its range, category or supplier - taken from
//                      whichever module publishes delivery services. The
//                      labels then line up exactly with the rate groups this
//                      module sends to Merchant Center, which is the point.
export const GSF_LABEL_SOURCES = ['attribute', 'delivery-services'] as const
export type GsfLabelSource = (typeof GSF_LABEL_SOURCES)[number]

export function asLabelSource(value: unknown): GsfLabelSource {
  return GSF_LABEL_SOURCES.includes(value as GsfLabelSource) ? (value as GsfLabelSource) : 'attribute'
}

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
  // Where the label comes from at all - see GSF_LABEL_SOURCES above. The
  // attribute above is only consulted on 'attribute'.
  shippingLabelSource: GsfLabelSource
  // Check every day whether Merchant Center still charges what this site
  // charges, and raise an alert when it does not. Off by default: it is only
  // meaningful once the delivery settings have been sent over at least once.
  deliverySyncEnabled: boolean
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
  // The Merchant Center data source (Google's word for a feed) this site's
  // feed is filed under, typed in by the owner. Null means "work it out by
  // matching the feed address", which is the default and is right for almost
  // everyone; it is only worth filling in where an account carries several
  // feeds pointing at the same address.
  feedDataSourceId: string | null
  // The one we worked out ourselves, cached so the discovery runs once rather
  // than daily. Never overwrites the owner's own answer above.
  feedDataSourceDetectedId: string | null
  // How many products may newly stop being shown between one check and the
  // next before the site raises an alert. 0 switches the alert off.
  disapprovalAlertThreshold: number
  // Email a health alert as well as raising it in the admin. Off by default:
  // an alert in the bell is free, and an email is a decision.
  alertEmailEnabled: boolean
  alertEmail: string | null
  // When item issues were last read from Google. Null means never, which is
  // NOT the same as "nothing is wrong" - the Health tab draws the two apart.
  issuesCheckedAt: Date | null
  // How many items were disapproved at the previous check, so a jump can be
  // measured against something. Null before the first check.
  lastDisapprovedCount: number | null
  // Bring Google's own performance figures in on the daily check. ON by
  // default, unlike almost everything else here, because it changes nothing -
  // it reads figures Google already holds and writes them to a table of our
  // own. A site with no Merchant Center account linked never gets as far as
  // making the call.
  performanceImportEnabled: boolean
  // How far back the first import reaches, in days.
  performanceBackfillDays: number
  // How long a day's figures are kept. 0 keeps everything for ever.
  performanceRetentionDays: number
  // 'YYYY-MM-DD': the last day imported AND old enough that Google has stopped
  // revising it. Null before the first import. Days after it are re-read on
  // every run, because Google attributes a conversion to the day of the click
  // days after the fact.
  performanceImportedThrough: string | null
  // When the import last ran at all. Null and an empty table together mean
  // nobody has ever asked, which is NOT "nothing happened".
  performanceCheckedAt: Date | null
  // Whether Google accepted conversions in the query. Null is "not tried yet";
  // false means it refused. NOT a one-way latch - see the stamp below.
  performanceConversionsAvailable: boolean | null
  // When the answer above was last learned, which is what stops a refusal
  // becoming a permanent claim: the daily check asks again once it is stale,
  // and a press of Fetch now asks again whatever it says. Null means nobody
  // has ever got an answer either way.
  performanceConversionsCheckedAt: Date | null
  // When an import last failed, and what was said about it. Cleared by the
  // next run that succeeds, so the pair means "the most recent attempt
  // failed" rather than "something went wrong once". Null on both is a clean
  // record.
  performanceFailedAt: Date | null
  performanceLastError: string | null
  // Fetch Google's best sellers rankings. Off by default: a second daily call,
  // a report not every account has, and a question about the market rather
  // than about this shop's feed.
  bestSellersEnabled: boolean
  // Google's numeric product category ids to rank, comma separated. Null falls
  // back to the ids already typed against this shop's own categories, and then
  // to Google's own default of every top-level category.
  bestSellersCategoryIds: string | null
  bestSellersGranularity: BestSellerGranularity
  // Ranked rows kept per category, per kind.
  bestSellersLimit: number
  bestSellersCheckedAt: Date | null
  // Add the campaign tags to every product link in the feed, and publish the
  // paid-traffic address beside it. Off by default: it changes the address
  // Google sends shoppers to, which everything else measuring this site will
  // notice, so it is the owner's decision rather than something an update does
  // to them.
  linkTaggingEnabled: boolean
  // Count landings from Google for ourselves. Off by default: it writes a row
  // per arrival and, for a visitor who has agreed to marketing, sets a cookie.
  clickTrackingEnabled: boolean
  // How long a landing is kept, in days. 0 keeps everything.
  clickRetentionDays: number
  // Send a changed price or availability to Merchant Center as it happens,
  // rather than waiting for Google to fetch the feed. Off by default: it writes
  // to somebody's advertising account.
  pricePushEnabled: boolean
  // The supplemental data source the module created to send into. Null until
  // the owner has set it up, and nothing is sent while it is null.
  pushDataSourceId: string | null
  // The primary data sources it has been linked into. A supplemental source
  // that is not linked into a primary one is accepted and then ignored, so
  // "created" and "working" are two different states.
  pushLinkedSourceIds: string[]
  pushLinkedAt: Date | null
  // The shortest gap between two runs, in seconds.
  pushDebounceSeconds: number
  // How many items the hourly reconcile asks Google about.
  pushReconcileSample: number
  // The two-letter language Google files this shop's products under. Half of a
  // product's identity at Google, along with the feed label.
  contentLanguage: string
  // --- Google Ads (a different API, a different sign-in) -------------------
  // The master switch for anything Google Ads. Off by default: it reads
  // somebody's advertising account and, with the switch below, writes to it.
  adsEnabled: boolean
  // Fetch what the ads cost, day by day. Read-only at Google's end, so it is on
  // by default - but nothing happens at all while adsEnabled is off.
  adsSpendImportEnabled: boolean
  adsSpendBackfillDays: number
  // How long a day's spend is kept. 0 keeps everything for ever.
  adsSpendRetentionDays: number
  // Send Google Ads the sales this site credited to a paid click. Off by
  // default and separately from the master switch: it is the only thing in this
  // module that writes to an advertising account.
  adsConversionUploadEnabled: boolean
  // Google's own resource name for the conversion action we upload against.
  // Null means it has not been set up, which is what stops anything being sent.
  adsConversionAction: string | null
  adsConversionActionName: string | null
  // What GOOGLE said about whether that action is primary, when we last asked.
  // Null is "not known". The upload refuses on anything but a positive false:
  // the google-tag module already reports Ads conversions from the browser, and
  // a primary action here would have every ad sale counted twice.
  adsConversionActionPrimary: boolean | null
  adsConversionActionCheckedAt: Date | null
  // The Ads account's own currency and timezone, learned from Google rather
  // than assumed. The currency is what the spend is denominated in; the
  // timezone is what each day is measured in.
  adsCurrency: string | null
  adsTimeZone: string | null
  adsAccountCheckedAt: Date | null
}

// What the admin settings tab sees. The full feed URL is composed server-side so
// the tab never has to know the site URL or the path shape.
/** One promotion as the settings tab draws it. Dates are ISO strings because
 *  this crosses the wire. */
export type GsfPromotionWindowView = {
  /** The offer's identity, independent of how many times it has been reissued.
   *  What a reissue is asked for by. */
  baseKey: string
  /** What Google is actually told the promotion is called, this time round. */
  promotionId: string
  /** 0 is the original id; above 0 it has been renewed or reissued that often. */
  revision: number
  startsAt: string
  endsAt: string
}

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
  // Where the label comes from - an attribute, or the delivery rules.
  shippingLabelSource: GsfLabelSource
  // Whether a module publishing delivery SERVICES AND GROUPS is installed, so
  // the labels can come from the delivery rules at all. Separate from
  // deliveryOptionsAvailable below: that one asks whether anything publishes
  // per-product timing, this one whether anything publishes the shop's whole
  // delivery catalogue, and a module could do either without the other.
  deliveryScopesAvailable: boolean
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
  // The promotions currently being advertised, with the id each one carries and
  // when its run is up. Here because a promotion id is single-use at Google's
  // end: once one has stopped it can never be revived, and the only way out is
  // a fresh id, so the owner needs to see which is which.
  promotionWindows: GsfPromotionWindowView[]
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
  // The Merchant Center feed ("data source") number the owner typed in, '' for
  // "work it out".
  feedDataSourceId: string
  // The one we worked out ourselves, '' where we have not yet. Shown so the
  // owner can see we found the right feed before deciding whether to override.
  feedDataSourceDetectedId: string
  disapprovalAlertThreshold: number
  alertEmailEnabled: boolean
  alertEmail: string
}

// The owner's own say on whether a product or variation goes to Google:
// follow the feed rules, always send it, or never send it. Beats every rule.
export const FEED_CHOICES = ['rules', 'include', 'exclude'] as const
export type FeedChoice = (typeof FEED_CHOICES)[number]

export function asFeedChoice(value: unknown): FeedChoice {
  return FEED_CHOICES.includes(value as FeedChoice) ? (value as FeedChoice) : 'rules'
}

// Per-product Google fields, as stored (gsf_product_data). All-null plus
// feedChoice 'rules' is the same as having no row at all.
export type GsfProductData = {
  productId: string
  brand: string | null
  gtin: string | null
  mpn: string | null
  googleProductCategory: string | null
  condition: GsfCondition | null
  feedChoice: FeedChoice
}

export const EMPTY_PRODUCT_DATA: Omit<GsfProductData, 'productId'> = {
  brand: null,
  gtin: null,
  mpn: null,
  googleProductCategory: null,
  condition: null,
  feedChoice: 'rules',
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
