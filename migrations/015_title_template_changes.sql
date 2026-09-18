-- Google Shopping title template change log.
--
-- The workbench can set one template across every item a search matches -
-- thousands of titles in one press, over the top of hand-written ones. Each
-- save is recorded here as a batch, with what every item held before and what
-- it was given, so a batch can be undone. Undo restores only the items still
-- holding what the batch gave them: anything edited since is left alone.
--
-- Pruned by the writer to a bounded window (lib/title-template-changes.ts), so
-- the log holds recent history, not every keystroke since the shop opened.
--
-- Keyed by text uuids rather than serials: no sequence for the backup to carry.
CREATE TABLE IF NOT EXISTS "gsf_title_template_batches" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    -- What was done, in the owner's words: "Set a template on 3,214 items".
    "summary" TEXT NOT NULL,
    "item_count" INTEGER NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Set once the batch has been undone; an undone batch cannot be undone twice.
    "undone_at" TIMESTAMP(3),
    CONSTRAINT "gsf_title_template_batches_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "gsf_title_template_batches_created_idx" ON "gsf_title_template_batches" ("created_at" DESC);

CREATE TABLE IF NOT EXISTS "gsf_title_template_batch_items" (
    "batch_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    -- NULL means the item had no template: it sent its ordinary feed title.
    "previous_template" TEXT,
    -- NULL means the batch cleared the item's template.
    "new_template" TEXT,
    CONSTRAINT "gsf_title_template_batch_items_pkey" PRIMARY KEY ("batch_id", "item_id"),
    CONSTRAINT "gsf_title_template_batch_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "gsf_title_template_batches"("id") ON DELETE CASCADE,
    CONSTRAINT "gsf_title_template_batch_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "shp_products"("id") ON DELETE CASCADE
);

-- A product deleted from the shop cascades here by item id; without this every
-- such delete would read the whole log.
CREATE INDEX IF NOT EXISTS "gsf_title_template_batch_items_item_idx" ON "gsf_title_template_batch_items" ("item_id");
