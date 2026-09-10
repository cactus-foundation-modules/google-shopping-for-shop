-- The attribute whose value each item carries into Google as `shipping_label`.
--
-- Merchant Center matches its own delivery rates against this label, so a shop
-- whose delivery cost depends on what a thing IS - a chair, a desk, something
-- made to order - can group its items once here and price each group over
-- there, rather than sending every item's full price list on the item itself.
--
-- Null is off, and off is the default: this changes what Google charges for
-- delivery, and no site should discover that after an update rather than
-- because somebody chose it. The value is an attribute id belonging to whatever
-- module publishes product attributes; a stale one simply finds nothing and
-- leaves the label off, which is the same as off.
-- Idempotent so run-module-migrations can safely re-apply it.

ALTER TABLE "gsf_settings" ADD COLUMN IF NOT EXISTS "shipping_label_attribute_id" TEXT;
