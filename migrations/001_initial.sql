-- Google Shopping feed module: settings singleton plus a per-product row for the
-- handful of fields Google wants that the shop itself has no home for (brand,
-- GTIN, MPN, Google's own category, condition) and an opt-out flag. All DDL is
-- idempotent so run-module-migrations can safely re-apply it (see the runner's
-- self-heal path).

CREATE TABLE IF NOT EXISTS "gsf_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    -- The feed serves nothing until the owner switches it on.
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    -- Shared-secret key carried in the feed URL's ?key= parameter. Generated in
    -- code on first read (crypto-random, not SQL), never guessed here: NULL means
    -- "not minted yet" and the route refuses to serve until it exists.
    "feed_token" TEXT,
    -- Brand written on every feed item that has no per-product brand of its own.
    "default_brand" TEXT,
    -- Google's condition attribute when a product does not say otherwise. A shop
    -- selling seconds can flip individual products via gsf_product_data.
    "default_condition" TEXT NOT NULL DEFAULT 'new',
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gsf_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "gsf_settings_singleton_check" CHECK ("id" = 'singleton')
);
INSERT INTO "gsf_settings" ("id") VALUES ('singleton') ON CONFLICT DO NOTHING;

-- Per-product Google fields. One row per parent (or standalone) product; variant
-- children inherit the parent's row, with each variant's own barcode supplying
-- its GTIN. Absent row means "defaults, included in the feed".
CREATE TABLE IF NOT EXISTS "gsf_product_data" (
    "product_id" TEXT NOT NULL,
    "brand" TEXT,
    "gtin" TEXT,
    "mpn" TEXT,
    -- A value from Google's published product taxonomy, either the numeric id or
    -- the full "A > B > C" path. Optional: Google auto-categorises without it.
    "google_product_category" TEXT,
    "condition" TEXT,
    -- Keeps this product (and every variation of it) out of the feed.
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gsf_product_data_pkey" PRIMARY KEY ("product_id"),
    CONSTRAINT "gsf_product_data_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "shp_products"("id") ON DELETE CASCADE
);
