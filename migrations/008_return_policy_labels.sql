-- Whether each item carries its own return policy label into Google.
--
-- Merchant Center holds the policies; the feed only names one. An item whose
-- label matches a policy configured over there is judged by that policy, and an
-- item whose label matches nothing quietly falls back to the account's default
-- - which is why this is off by default. A shop that has not written the
-- policies yet would otherwise start labelling items against policies that do
-- not exist, and never be told.
--
-- The label itself is not stored here. It is the shop's own non-returnable note
-- ("Upholstered to order in the fabric you choose..."), read per item at feed
-- time, so the wording a customer reads and the policy Google applies cannot
-- drift apart.
-- Idempotent so run-module-migrations can safely re-apply it.

ALTER TABLE "gsf_settings"
  ADD COLUMN IF NOT EXISTS "return_policy_labels_enabled" BOOLEAN NOT NULL DEFAULT false;
