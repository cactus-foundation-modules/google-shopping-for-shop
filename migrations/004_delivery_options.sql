-- Lets the feed carry the shop's own delivery services and their prices, rather
-- than leaving every listing to whatever the Merchant Center account says.
--
-- Off by default, and deliberately so: an item that carries its own shipping
-- groups OVERRIDES the account's rates for that item, so switching this on is
-- the owner taking the rates into their own hands. The country is the one the
-- prices apply to - a single market, which is what a shop with one delivery
-- table has. Idempotent so run-module-migrations can safely re-apply it.

ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "send_delivery_options" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "shipping_country" TEXT NOT NULL DEFAULT 'GB';
