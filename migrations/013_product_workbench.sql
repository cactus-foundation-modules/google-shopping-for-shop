-- Google Shopping product workbench.
--
-- Title templates are feed-only: they let a shop keep its own product names and
-- option labels while sending Google the shorter, market-shaped title it
-- matches on. Rows are keyed by the feed item id, which is the product id the
-- feed sends as <g:id> (a variation child, or the standalone product).
CREATE TABLE IF NOT EXISTS "gsf_title_templates" (
    "item_id" TEXT NOT NULL,
    "title_template" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gsf_title_templates_pkey" PRIMARY KEY ("item_id"),
    CONSTRAINT "gsf_title_templates_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "shp_products"("id") ON DELETE CASCADE,
    CONSTRAINT "gsf_title_templates_not_blank" CHECK (length(trim("title_template")) > 0)
);

-- Last known Merchant Center matching state. This is a snapshot because the
-- feed can be built from shop data alone, while Google's benchmark/matching
-- report has to be pulled from Merchant API when credentials are available.
CREATE TABLE IF NOT EXISTS "gsf_item_match_status" (
    "item_id" TEXT NOT NULL,
    "matched" BOOLEAN NOT NULL DEFAULT false,
    "merchant_title" TEXT,
    "benchmark_amount_micros" BIGINT,
    "benchmark_currency" TEXT,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gsf_item_match_status_pkey" PRIMARY KEY ("item_id"),
    CONSTRAINT "gsf_item_match_status_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "shp_products"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "gsf_item_match_status_matched_idx" ON "gsf_item_match_status" ("matched");
CREATE INDEX IF NOT EXISTS "gsf_item_match_status_checked_at_idx" ON "gsf_item_match_status" ("checked_at");
