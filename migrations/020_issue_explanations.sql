-- Room for Google's own words about one item's problem.
--
-- The daily check reads the product_view report, which gives a code and a
-- field and nothing else. Google's fuller wording - a short description, a
-- longer detail, and a link to the page that explains it - lives on
-- accounts.products, one call PER PRODUCT. That is far too many calls to make
-- for a whole catalogue, but exactly the right number to make when an owner
-- presses "Explain this" on one item.
--
-- `description` and `documentation_url` already existed (migration 018) and
-- were left NULL for precisely this. These two complete the set: Google's
-- longer sentence, and when we last asked.
--
-- Idempotent throughout: the module migration runner may apply it again.

-- Google's "Detail: A detailed issue description in English" - the longer of
-- the two sentences, and usually the one that says what to actually do.
ALTER TABLE "gsf_item_issues" ADD COLUMN IF NOT EXISTS "detail" TEXT;

-- When the explanation above was fetched. NULL means never asked, which the
-- screen shows as a button rather than as "Google said nothing".
--
-- It is also the whole cache rule. An explanation is stale once the issue has
-- been SEEN again since it was fetched (explained_at < last_seen_at): the
-- daily check moves last_seen_at every day an issue is still open, so a second
-- press on the same day is free and the day after fetches Google's current
-- wording. Cheap, self-correcting, and it needs no expiry sweep.
--
-- Only a SUCCESSFUL call writes this. A call that was merely attempted writes
-- the claim below instead, so "Google answered and had nothing to add" can
-- never be confused with "we tried and it went wrong".
ALTER TABLE "gsf_item_issues" ADD COLUMN IF NOT EXISTS "explained_at" TIMESTAMP(3);

-- When somebody last CLAIMED the right to ask Google about this item, which is
-- a different question from when Google last answered.
--
-- This is the rate limit, and it has to be a column rather than anything in
-- process memory: each serverless invocation is its own process, so an
-- in-process guard stops nothing. It is claimed with one conditional UPDATE
-- before the call goes out - row locks serialise concurrent callers, so out of
-- two hundred simultaneous requests for the same item exactly one updates a
-- row and the other hundred and ninety-nine are served from the cache.
--
-- Kept apart from explained_at deliberately. If the claim wrote explained_at,
-- a failed call would leave a row that looked freshly explained with no words
-- on it, and the screen would tell the owner Google had nothing to say when in
-- fact nobody had managed to ask.
ALTER TABLE "gsf_item_issues" ADD COLUMN IF NOT EXISTS "explain_claimed_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "gsf_item_issues_claim_idx" ON "gsf_item_issues" ("item_id", "explain_claimed_at");
