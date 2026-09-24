-- Reports: Google's own figures for the feed, kept day by day.
--
-- Two things Google will tell us that nothing here has ever asked for:
--
--  1. product_performance_view - how many times each offer was shown, how
--     often it was clicked, and (on free listings only) what came of it. One
--     row per day, per offer, per marketing method. Landed in
--     gsf_performance_daily.
--
--  2. best_sellers_product_cluster_view / best_sellers_brand_view - what is
--     selling well in a category, whether or not this shop stocks it. Landed
--     in gsf_best_sellers.
--
-- Both are Google's figures rather than ours, they lag reality by about a day,
-- and Google revises the most recent few days after the fact. Everything below
-- is shaped around those three facts.
--
-- Idempotent throughout: the module migration runner may apply it again.

-- ---------------------------------------------------------------------------
-- Daily performance
-- ---------------------------------------------------------------------------

-- One row per (day, offer, marketing method), and NOTHING else in the key.
--
-- That is a deliberate limit on what is asked of Google. product_performance_view
-- has a dozen other segments - title, brand, category, customer country, store
-- type - and selecting ANY of them splits a day's clicks across its values.
-- Title is the trap: an offer whose title changed on the 4th comes back as two
-- rows for the 4th, and an upsert keyed on the day would keep one of them and
-- silently lose the other's clicks. So the query selects these three segments
-- and no others, Google aggregates over the rest, and the key below is exactly
-- the shape of what comes back. Titles are joined on from our own tables, which
-- know today's title rather than the one that was showing at the time.
CREATE TABLE IF NOT EXISTS "gsf_performance_daily" (
    -- The date in the MERCHANT CENTER ACCOUNT'S timezone, which is Google's
    -- choice and not ours - we are never told what it is. DATE rather than a
    -- timestamp because that is all Google gives, and pretending to a time of
    -- day would be inventing one. The import re-reads the last few days every
    -- run, so a day's worth of timezone offset corrects itself.
    "day" DATE NOT NULL,
    -- Google's offerId: the same id as gsf_item_match_status."item_id" and the
    -- feed's own item id.
    "item_id" TEXT NOT NULL,
    -- 'organic' | 'ads' | 'unknown', normalised from Google's MarketingMethod.
    -- Text rather than an enum so a method Google adds later is stored rather
    -- than refused. 'unknown' is Google saying UNSPECIFIED or saying nothing,
    -- never our guess.
    "marketing_method" TEXT NOT NULL,
    "clicks" BIGINT NOT NULL DEFAULT 0,
    "impressions" BIGINT NOT NULL DEFAULT 0,
    -- Google's own click-through rate for this row. Stored for the per-row
    -- display only: a rate is a ratio and MUST NOT be summed or averaged
    -- across rows. Every total on the Reports tab divides summed clicks by
    -- summed impressions instead.
    "click_through_rate" DOUBLE PRECISION,
    -- Conversions and their value are, per Google's own reference, "available
    -- only for the FREE traffic source" - so they arrive on ORGANIC rows and
    -- are NULL on ADS rows. NULL therefore means "Google does not report this
    -- here", which is a different thing from zero, and the screens say so
    -- rather than drawing a confident 0 nobody earned.
    "conversions" DOUBLE PRECISION,
    "conversion_value_micros" BIGINT,
    "conversion_currency" TEXT,
    -- When we wrote this row. A day re-read after Google revised it moves this
    -- and nothing else, which is how "these figures are still settling" can be
    -- told from "we have not looked since".
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gsf_performance_daily_pkey" PRIMARY KEY ("day", "item_id", "marketing_method")
);

-- The headline figures and the trend line: everything in a date range, summed
-- by method. The primary key already leads on "day", so this index exists for
-- the one query that does not - the per-product table, which wants one item
-- across a range.
CREATE INDEX IF NOT EXISTS "gsf_performance_daily_item_idx" ON "gsf_performance_daily" ("item_id", "day");

-- ---------------------------------------------------------------------------
-- Best sellers
-- ---------------------------------------------------------------------------

-- What Google says is selling, in the categories this shop trades in.
--
-- Note what is NOT here: an offer id. Google's best sellers report carries no
-- merchant offer id at all - it ranks product CLUSTERS (a grouping across every
-- retailer) and brands. The two honest ways to answer "do I sell this?" are
-- Google's own inventory_status, which says whether the cluster is in your
-- product data source, and the example GTINs, which can be matched against the
-- shop's own barcodes. Both are stored, and the screen says which of them
-- answered.
CREATE TABLE IF NOT EXISTS "gsf_best_sellers" (
    -- 'cluster' (a product) or 'brand'. Two Google tables, one shape, because
    -- every column below either applies to both or is NULL on one of them.
    "kind" TEXT NOT NULL,
    -- The first day of the week or month the ranking covers, per Google.
    "report_date" DATE NOT NULL,
    -- 'weekly' | 'monthly'.
    "granularity" TEXT NOT NULL,
    "country_code" TEXT NOT NULL,
    -- Google's numeric product category id the ranking was calculated for.
    -- Text because it is an identifier we compare and print, never count with.
    "category_id" TEXT NOT NULL,
    "rank" BIGINT NOT NULL,
    "previous_rank" BIGINT,
    -- The cluster's title, e.g. "Herman Miller Aeron Chair". NULL on a brand row.
    "title" TEXT,
    "brand" TEXT,
    -- "Furniture > Office Furniture > Office Chairs" - Google's own taxonomy
    -- trail for the cluster, assembled from category_l1..l5. NULL on a brand row.
    "category_path" TEXT,
    -- 'very-low' | 'low' | 'medium' | 'high' | 'very-high' | 'unknown'.
    "relative_demand" TEXT NOT NULL DEFAULT 'unknown',
    "previous_relative_demand" TEXT NOT NULL DEFAULT 'unknown',
    -- 'riser' | 'flat' | 'sinker' | 'unknown'.
    "demand_change" TEXT NOT NULL DEFAULT 'unknown',
    -- Google's answer to "is this in your product data source": 'in-stock' |
    -- 'out-of-stock' | 'not-in-inventory' | 'unknown'. Google notes this
    -- ignores the report's country filter.
    "inventory_status" TEXT NOT NULL DEFAULT 'unknown',
    "brand_inventory_status" TEXT NOT NULL DEFAULT 'unknown',
    -- ["5012345678900", ...] - Google's example variants for the cluster.
    -- jsonb because it is a list of Google's, not a shape of ours.
    "variant_gtins" JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- OUR answer, from matching those GTINs against the shop's own barcodes.
    -- NULL means we could not tell either way - a cluster Google gave no
    -- example GTINs for - which the screen shows as "not known" rather than as
    -- a confident no.
    "in_catalogue" BOOLEAN,
    -- The product the GTIN match landed on, so the row can link to it.
    "matched_product_id" TEXT,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gsf_best_sellers_pkey" PRIMARY KEY ("kind", "report_date", "granularity", "country_code", "category_id", "rank")
);

-- The tab reads the newest report it holds, in rank order.
CREATE INDEX IF NOT EXISTS "gsf_best_sellers_recent_idx" ON "gsf_best_sellers" ("kind", "report_date" DESC, "rank");

-- ---------------------------------------------------------------------------
-- Settings and bookkeeping
-- ---------------------------------------------------------------------------

-- Whether the daily check also reads the performance report. ON by default,
-- unlike almost everything else in this module, because it changes nothing:
-- it reads figures Google already holds, writes them to a table of our own,
-- and touches neither the feed nor the shop. A site with no Merchant Center
-- account linked never gets as far as making the call. Switching it off is
-- there for an owner who would rather not spend the API quota.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "performance_import_enabled" BOOLEAN NOT NULL DEFAULT true;

-- How far back the first import reaches. 90 days is a quarter, which is enough
-- to see a season without asking Google for years of history on day one.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "performance_backfill_days" INTEGER NOT NULL DEFAULT 90;

-- How long a day's figures are kept before the daily check drops them. 400
-- days is thirteen months, so last year's same-month comparison still exists.
-- 0 switches pruning off and keeps everything.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "performance_retention_days" INTEGER NOT NULL DEFAULT 400;

-- The last day that has been imported AND is old enough that Google has
-- stopped revising it. Days after this one are re-read on every run, because
-- Google attributes conversions to the day of the click days later and a day
-- read once would be permanently short. NULL means nothing has been imported,
-- which is where the backfill starts from.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "performance_imported_through" DATE;

-- When the import last SUCCEEDED. Null and a populated table together mean
-- the figures are from a version before this column existed; null and an empty
-- table mean nobody has ever asked, which the tab says rather than showing a
-- tidy zero.
--
-- Only ever moved by a run that finished. A run that died leaves this where it
-- was and writes the two columns below instead - otherwise the tab would say
-- "last fetched just now" about a fetch that never happened, which is the one
-- thing a screen like this must never do.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "performance_checked_at" TIMESTAMP(3);

-- When an import last FAILED, and what Google (or we) said about it.
--
-- Cleared by the next run that succeeds, so the pair means "the most recent
-- attempt failed" rather than "something went wrong once, years ago". The tab
-- reads them to say so plainly, and the daily check raises an alert on them
-- through the same machinery as the feed and delivery checks.
--
-- This matters more than it looks: the conversion-metric fallback only retries
-- ONCE and then rethrows, so a throw is the designed outcome for a Google
-- refusal nothing here recognises. Without these columns that outcome is a
-- console line on a server nobody reads and a screen claiming success.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "performance_failed_at" TIMESTAMP(3);
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "performance_last_error" TEXT;

-- Whether Google accepted conversions and conversion value in the query.
--
-- Their reference says both are free-listing-only, and it does not say what
-- happens to an account that cannot have them at all. So the import asks for
-- them, and if Google refuses the query IN TERMS THAT NAME THOSE FIELDS it
-- asks again without them and writes false here. NULL is "not tried yet"; the
-- tab uses this to explain an empty column instead of leaving an owner to
-- wonder.
--
-- This is NOT a one-way latch, and must never become one. The first contact
-- with a real Merchant Center account is also the first chance the conversion
-- query gets, and a refusal there can be a quota, a wobble or a transient
-- fault rather than a permanent answer. So false is re-tested: on every press
-- of "Fetch now" (that press IS the owner saying try again), and on the daily
-- check once the stamp below has gone stale.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "performance_conversions_available" BOOLEAN;

-- When the column above was last LEARNED - the last run that actually asked
-- Google for conversions and got an answer either way.
--
-- Without it, "Google turned this down" has no date on it and no expiry, and
-- the screen would go on saying so for ever off the back of one bad afternoon.
-- With it, the daily check asks again once the answer is a month old, and the
-- tab can say when the refusal happened rather than stating it as a standing
-- fact about the account.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "performance_conversions_checked_at" TIMESTAMP(3);

-- Best sellers is OFF by default, unlike the performance import above. It is a
-- second daily call, the report is not available to every account, and it
-- answers a question about the market rather than about this shop's own feed -
-- so it is worth switching on deliberately rather than by default.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "best_sellers_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Which Google product categories to rank, as numeric ids separated by commas.
-- Empty is Google's own default: rankings for every top-level category. The
-- Reports tab suggests the ids already typed against this shop's own
-- categories (gsf_category_taxonomy), which is usually the right answer.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "best_sellers_category_ids" TEXT;

-- 'WEEKLY' or 'MONTHLY' - Google's own words, because the value travels
-- verbatim into the query. Weekly is the more useful of the two for a shop
-- deciding what to stock next.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "best_sellers_granularity" TEXT NOT NULL DEFAULT 'WEEKLY';

-- How many ranked rows to keep per category, per kind. Google's list is long
-- and the interesting part is the top of it.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "best_sellers_limit" INTEGER NOT NULL DEFAULT 50;

ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "best_sellers_checked_at" TIMESTAMP(3);
