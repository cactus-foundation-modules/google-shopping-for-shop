-- Lets the module serve a second feed: the shop's own product reviews, in
-- Google's product review feed format, so the star ratings customers leave here
-- appear against the listings on Google.
--
-- Off by default and separate from the product feed's own switch: a shop can
-- perfectly reasonably want its products on Google without publishing what
-- people said about them, and switching this on is the owner deciding that
-- their reviews - names, wording and all - may be republished by Google.
-- Idempotent so run-module-migrations can safely re-apply it.

ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "reviews_feed_enabled" BOOLEAN NOT NULL DEFAULT false;
