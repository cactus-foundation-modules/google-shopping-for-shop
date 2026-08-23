-- Adds the two facts needed to link a product straight through to its own page
-- in Merchant Center: the account the feed is filed under, and the feed label
-- Google files it against. Both blank until the owner fills them in, and the
-- product editor simply says so rather than offering a link that goes nowhere.
-- Idempotent so run-module-migrations can safely re-apply it.

ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "merchant_id" TEXT;
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "feed_label" TEXT;
