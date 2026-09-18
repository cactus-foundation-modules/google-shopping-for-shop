-- Google Shopping match history.
--
-- gsf_item_match_status only holds the latest snapshot, so an item that slips
-- from matched to unmatched leaves no trace of when, or of what it was called
-- at the time. A row lands here whenever a refresh sees an item's match state
-- or the title Google holds for it change - never on a refresh that found
-- nothing new, so the table grows with changes, not with days.
--
-- Keyed by a text uuid rather than a serial: no sequence for the backup to
-- carry.
CREATE TABLE IF NOT EXISTS "gsf_item_match_history" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "item_id" TEXT NOT NULL,
    "matched" BOOLEAN NOT NULL,
    -- The title Google held for the item when this was recorded - what we sent.
    "merchant_title" TEXT,
    "benchmark_amount_micros" BIGINT,
    "benchmark_currency" TEXT,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gsf_item_match_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "gsf_item_match_history_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "shp_products"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "gsf_item_match_history_item_recorded_idx" ON "gsf_item_match_history" ("item_id", "recorded_at" DESC);

-- Baseline: the snapshot already held becomes each item's first entry, so the
-- next refresh compares against it instead of logging every item as new.
INSERT INTO "gsf_item_match_history"
    ("item_id", "matched", "merchant_title", "benchmark_amount_micros", "benchmark_currency", "recorded_at")
SELECT s."item_id", s."matched", s."merchant_title", s."benchmark_amount_micros", s."benchmark_currency", s."checked_at"
FROM "gsf_item_match_status" s
WHERE NOT EXISTS (SELECT 1 FROM "gsf_item_match_history" h WHERE h."item_id" = s."item_id");
