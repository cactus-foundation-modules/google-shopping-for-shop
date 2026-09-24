-- Delivery sync: sending this site's own delivery charges to Merchant Center as
-- ACCOUNT-level shipping services, and keeping an eye on whether the two have
-- drifted apart since.
--
-- Nothing here is a new table. Every column is bookkeeping about one
-- conversation with Google, and the settings singleton is where the rest of
-- that conversation already lives (account number, data source, alert
-- thresholds). A table of its own would have exactly one row for ever.
--
-- Additive and idempotent: an install that already ran this gets nothing, and
-- an install that has never pushed anything reads every column as its default,
-- which is "we have not done this".

-- Where a product's delivery group comes from. 'attribute' is the behaviour
-- every install had before this migration: the value of whichever product
-- attribute the owner picked (shipping_label_attribute_id beside it).
-- 'delivery-services' takes it from the delivery rules instead - each product
-- labelled with the range, category or supplier group its delivery price is
-- actually written against. Default 'attribute', so nothing changes for anyone
-- until they choose it.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "shipping_label_source" TEXT NOT NULL DEFAULT 'attribute';

-- Whether the daily check compares this site's delivery charges with Merchant
-- Center's and raises an alert when they disagree. Off by default: it costs an
-- API call a day and it is only meaningful once the owner has pushed
-- something, so switching it on is their decision.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "delivery_sync_enabled" BOOLEAN NOT NULL DEFAULT false;

-- The Merchant Center shipping services this site last put there, by name.
--
-- This is what makes "leave everything else alone" possible. A service in the
-- account that is not in this list was made by somebody else and is copied back
-- untouched on every push. A service that IS in this list but no longer matches
-- a delivery service here was ours and has been retired, so it goes.
--
-- Names rather than ids because Merchant Center has no id for a shipping
-- service: serviceName is the identity, and it is unique within an account.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "delivery_managed_services" JSONB NOT NULL DEFAULT '[]'::jsonb;

-- When the comparison last ran, and what it found. Null means it has never
-- run, which is NOT the same as "they agree" - the Delivery tab draws the two
-- apart rather than showing a reassuring zero nobody earned.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "delivery_checked_at" TIMESTAMP(3);
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "delivery_differences" INTEGER;

-- The last comparison in full, so opening the tab shows something without
-- ringing Google first. Shaped by lib/delivery/diff.ts and read back by it
-- alone; stale by definition, and always shown with the time it was taken.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "delivery_last_diff" JSONB;

-- When we last sent anything. For the tab's own "last sent" line, and so a
-- comparison that has never had a push behind it can say so.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "delivery_pushed_at" TIMESTAMP(3);
