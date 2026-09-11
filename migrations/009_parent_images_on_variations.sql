-- Whether a variation's feed item carries its listing's own photographs behind
-- its own.
--
-- A variation sends its own pictures and nothing else today, which is right
-- where it has a set of its own and thin where it has two. The listing above it
-- usually has more - the room shot, the detail of the mechanism, the dimensions
-- drawing - and Google takes eleven pictures an item, so the rest of the
-- listing's gallery is worth having behind the variation's own.
--
-- The catch, and the reason this is a switch rather than the new behaviour: on
-- plenty of shops the listing's own gallery IS a parade of its variations - the
-- oak one, the walnut one, the black one - and pouring that into the black
-- variation's item shows Google an oak desk under a black desk's price. The
-- feed drops any listing picture that belongs to another variation, so the
-- honest ones (a room shot, a close-up) still come through, but a shop whose
-- gallery shows other finishes in photographs nothing on the site knows are
-- theirs is better off leaving this alone.
--
-- Off by default: this changes the pictures Google shows against a price, and
-- no site should discover that after an update rather than because somebody
-- chose it.
-- Idempotent so run-module-migrations can safely re-apply it.

ALTER TABLE "gsf_settings"
  ADD COLUMN IF NOT EXISTS "parent_images_on_variations" BOOLEAN NOT NULL DEFAULT false;
