-- Lets the feed take a product's brand from the supplier the shop already files
-- it under (shp_products.supplier) before falling back to the shop-wide default.
-- On by default: a shop that names a supplier per product almost always means
-- the maker, and a blank supplier still falls through to the default brand.
-- Idempotent so run-module-migrations can safely re-apply it.

ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "brand_from_supplier" BOOLEAN NOT NULL DEFAULT true;
