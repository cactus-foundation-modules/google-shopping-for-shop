-- Two attributes Google matches offers on, and neither of them was reaching it.
--
-- Google files an offer against an existing product by GTIN first, then by
-- brand + MPN, and only then by how much the title and picture look like
-- somebody else's. A shop whose barcodes are its own - or whose trade sells the
-- same thing under the maker's part number rather than a barcode - lands on the
-- third test and loses it, and its listing sits on a product page of one with
-- every competitor grouped on another.
--
-- 1. The part number. Most shops already hold it: it is the product code they
--    order the thing by, and on a catalogue bought from a manufacturer it IS
--    the manufacturer's part number, printed on the box and published by every
--    other retailer selling it. Off by default all the same, because on plenty
--    of shops that code is a private buying reference and publishing it tells
--    the world what the shop calls its own stock.
--
-- 2. Google's own category. The feed sends the shop's category trail as
--    product_type, which is the shop's own wording and means nothing to anyone
--    else; google_product_category is Google's published taxonomy, and it is
--    what decides which shopping surfaces an item is even eligible for. Held
--    per shop category rather than per product: a shop with twelve thousand
--    products has perhaps forty categories, and typing it forty times is a
--    morning rather than a fortnight. A product's own answer still wins where
--    one is typed in, and a category with nothing against it inherits from the
--    nearest parent that has.
--
-- Idempotent so run-module-migrations can safely re-apply it.

ALTER TABLE "gsf_settings"
  ADD COLUMN IF NOT EXISTS "mpn_from_sku" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "gsf_category_taxonomy" (
    "category_id" TEXT NOT NULL,
    -- A value from Google's published product taxonomy: either the numeric id
    -- or the full "A > B > C" path. Never empty - nothing to say is no row.
    "google_product_category" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gsf_category_taxonomy_pkey" PRIMARY KEY ("category_id"),
    CONSTRAINT "gsf_category_taxonomy_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "shp_categories"("id") ON DELETE CASCADE
);
