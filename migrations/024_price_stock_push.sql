-- Live price and stock updates: sending a changed price or availability to
-- Merchant Center now, rather than waiting for Google to come and read the feed.
--
-- Google fetches a feed on its own schedule - typically once a day, and never
-- at the moment a shop drops a price or sells its last one. Everything up to
-- here has been about what that feed SAYS; this is the first thing in the
-- module that speaks to Google unprompted, and the tables below are what make
-- that safe to do:
--
--   gsf_push_queue  what has changed and not yet been sent. Written by a shop
--                   signal (shop.product-saved), drained by the worker. One row
--                   per product, so a product edited ten times in a minute is
--                   sent once.
--   gsf_push_state  what we BELIEVE Google now holds for each item, as we sent
--                   it. The hourly reconcile compares a sample of this against
--                   what Google actually holds, because "we sent it" and "it
--                   arrived" are not the same claim.
--   gsf_push_run    one row, for ever. It is both the status stamp for the last
--                   run and the brake that stops two of them overlapping: a
--                   claim is an UPDATE with a condition, not a variable in a
--                   process, because on serverless there is no such thing as
--                   "the process" - the next request may be a different machine.
--
-- Nothing here stores a price the shop does not already store, and nothing here
-- is a second source of truth for what is in the feed: the feed build remains
-- the authority on what is sent and what is held back.
--
-- Idempotent throughout: the module migration runner may apply it again.

-- ---------------------------------------------------------------------------
-- The queue
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "gsf_push_queue" (
    -- The shop's product id. A variation parent as well as a child: a parent's
    -- price change moves every variation's price with it, so the worker expands
    -- a parent into its own feed rows when it runs.
    "product_id" TEXT NOT NULL,
    "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- What moved, in the shop's own field names ('price', 'stockCount', ...).
    -- Display only; the worker sends whatever the feed now says regardless.
    "reason" TEXT NOT NULL DEFAULT '',
    -- Bumped rather than a second row, so a burst of edits is one send.
    "queued_count" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "gsf_push_queue_pkey" PRIMARY KEY ("product_id")
);

-- The worker drains oldest first, so nothing can be starved by a product that
-- keeps being edited.
CREATE INDEX IF NOT EXISTS "gsf_push_queue_queued_at_idx" ON "gsf_push_queue" ("queued_at");

-- ---------------------------------------------------------------------------
-- What we believe we sent
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "gsf_push_state" (
    -- The FEED item id - the offer id Google knows the item by, which for a
    -- variation is the child product's id. Not the queue's product id.
    "item_id" TEXT NOT NULL,
    -- The listing this item belongs to: the variation PARENT's product id, or
    -- the item's own id on a product with no variations. It is what the queue
    -- holds, and without it a queued parent that has left the feed could not be
    -- matched to the child rows we are keeping up to date for it - so its
    -- entries would sit at Merchant Center until the hourly sweep noticed.
    "parent_id" TEXT NOT NULL DEFAULT '',
    -- Gross, major units, exactly as the feed renders it. NUMERIC rather than a
    -- float: a penny lost to binary rounding here would read as a difference on
    -- every reconcile for ever.
    "price" NUMERIC(12,2) NOT NULL,
    "sale_price" NUMERIC(12,2),
    "currency" TEXT NOT NULL,
    -- Google's own enum: IN_STOCK, OUT_OF_STOCK, PREORDER, BACKORDER. The feed
    -- XML spells the same idea in lower case; storing Google's spelling means
    -- the reconcile compares like with like rather than translating twice.
    "availability" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- False when the send happened but Google's reply could not be read back.
    -- NOT a failure, and never reported as a success either.
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    -- Google's own sentence about the last refusal, or ours. Null once a later
    -- send has gone through.
    "last_error" TEXT,
    "failed_at" TIMESTAMP(3),
    -- The hourly sample check: when it last looked, and what it found.
    -- 'agrees', 'differs', or NULL for never looked.
    "reconciled_at" TIMESTAMP(3),
    "reconcile_result" TEXT,
    -- What Google said it held, when that differed from the row above. Kept so
    -- the screen can show both sides rather than asserting a disagreement.
    "reconcile_detail" JSONB,
    CONSTRAINT "gsf_push_state_pkey" PRIMARY KEY ("item_id")
);

-- The reconcile samples least-recently-checked first, nulls ahead of the rest.
CREATE INDEX IF NOT EXISTS "gsf_push_state_reconciled_at_idx" ON "gsf_push_state" ("reconciled_at" ASC NULLS FIRST, "sent_at" ASC);

-- The Health panel counts failures and disagreements.
CREATE INDEX IF NOT EXISTS "gsf_push_state_failed_at_idx" ON "gsf_push_state" ("failed_at") WHERE "failed_at" IS NOT NULL;

-- Belt and braces for `parent_id`. It is declared inside the CREATE TABLE
-- above, which does nothing at all on a database that already has the table -
-- so a database provisioned from an earlier draft of THIS file would never get
-- the column and the runner would never re-apply the file to give it one. No
-- such database exists (024 has never been on any ref), and this costs one
-- no-op statement to make sure none ever can.
ALTER TABLE "gsf_push_state" ADD COLUMN IF NOT EXISTS "parent_id" TEXT NOT NULL DEFAULT '';

-- A queued listing finds the rows it owns.
CREATE INDEX IF NOT EXISTS "gsf_push_state_parent_id_idx" ON "gsf_push_state" ("parent_id");

-- ---------------------------------------------------------------------------
-- The run: one row, both brake and status stamp
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "gsf_push_run" (
    "id" TEXT NOT NULL,
    -- Set when a run claims the slot, cleared when it lets go. A run that dies
    -- mid-flight leaves this set, which is why the claim also gives up on
    -- anything older than the stale window rather than waiting for ever.
    "claimed_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    -- Only ever moved by a run that actually FINISHED. A screen reading these
    -- two together can say "started, never came back" rather than "done".
    "finished_at" TIMESTAMP(3),
    -- 'ok', 'failed', 'part' (some items sent, some refused), or NULL.
    "status" TEXT,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    -- Items taken back out of the supplemental source because the feed no
    -- longer carries them.
    "removed" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    -- The hourly sample check's own stamp, kept here beside the run it travels
    -- with rather than in the settings row the feed build reads.
    "reconciled_at" TIMESTAMP(3),
    "reconcile_checked" INTEGER NOT NULL DEFAULT 0,
    "reconcile_differs" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "gsf_push_run_pkey" PRIMARY KEY ("id")
);

INSERT INTO "gsf_push_run" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

-- Send price and availability changes to Merchant Center as they happen.
--
-- OFF by default and it stays off: it writes to somebody's advertising account,
-- which is not something an update may start doing on its own. Switching it on
-- also needs the supplemental data source below to have been set up, which is
-- its own deliberate step.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "price_push_enabled" BOOLEAN NOT NULL DEFAULT false;

-- The supplemental data source this module created to send into. Merchant
-- Center merges a supplemental source over the primary feed, so what goes here
-- overrides the fetched feed's price and availability and touches nothing else.
-- Null means it has not been set up yet, which is what stops anything sending.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "push_data_source_id" TEXT;

-- The primary data sources it has been linked into, by id. A supplemental
-- source that is not linked into a primary one is accepted by Google and then
-- ignored entirely, so "created" and "working" are two different states and the
-- screen has to be able to tell them apart.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "push_linked_source_ids" JSONB;
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "push_linked_at" TIMESTAMP(3);

-- The shortest gap between two runs. A save queues its product and then kicks
-- the worker; the kick only becomes a run if this many seconds have passed
-- since the last one started. So a bulk edit of five hundred products is one
-- run and not five hundred, and a single price change still goes within a
-- second or two.
--
-- It is a real cost as well as a nicety: each run rebuilds the feed to find out
-- what the new price and availability actually are, which is the only honest
-- way to respect the feed rules. Two minutes is the default; the hourly run
-- re-sends anything whose figures have drifted from what we last sent, queued
-- or not, so nothing depends on a kick having happened.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "push_debounce_seconds" INTEGER NOT NULL DEFAULT 120;

-- How many items the hourly reconcile asks Google about. One API call each, so
-- this is a quota decision: twenty an hour is about five hundred a day, which
-- walks a catalogue of any size in a week or two.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "push_reconcile_sample" INTEGER NOT NULL DEFAULT 20;

-- The two-letter language Google files this shop's products under.
--
-- It sits beside the feed label because the two are halves of the same thing: a
-- product's identity at Google is offer id + content language + feed label, and
-- getting either wrong files everything sent against a product no feed
-- publishes - which Google accepts without a word of complaint. 'en' is right
-- for every install today (every page of the platform renders in English), but
-- it belongs in the settings row rather than hardcoded in four files, and the
-- setup check now refuses when it disagrees with the main feed's own.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "content_language" TEXT NOT NULL DEFAULT 'en';
