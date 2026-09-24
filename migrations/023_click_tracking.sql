-- Live click tracking: what this site saw for itself when Google sent somebody.
--
-- Everything in migration 022 is GOOGLE'S count of what happened, published
-- about a day late and revised afterwards. This is the shop's own count of the
-- same thing, and the two will never agree exactly - Google counts a click when
-- it hands the visitor over, this counts a landing when the page actually
-- loaded, and every blocked script, abandoned redirect and back button in
-- between is a difference. Both numbers are kept and the screen says which is
-- which, because an owner shown one figure with no context distrusts it the
-- first time it disagrees with Merchant Center.
--
-- The privacy shape, which is the load-bearing part:
--
--   * A landing is recorded for EVERYONE. It carries no click id, no IP
--     address, no cookie and no persistent identifier of any kind - just which
--     product, when, and whether it came from a free listing or a paid one.
--   * The session key is a keyed hash that rotates every day (see
--     lib/click-tracking/visitor.ts). It exists to stop one visitor's refresh
--     counting ten times, and it cannot be turned back into an address or
--     joined to yesterday's rows.
--   * A click id, and the cookie that links a landing to a sale, are written
--     ONLY for a visitor who has granted the marketing consent category. No
--     grant, no link: the landing still counts, the sale simply is not joined
--     to it.
--
-- Idempotent throughout: the module migration runner may apply it again.

-- ---------------------------------------------------------------------------
-- Landings
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "gsf_click_events" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "landed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- The listing the visitor landed on. The PARENT product, always, so a
    -- shop's figures are per listing however many combinations it sells.
    "product_id" TEXT NOT NULL,
    -- The one combination the address named, where it named one. Null on a
    -- product with no variations and on a bare listing address.
    "variant_id" TEXT,
    -- 'free' or 'paid'. Any Google click identifier means paid, because only
    -- an ad carries one; our own feed tag alone means free. Both together are
    -- paid - the click id is the stronger evidence, and Google appends it to
    -- the address our feed already tagged.
    "source" TEXT NOT NULL,
    -- Google's own identifier for the click (gclid, gbraid, wbraid, srsltid).
    -- Stored ONLY with marketing consent, because it is exactly the thing that
    -- can be handed back to Google to identify the person. Null otherwise, and
    -- null is the overwhelming majority.
    "click_id" TEXT,
    -- Which parameter it came out of, so stage 7 knows what it may upload.
    "click_id_kind" TEXT,
    -- A keyed hash of the request, rotated daily, never reversible and never
    -- an address. Dedupe only.
    "session_key" TEXT NOT NULL,
    -- The 30-day first-party cookie that joins this landing to a later sale.
    -- Null without marketing consent, which is what makes the row anonymous.
    "attribution_id" TEXT,
    -- What was relied on, recorded with the row rather than assumed, so the
    -- answer to "why do you hold this?" lives in the data.
    "consented" BOOLEAN NOT NULL DEFAULT false,
    -- floor(epoch / 1800) at the moment of the insert: the half-hour this
    -- landing falls in. It exists for the unique index below and nothing else.
    --
    -- Dedupe is done twice on purpose. The insert asks for no landing by this
    -- session on this product in the last thirty minutes, which is the rule an
    -- owner would describe; two requests arriving at the same instant can both
    -- pass that test, and the unique index catches the pair. Together they give
    -- a sliding window in the ordinary case and a hard ceiling in the racing
    -- one.
    "dedupe_bucket" BIGINT NOT NULL,
    CONSTRAINT "gsf_click_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "gsf_click_events_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "shp_products"("id") ON DELETE CASCADE,
    CONSTRAINT "gsf_click_events_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "shp_products"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "gsf_click_events_dedupe_key"
    ON "gsf_click_events" ("session_key", "product_id", "dedupe_bucket");

-- The live feed: the most recent landings, newest first.
CREATE INDEX IF NOT EXISTS "gsf_click_events_landed_idx" ON "gsf_click_events" ("landed_at" DESC);

-- The headline figures, which count by source over a date range.
CREATE INDEX IF NOT EXISTS "gsf_click_events_source_idx" ON "gsf_click_events" ("source", "landed_at" DESC);

-- "What did this visitor last land on?" - asked once per sale, and only for a
-- visitor carrying the cookie, so the index is partial.
CREATE INDEX IF NOT EXISTS "gsf_click_events_attribution_idx"
    ON "gsf_click_events" ("attribution_id", "landed_at" DESC)
    WHERE "attribution_id" IS NOT NULL;

-- The per-product totals on the Reports tab.
CREATE INDEX IF NOT EXISTS "gsf_click_events_product_idx" ON "gsf_click_events" ("product_id", "landed_at" DESC);

-- ---------------------------------------------------------------------------
-- Sales joined back to a landing
-- ---------------------------------------------------------------------------

-- One row per order, at most. The order is the key rather than the click,
-- because "last click wins" means an order has exactly one landing to its name
-- however many times the shopper came back.
--
-- Written in two steps, and either may be first. The confirmation page says a
-- sale happened as soon as the shopper sees it; `shop.order-paid` fires once
-- when the money actually lands, which on a bank transfer can be days later and
-- on a card is usually a moment BEFORE the page settles. So the first of the
-- two to arrive creates the row and the second fills in what it knows, and
-- neither is allowed to assume it went first.
CREATE TABLE IF NOT EXISTS "gsf_attributed_orders" (
    "order_id" TEXT NOT NULL,
    -- Carried alongside the id because every screen prints it and the join to
    -- fetch it would be a second query on a table this one already has a row
    -- from. Never the proof of anything: order numbers are a prefix and a
    -- sequence.
    "order_number" TEXT NOT NULL,
    -- The landing this sale is credited to. Cascades, so pruning a landing
    -- past its retention takes the attribution with it - an attribution whose
    -- click has been forgotten is a claim nothing can support.
    "click_event_id" TEXT NOT NULL,
    "attributed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- When the money was confirmed by the shop itself, through the
    -- `shop.order-paid` observer. Null means the shopper reached the
    -- confirmation page but nothing has told us the payment settled, which the
    -- screen shows as pending rather than as revenue.
    "confirmed_at" TIMESTAMP(3),
    -- The order total, read from the shop's own row and NEVER from anything the
    -- browser posted. Null until confirmed.
    "order_value" DECIMAL(12,2),
    "currency" TEXT,
    -- Landing to order, in seconds. Stored rather than derived so the order
    -- view still has it once the range being looked at has moved on.
    "seconds_to_purchase" BIGINT,
    CONSTRAINT "gsf_attributed_orders_pkey" PRIMARY KEY ("order_id"),
    CONSTRAINT "gsf_attributed_orders_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "shp_orders"("id") ON DELETE CASCADE,
    CONSTRAINT "gsf_attributed_orders_click_event_id_fkey" FOREIGN KEY ("click_event_id") REFERENCES "gsf_click_events"("id") ON DELETE CASCADE
);

-- The live feed marks a landing that converted, so it asks the other way round.
CREATE INDEX IF NOT EXISTS "gsf_attributed_orders_click_idx" ON "gsf_attributed_orders" ("click_event_id");

-- Revenue over a range.
CREATE INDEX IF NOT EXISTS "gsf_attributed_orders_confirmed_idx" ON "gsf_attributed_orders" ("confirmed_at" DESC);

-- ---------------------------------------------------------------------------
-- The brake on the public route
-- ---------------------------------------------------------------------------

-- A counter per caller per window, claimed atomically.
--
-- It has to be a table. Every serverless invocation is its own process with its
-- own memory, so an in-process counter is a brake that releases itself on the
-- next request - a lesson already paid for elsewhere in this module. Postgres
-- is the only thing all the invocations can see, and an UPDATE ... RETURNING is
-- the only thing that can count without two callers reading the same number.
CREATE TABLE IF NOT EXISTS "gsf_beacon_rate" (
    -- A keyed hash of the caller, the same one the landings use. No address.
    "bucket_key" TEXT NOT NULL,
    "window_started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hits" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "gsf_beacon_rate_pkey" PRIMARY KEY ("bucket_key")
);

-- The sweep drops windows nothing has touched for a while.
CREATE INDEX IF NOT EXISTS "gsf_beacon_rate_window_idx" ON "gsf_beacon_rate" ("window_started_at");

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

-- Add the campaign tags to every product link in the feed, and publish the
-- paid-traffic address alongside it.
--
-- OFF by default, and it stays off until an owner says otherwise: it changes
-- the address Google sends shoppers to, which anything else measuring this site
-- will notice, and a tag nobody asked for turning up in somebody's analytics is
-- not an improvement.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "link_tagging_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Count landings at all. OFF by default: it writes a row per visitor arrival
-- and, for a visitor who has agreed to marketing, sets a cookie. Neither is
-- something an update should start doing to a site on its own.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "click_tracking_enabled" BOOLEAN NOT NULL DEFAULT false;

-- How long a landing is kept. 400 days is thirteen months, so last year's same
-- month is still there to compare against; 0 keeps everything, which is a real
-- answer for a shop that wants its whole history. Pruning runs in the daily
-- check and takes the attributions with it.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "click_retention_days" INTEGER NOT NULL DEFAULT 400;
