-- What the last real feed build refused to publish, and when.
--
-- `image_link` is a required attribute: an item without one is rejected by
-- Google every time, on every destination, in every country. The feed used to
-- send those rows anyway, so the only place an owner could find out was a
-- disapproval in Merchant Center - and only if they went looking. Now the row
-- is withheld, and what was withheld is recorded here for the settings tab to
-- read back.
--
-- Recorded rather than recomputed on demand: working it out means building the
-- whole feed, which on a real catalogue is tens of megabytes and several
-- thousand queries - far too much for a settings page to do on every render.
-- The scheduled fetch already does that work, so it writes down what it found.
--
-- Nullable and empty by default: a shop whose feed has not been fetched since
-- this shipped has no answer yet, which is a different thing from "nothing was
-- withheld" and the tab says so.
-- Idempotent so run-module-migrations can safely re-apply it.

ALTER TABLE "gsf_settings"
  ADD COLUMN IF NOT EXISTS "withheld_items" JSONB;

ALTER TABLE "gsf_settings"
  ADD COLUMN IF NOT EXISTS "withheld_at" TIMESTAMP(3);
