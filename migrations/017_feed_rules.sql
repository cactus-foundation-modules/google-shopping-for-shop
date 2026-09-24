-- Feed rules, and a three-way choice per product and per variation.
--
-- A feed rule is a set of conditions ("attribute MTO is Yes AND supplier is
-- X") and one thing to do to every item that meets them: keep it out of the
-- feed, give it a custom label, send it a title template, or change what it
-- says about its identifiers. The conditions and the action are jsonb because
-- their shape is the module's own (lib/feed-rules/types.ts validates every
-- write), and a new condition or action should not need a migration.
--
-- Keyed by a text uuid, so the backup has no sequence to carry. Idempotent
-- throughout: the module migration runner may apply it again.
CREATE TABLE IF NOT EXISTS "gsf_feed_rules" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    -- 0 first. The order the owner sees, and the order label, title and
    -- identifier rules are tried in: the first match wins each of those.
    "position" INTEGER NOT NULL DEFAULT 0,
    -- { "op": "all" | "any", "items": [condition | group, ...] }
    "conditions" JSONB NOT NULL,
    -- { "type": "exclude" } | { "type": "custom_label", "slot": 0-4, "value": "..." } | ...
    "action" JSONB NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gsf_feed_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "gsf_feed_rules_name_not_blank" CHECK (length(trim("name")) > 0)
);

CREATE INDEX IF NOT EXISTS "gsf_feed_rules_position_idx" ON "gsf_feed_rules" ("position");

-- The owner's own say on one product or one variation: follow the rules
-- (the default), always send it, or never send it. Replaces the old
-- `excluded` tick, which could only say "never". A variation's row is keyed by
-- its own product id, as every variation is a product row of its own; only
-- this column means anything on a variation's row - brand, codes and the rest
-- are the listing's.
ALTER TABLE "gsf_product_data" ADD COLUMN IF NOT EXISTS "feed_choice" TEXT NOT NULL DEFAULT 'rules';

DO $$
BEGIN
    ALTER TABLE "gsf_product_data"
        ADD CONSTRAINT "gsf_product_data_feed_choice_check" CHECK ("feed_choice" IN ('rules', 'include', 'exclude'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Every product ticked "keep out of the feed" becomes "never send it". Guarded
-- on the default so a second run cannot undo a choice made since.
UPDATE "gsf_product_data" SET "feed_choice" = 'exclude'
WHERE "excluded" = true AND "feed_choice" = 'rules';

-- Which product attribute is the shop's range, so rules can say "Range is ..."
-- and keep working when the attribute is renamed. Null: no range field.
ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "rules_range_attribute_id" TEXT;
