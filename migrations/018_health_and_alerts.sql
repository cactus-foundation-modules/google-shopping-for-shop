-- Health: what Google is unhappy about, and whether it can read the feed at all.
--
-- Three things land here:
--
--  1. gsf_item_issues - the item issues Google reports against each offer in
--     the product_view report. A row is opened the first time an issue is
--     seen and CLOSED (resolved_at) when it stops coming back, never deleted
--     on sight: "this went away on the 4th" is the useful half of the story,
--     and a delete throws it away.
--
--  2. gsf_feed_fetch_status - the state of Google's last fetch of the feed,
--     read from the Merchant API data source's latest file upload. One row
--     per data source, because an account may carry several and the owner may
--     point us at a different one later.
--
--  3. Settings for the two alerts and the optional email, plus somewhere to
--     remember which data source is ours.
--
-- Idempotent throughout: the module migration runner may apply it again.

-- One row per (item, issue code, attribute). Keyed by those three rather than
-- by a generated id, so a second sighting of the same issue updates the row it
-- already has instead of stacking duplicates - and so the backup carries no
-- sequence. `attribute` is '' rather than NULL for exactly that reason: a NULL
-- in a primary key is not allowed, and "no particular attribute" is a real
-- answer Google gives often.
CREATE TABLE IF NOT EXISTS "gsf_item_issues" (
    -- The feed item id (Google's offerId), matching gsf_item_match_status.
    "item_id" TEXT NOT NULL,
    -- Google's own error code, e.g. 'image_link_broken'. Their word for it,
    -- kept verbatim: it is the only thing that joins this row to Google's own
    -- documentation and to next week's report.
    "code" TEXT NOT NULL,
    -- The attribute the issue is about, as Google canonicalises it (e.g.
    -- 'n:brand'), or '' where the issue is not about one field.
    "attribute" TEXT NOT NULL DEFAULT '',
    -- 'disapproved' | 'demoted' | 'pending' | 'unknown', normalised from
    -- Google's AggregatedIssueSeverity. Text rather than an enum so a severity
    -- Google adds later is stored rather than refused.
    "severity" TEXT NOT NULL,
    -- 'merchant_action' | 'pending_processing' | 'unknown': whether this is
    -- ours to fix or Google's to finish thinking about.
    "resolution" TEXT NOT NULL DEFAULT 'unknown',
    -- Google's product_view report gives a code and an attribute, and NOT a
    -- sentence or a help link.
    --
    -- The fuller wording does exist - accounts.products carries
    -- ProductStatus.itemLevelIssues with description, detail, documentation,
    -- resolution and applicable countries - but that is one API call PER
    -- PRODUCT, far too many to make for a whole catalogue.
    --
    -- So they are filled in ONE ITEM AT A TIME, when an owner presses
    -- "Explain this" on the Health tab (lib/health/explain.ts). Never in
    -- bulk, never on page load, never in the cron. NULL here means nobody has
    -- asked about that row yet; migration 020 adds `detail` and the
    -- `explained_at` stamp that decides when a cached answer has gone stale.
    "description" TEXT,
    "documentation_url" TEXT,
    -- [{ "context": "SHOPPING_ADS", "disapprovedCountries": ["GB"], "demotedCountries": [] }, ...]
    -- jsonb because it is Google's shape, not ours, and a new field there
    -- should not be a migration here.
    "contexts" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Set when the issue stopped being reported. NULL is "still open".
    "resolved_at" TIMESTAMP(3),
    CONSTRAINT "gsf_item_issues_pkey" PRIMARY KEY ("item_id", "code", "attribute")
);

-- The Health tab's three questions: how many are open, which codes are worst,
-- and what is wrong with this one item.
CREATE INDEX IF NOT EXISTS "gsf_item_issues_open_idx" ON "gsf_item_issues" ("severity") WHERE "resolved_at" IS NULL;
CREATE INDEX IF NOT EXISTS "gsf_item_issues_code_idx" ON "gsf_item_issues" ("code") WHERE "resolved_at" IS NULL;
CREATE INDEX IF NOT EXISTS "gsf_item_issues_item_idx" ON "gsf_item_issues" ("item_id");

-- Google's overall verdict on one item, aggregated across every reporting
-- context: 'eligible' | 'limited' | 'pending' | 'not-eligible' | 'unknown'.
-- It lives beside the match snapshot because it arrives in the same report and
-- is read by the same screen. NULL means the column existed before the item's
-- last refresh, which is not the same as 'unknown' from Google - and the
-- workbench draws the two the same way, as "no word yet".
ALTER TABLE "gsf_item_match_status" ADD COLUMN IF NOT EXISTS "reporting_status" TEXT;

-- The last fetch Google made of one data source. One row per data source id.
CREATE TABLE IF NOT EXISTS "gsf_feed_fetch_status" (
    -- Google's own data source id (int64 in their API, text here: it is an
    -- identifier we only ever compare and print, never count with).
    "data_source_id" TEXT NOT NULL,
    "display_name" TEXT,
    -- The URL Google says it fetches, WITH ITS QUERY STRING REMOVED - host and
    -- path only. The address we give Google carries the feed's secret key as a
    -- query parameter, and the Health tab that shows this is gated on
    -- shop.products while the feed address itself needs shop.manage. Host and
    -- path are all the owner needs to see that Google is reading the right
    -- address. Stripped in lib/health/parse.ts (fetchUriForDisplay), before
    -- the write and again on the read.
    "fetch_uri" TEXT,
    -- 'succeeded' | 'failed' | 'in_progress' | 'unknown', normalised from
    -- Google's ProcessingState.
    "processing_state" TEXT NOT NULL,
    "items_total" BIGINT,
    "items_created" BIGINT,
    "items_updated" BIGINT,
    -- [{ "title": ..., "description": ..., "code": ..., "count": 12,
    --    "severity": "error" | "warning" | "unknown", "documentationUri": ... }, ...]
    "issues" JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- When Google fetched it, as Google reports. NULL when it never has.
    "uploaded_at" TIMESTAMP(3),
    -- When WE last asked. The two are different questions and the screen asks
    -- both: a fetch from eight days ago read an hour ago is a real answer.
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gsf_feed_fetch_status_pkey" PRIMARY KEY ("data_source_id")
);

-- The data source the owner says is ours, typed in by hand. NULL is "work it
-- out", which is the default.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "feed_data_source_id" TEXT;

-- The one we found ourselves by matching Google's fetch URL against the feed
-- address. Cached so the discovery - a full list of the account's data sources
-- - runs once rather than daily. Kept apart from the column above so a
-- discovery can never quietly overwrite what the owner typed.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "feed_data_source_detected_id" TEXT;

-- How many products may newly stop being shown between one check and the next
-- before the site says something. 0 switches the alert off. 25 is a figure
-- that a mis-set price band or a broken image host clears easily, and that a
-- handful of ordinary edits does not.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "disapproval_alert_threshold" INTEGER NOT NULL DEFAULT 25;

-- Where to email a health alert. Off by default and NULL by default: an email
-- nobody asked for, to an address nobody confirmed, is not a feature.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "alert_email_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "alert_email" TEXT;

-- When item issues were last read from Google. Without it, "no issues" and
-- "never asked" are the same empty table, and only one of those is good news.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "issues_checked_at" TIMESTAMP(3);

-- How many items were disapproved at the previous check, so a spike can be
-- measured against something. NULL means there has been no previous check.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "last_disapproved_count" INTEGER;
