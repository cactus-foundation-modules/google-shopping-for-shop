-- Promotion windows: the start date a promotion keeps, and the revision that
-- gives it a fresh id when it needs one.
--
-- Two facts about Google that this table exists to respect, both learned the
-- expensive way:
--
--  1. A promotion's START TIME cannot be changed once the promotion exists.
--     The source used to stamp `now` on every fetch, so every fetch after the
--     first was an edit Google refuses - reported as "Promotion invalid
--     Update", `validation/invalid_value`. Google discards the new dates
--     rather than erroring loudly, so nothing looked wrong from here.
--
--  2. A promotion id is SINGLE-USE, for ever. Once an id has existed and
--     stopped - expired, stopped by hand, or left with no effective period by
--     a refused edit - Google will not revive it. Re-submitting the id returns
--     HTTP 200 and quietly keeps it dead. Google's own instruction is to
--     "create a new promotion with a new promotion ID", and before this table
--     there was no way to mint one: the id came from the supplier and the
--     amount, and neither is ours to change.
--
-- So the start date is written down once and kept, and a promotion that needs
-- a new id gets one by bumping a revision rather than by touching the shop's
-- data. Google also caps a promotion at 183 days, which means a standing offer
-- CANNOT be served as one id with a rolling end date - it has to become a new
-- promotion before the cap. That renewal is the same mechanism as the reissue,
-- and it happens on its own.
--
-- Idempotent: the module migration runner may apply it again.

CREATE TABLE IF NOT EXISTS "gsf_promotion_windows" (
    -- The revision-independent identity of the offer, which is the id the
    -- grouping in lib/promotions.ts derives from the supplier and the stamped
    -- amount. Two runs of an unchanged catalogue produce the same key, which
    -- is the whole point: it is what joins today's fetch to the row written
    -- weeks ago.
    "base_key" TEXT NOT NULL,
    -- 0 is the id exactly as derived. Above 0 the emitted id carries a "-rN"
    -- suffix, which is a promotion Google has never seen before and will
    -- therefore accept. Bumped automatically as the window runs out, and by
    -- hand when Google has burned an id.
    "revision" INTEGER NOT NULL DEFAULT 0,
    -- When the CURRENT revision started. Never edited while a revision lives;
    -- a new revision gets a new one. This is the value the source sends, and
    -- sending the same value every time is what stops the refused edit.
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- When the current revision runs out. Inside Google's 183-day cap, and the
    -- date the automatic renewal counts back from.
    "ends_at" TIMESTAMP(3) NOT NULL,
    -- The last time a fetch saw this offer still being offered. Nothing reads
    -- it yet; it is here so that "this promotion quietly stopped existing three
    -- weeks ago" is answerable at all.
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gsf_promotion_windows_pkey" PRIMARY KEY ("base_key")
);
