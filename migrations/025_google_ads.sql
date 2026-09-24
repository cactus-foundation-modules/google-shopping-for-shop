-- Google Ads: what the paid half of Google Shopping costs, and telling Google
-- Ads which of those clicks turned into a sale.
--
-- Everything before this file is Merchant Center. Google Ads is a DIFFERENT
-- API, on a different host, with a different sign-in (an OAuth refresh token
-- rather than the service-account key), a version number in the URL path and
-- its own error envelope. The tables below are the only thing the two halves
-- share a database with.
--
--   gsf_ads_performance_daily   what each item cost, day by day, from Google
--                               Ads' own shopping_performance_view.
--   gsf_ads_conversion_uploads  one row per order we have told Google Ads
--                               about, so we never tell it twice.
--   gsf_ads_run                 one row, for ever: the brake that stops two
--                               uploads overlapping, and the status stamp for
--                               the last upload and the last spend fetch.
--
-- NOTHING HERE HAS BEEN RUN AGAINST A REAL GOOGLE ADS ACCOUNT. There is no
-- access to one on the machine this was written on. Every field name, enum and
-- REST path was checked against Google's own published reference and its
-- .proto definitions for v25 rather than remembered.
--
-- Idempotent throughout: the module migration runner may apply it again.

-- ---------------------------------------------------------------------------
-- What the ads cost
-- ---------------------------------------------------------------------------

-- One row per (day, item). Deliberately no campaign, no ad group, no product
-- title: every extra segment splits a day's spend across its values, and this
-- table answers one question - what did this item cost - not twelve.
--
-- Kept APART from gsf_performance_daily rather than added to it. That table is
-- Merchant Center's count of free and paid clicks and carries no money at all;
-- this one is Google Ads' count of the paid half and carries nothing else. They
-- disagree by nature (different products, different attribution, different
-- publishing lag) and a single table would have to pretend they did not.
CREATE TABLE IF NOT EXISTS "gsf_ads_performance_daily" (
    -- The date in the GOOGLE ADS ACCOUNT'S timezone, which Google chooses. The
    -- import re-reads the last few days every run, so the offset settles.
    "day" DATE NOT NULL,
    -- Google's `segments.product_item_id`.
    --
    -- STORED EXACTLY AS GOOGLE SENT IT, and Google sends it LOWER CASE even for
    -- an item whose id in Merchant Center has capitals in it. So this column
    -- must never be joined to one of ours with a plain `=`: every join and
    -- every lookup goes through lower() on both sides, and the index below is
    -- on lower() for that reason. Getting this wrong does not throw - it
    -- quietly matches nothing, and the spend column reads as zero.
    "item_id" TEXT NOT NULL,
    -- Google sends money as a whole number of millionths of the account's
    -- currency unit. BIGINT, never a float: a rounding error here is money.
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "clicks" BIGINT NOT NULL DEFAULT 0,
    "impressions" BIGINT NOT NULL DEFAULT 0,
    -- Google Ads' OWN conversion count for the item, which is whatever that
    -- account's conversion tracking says - the browser tag, our uploads, or
    -- both. It is NOT this site's attributed-sale count and is never added to
    -- one. NULL means Google reported nothing, which is not zero.
    "conversions" DOUBLE PRECISION,
    "conversions_value" DOUBLE PRECISION,
    -- The account's currency, as Google reported it for the run. Stored per row
    -- so a change of account currency does not silently restate history.
    "currency" TEXT,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gsf_ads_performance_daily_pkey" PRIMARY KEY ("day", "item_id")
);

-- The per-item totals, and the join to our own figures. lower() because of the
-- casing note above.
CREATE INDEX IF NOT EXISTS "gsf_ads_performance_daily_item_idx"
    ON "gsf_ads_performance_daily" (lower("item_id"), "day");

-- ---------------------------------------------------------------------------
-- What we have told Google Ads about
-- ---------------------------------------------------------------------------

-- One row per ORDER, written only when an upload was actually attempted.
--
-- The order id is the key because that is also what Google dedupes on: a
-- ClickConversion's `order_id` "can only be used for one conversion per
-- conversion action". So there are two guards against telling Google the same
-- sale twice - this table, and Google's own - and they agree by construction.
--
-- What is NOT here, on purpose: the Google click identifier. It lives in
-- gsf_click_events, where withdrawing marketing consent erases it, and it is
-- read from there at the moment of the upload and never copied. A copy here
-- would survive that erasure, which is the whole thing stage 5 promised would
-- not happen.
CREATE TABLE IF NOT EXISTS "gsf_ads_conversion_uploads" (
    "order_id" TEXT NOT NULL,
    -- Printed on every screen; never the proof of anything.
    "order_number" TEXT NOT NULL,
    -- The landing this sale was credited to. NULLABLE and set to NULL when the
    -- shopper withdraws consent - along with click_id_kind below, which says
    -- the same thing one field smaller. The row then records only that we have
    -- already told Google about this order, which is what stops a second
    -- upload, and no longer records whose visit it came from.
    "click_event_id" TEXT,
    -- 'uploaded'  Google took it.
    -- 'refused'   Google said no. Retried, up to a cap, by the next run.
    -- 'skipped'   we decided not to send it, and the reason is in last_error.
    --             Never retried: the reason will not change on its own.
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "uploaded_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    -- Google's own sentence, or ours. Cut to a line before it is written.
    "last_error" TEXT,
    -- Google's error code for the last refusal, e.g. CLICK_NOT_FOUND or
    -- CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE. Kept apart from the sentence
    -- because the screen has to be able to tell a refusal about ONE click from
    -- a refusal about the whole account.
    "error_code" TEXT,
    -- The conversion action we sent it against, in full. An account can have
    -- several, and an owner who changes the setting should be able to see which
    -- of them a given sale went to.
    "conversion_action" TEXT,
    -- Exactly the string we sent as `conversionDateTime`, offset and all.
    "conversion_date_time" TEXT,
    "value" NUMERIC(12,2),
    "currency" TEXT,
    -- 'gclid', 'gbraid' or 'wbraid'. Never 'srsltid': that is not a Google Ads
    -- click identifier, it is appended to free listings as well, and stage 5
    -- already counts it as a free click. Cleared with click_event_id above when
    -- consent is withdrawn: on its own it still says "this order came from a
    -- Google ad click", which is the claim being erased.
    "click_id_kind" TEXT,
    CONSTRAINT "gsf_ads_conversion_uploads_pkey" PRIMARY KEY ("order_id"),
    CONSTRAINT "gsf_ads_conversion_uploads_order_id_fkey"
        FOREIGN KEY ("order_id") REFERENCES "shp_orders"("id") ON DELETE CASCADE,
    -- SET NULL rather than CASCADE: a landing pruned past its retention must
    -- not take with it the record that Google has already been told, because
    -- losing that would upload the same sale a second time.
    CONSTRAINT "gsf_ads_conversion_uploads_click_event_id_fkey"
        FOREIGN KEY ("click_event_id") REFERENCES "gsf_click_events"("id") ON DELETE SET NULL
);

-- The retry sweep: refusals, oldest first.
CREATE INDEX IF NOT EXISTS "gsf_ads_conversion_uploads_status_idx"
    ON "gsf_ads_conversion_uploads" ("status", "failed_at");

-- The Health panel's recent list.
CREATE INDEX IF NOT EXISTS "gsf_ads_conversion_uploads_uploaded_idx"
    ON "gsf_ads_conversion_uploads" ("uploaded_at" DESC);

-- "Has this landing already been reported?" - asked when a landing is erased.
CREATE INDEX IF NOT EXISTS "gsf_ads_conversion_uploads_click_idx"
    ON "gsf_ads_conversion_uploads" ("click_event_id")
    WHERE "click_event_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The run: one row, both brake and status stamp
-- ---------------------------------------------------------------------------

-- Same shape, and the same reasoning, as gsf_push_run in migration 024: a claim
-- has to be a row in the database because every serverless invocation is its
-- own process, and a flag in one of them stops none of the others.
CREATE TABLE IF NOT EXISTS "gsf_ads_run" (
    "id" TEXT NOT NULL,

    -- The conversion upload ------------------------------------------------
    "claimed_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    -- Only ever moved by a run that reached the end. A screen reading these two
    -- together can say "started, never came back" rather than "done".
    "finished_at" TIMESTAMP(3),
    -- 'ok', 'part', 'failed', or NULL for never run.
    "status" TEXT,
    "uploaded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    -- The daily spend fetch --------------------------------------------------
    -- Kept here beside the upload rather than in gsf_settings: it is
    -- bookkeeping about a job, and the settings row is read on every feed
    -- build.
    "spend_checked_at" TIMESTAMP(3),
    -- Set ONLY when a fetch failed, and cleared by the next one that works. A
    -- failed fetch never moves spend_checked_at, so no screen can report a
    -- fetch that did not happen.
    "spend_failed_at" TIMESTAMP(3),
    "spend_last_error" TEXT,
    -- The cursor: every day up to and including this one has been fetched.
    "spend_imported_through" DATE,

    CONSTRAINT "gsf_ads_run_pkey" PRIMARY KEY ("id")
);

INSERT INTO "gsf_ads_run" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

-- The master switch for anything Google Ads. OFF by default and it stays off:
-- it reads somebody's advertising account and, with the switch below, writes to
-- it, and neither is something a core update may start doing on its own.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "ads_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Fetch what the ads cost, day by day. Read-only at Google's end.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "ads_spend_import_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "ads_spend_backfill_days" INTEGER NOT NULL DEFAULT 90;
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "ads_spend_retention_days" INTEGER NOT NULL DEFAULT 400;

-- Send Google Ads the sales this site attributed to a paid click.
--
-- OFF by default, separately from the master switch above, because it is the
-- only thing in this module that writes to an advertising account. Switching it
-- on also needs the conversion action below to have been set up, which is its
-- own deliberate step with its own button.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "ads_conversion_upload_enabled" BOOLEAN NOT NULL DEFAULT false;

-- The conversion action we upload against, as Google's own resource name
-- (customers/{customer}/conversionActions/{id}). NULL means not set up, which
-- is what stops anything being sent.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "ads_conversion_action" TEXT;
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "ads_conversion_action_name" TEXT;

-- Whether Google says that action is PRIMARY.
--
-- This is the single most important column in the file. The google-tag module
-- already reports Google Ads conversions from the shopper's browser, and if
-- this action were primary too, every sale that came from an ad would be
-- counted twice and the account would bid on the doubled figure. So the action
-- is created with primary_for_goal = false (Google's word for "secondary", and
-- non-biddable), this column records what Google said when we last READ it
-- back, and the upload REFUSES to send anything while it is true or unknown.
-- A screen may not assert this from our own intention; only from Google's
-- answer.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "ads_conversion_action_primary" BOOLEAN;
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "ads_conversion_action_checked_at" TIMESTAMP(3);

-- The Google Ads account's own currency and timezone, as learned from Google
-- rather than assumed. The currency is what cost_micros is denominated in; the
-- timezone is what `day` above is measured in, and saying so on screen is the
-- difference between a figure an owner trusts and one they argue with.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "ads_currency" TEXT;
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "ads_time_zone" TEXT;
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "ads_account_checked_at" TIMESTAMP(3);
