-- Google Customer Reviews: the survey Google offers a shopper on the order
-- confirmation page, and the badge and seller rating that follow from it.
--
-- Off by default. Switching it on hands the customer's order confirmation email
-- address to Google so they can be surveyed after delivery, which is the
-- owner's decision to make and nobody else's.
--
-- The style is where the opt-in appears on the page; Google's own wording for
-- each position is kept verbatim, since it travels straight into their snippet.
-- The fallback days are what the delivery estimate falls back on when nothing
-- on the site publishes delivery timing - Google requires a date on every
-- opt-in and has no default of its own.
-- Idempotent so run-module-migrations can safely re-apply it.

ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "customer_reviews_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "customer_reviews_style" TEXT NOT NULL DEFAULT 'CENTER_DIALOG';
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "customer_reviews_delivery_days" INTEGER NOT NULL DEFAULT 5;
