# Google Shopping for the Cactus Shop

Puts your shop on Google Shopping. The module serves a product feed for Google
Merchant Center in which **every variation is its own listing** - its own price,
photos, stock and link - grouped under its parent product, so a search for the
exact size and colour someone wants finds the exact size and colour you sell.

Requires the [Shop](https://github.com/cactus-foundation-modules/shop) and
[Shop Variations](https://github.com/cactus-foundation-modules/shop-variations)
modules.

## What it does

- Serves a Merchant Center product feed at `/google-shopping/feed.xml`, guarded
  by a key baked into the address. Google fetches it on its own schedule; there
  is nothing to run and nothing to export.
- One feed item per variation, sharing an `item_group_id` with its siblings, so
  Google shows the right size, colour and finish with the right price and photo.
  Products without variations go along as single items.
- Each listing links to the variation's own address, which opens the product
  page with that exact combination already chosen.
- Prices are always sent VAT-inclusive, whatever the storefront displays - as
  Google requires for the UK.
- Variation options are mapped onto Google's colour / size / material / pattern
  attributes by name, so filters on Google work without any setup.
- Products the shop hides (draft, hidden, out of stock on shops that hide them)
  stay out of the feed automatically. Sale prices travel as sale prices.
- Brand runs in order: whatever the product's own Google Shopping tab says, then
  the product's supplier, then the shop-wide default.

## Setting up

1. Install the module, then switch the feed on under **Shop → Settings →
   Google Shopping**. Copy the feed address.
2. In Google Merchant Center: **Products → Data sources → Add product source →
   Add a file with a link**, paste the address and pick a daily fetch.
3. Check the **Brand** settings in the same tab - Google wants a brand on nearly
   everything. By default each listing takes the name of the supplier the shop
   files the product under; the default brand covers anything with no supplier.
   Switch the supplier option off if your suppliers are middlemen rather than the
   names on the box.

That is the whole job. Optionally, each product's editor gains a **Google
Shopping** tab for per-product details: brand, GTIN, MPN, Google's own category,
condition, and a tick box to keep the product out of the feed altogether.
Variations use their own barcodes as their GTINs automatically.

## Notes

- The feed address contains its key. If it ever leaks, mint a new address from
  the settings tab; the old one stops working immediately.
- A closed shop, or one running in quote-only mode (no public prices), serves no
  feed - Google requires a price on every item.
- Buying codes (SKUs) are never published in the feed.
