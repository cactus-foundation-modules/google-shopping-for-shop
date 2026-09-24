-- One change log for the whole Google Shopping workbench.
--
-- The title templates already keep their own batch log (migration 015), because
-- one save there touches thousands of rows and undo has to be row-by-row. Every
-- other thing the workbench will change - a feed rule, the delivery settings
-- pushed to Merchant Center, a setting flipped - is one thing at a time, with a
-- before and an after, and wants one plain table rather than a table each.
--
-- `before` and `after` are jsonb and deliberately unshaped: each area decides
-- what a snapshot of its own thing looks like, and the undo for that area is
-- the only code that reads it back (lib/change-log.ts).
--
-- Pruned by the writer, as 015 is: the newest entries per area are kept, older
-- ones are dropped, so the log stays a recent history rather than a permanent
-- archive. Keyed by a text uuid, so the backup has no sequence to carry.
CREATE TABLE IF NOT EXISTS "gsf_change_log" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    -- Which part of the workbench did this: 'feed-rules', 'shipping', ...
    -- A plain text column rather than an enum, so a later area needs no
    -- migration of its own to start writing here.
    "area" TEXT NOT NULL,
    -- What kind of change it was, within that area: 'create', 'update',
    -- 'delete', 'push'. The area's own undo reads it.
    "action" TEXT NOT NULL,
    -- What was done, in the owner's words: "Turned on the rule 'Clearance'".
    "summary" TEXT NOT NULL,
    -- The state before and after, as that area chooses to record it. NULL where
    -- there was nothing before (a create) or nothing after (a delete).
    "before" JSONB,
    "after" JSONB,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Set once put back; an undone entry cannot be undone twice.
    "undone_at" TIMESTAMP(3),
    CONSTRAINT "gsf_change_log_pkey" PRIMARY KEY ("id")
);

-- The listing every tab does: its own area, newest first.
CREATE INDEX IF NOT EXISTS "gsf_change_log_area_created_idx" ON "gsf_change_log" ("area", "created_at" DESC);

-- The whole-workbench listing, and what the pruner orders by.
CREATE INDEX IF NOT EXISTS "gsf_change_log_created_idx" ON "gsf_change_log" ("created_at" DESC);
