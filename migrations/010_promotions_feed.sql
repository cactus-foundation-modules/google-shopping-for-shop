-- The promotions data source.
--
-- A shop running the order-size deduction (shop's own feature: an amount folded
-- into the shelf price that stops being charged once a basket holds enough of
-- one supplier's goods) is already running a promotion. Google has a data source
-- for exactly that shape - money off, no code, a minimum spend - so the same
-- rule can be advertised on the listings rather than only discovered in the
-- basket.
--
-- Off by default, and deliberately so: this places an advertisement, and the
-- shape does not line up perfectly. Google's minimum spend is judged on the
-- whole basket; the shop's is judged on one supplier's goods. So a basket that
-- clears the figure across two suppliers meets Google's condition and not the
-- shop's, and the terms below are how the owner says so.
-- Idempotent so run-module-migrations can safely re-apply it.

ALTER TABLE "gsf_settings"
  ADD COLUMN IF NOT EXISTS "promotions_feed_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Extra wording appended to every promotion's terms. The condition itself is
-- worked out from the shop's own figures and always leads; this is whatever
-- else the owner needs to say. NULL is nothing to add.
ALTER TABLE "gsf_settings"
  ADD COLUMN IF NOT EXISTS "promotions_fine_print" TEXT;
