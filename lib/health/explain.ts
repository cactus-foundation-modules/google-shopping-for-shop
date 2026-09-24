// "Explain this one." Google's own words about a single item's problems.
//
// The daily check reads the product_view report, which gives a code and a
// field and no sentences. Google will explain itself properly - a short
// description, a longer detail, and a link to the page about it - but only one
// product at a time, through accounts.products. On a catalogue of any size
// that is far too many calls to make on a schedule, and exactly the right
// number to make when somebody presses a button on one row.
//
// So: one call, on demand, never in bulk, never on page load, never in the
// cron. What comes back is written onto the rows it explains, so a second
// press costs nothing until the daily check sees the issue again.
//
// Honesty rules, because a wrong guess here must degrade rather than lie:
//   - Google sent nothing useful -> say exactly that, never invent wording.
//   - No feed label set -> say what to fill in, rather than asking Google
//     about a product name we made up.
//   - Google refused -> Google's own sentence, in plain English, never a
//     stack and never a credential.
import { prisma } from '@/lib/db/prisma'
import { merchantRequest } from '@/modules/google-shopping-for-shop/lib/google/client'
import { hasGoogleCredentials } from '@/modules/google-shopping-for-shop/lib/google/credentials'
import { GoogleApiError, GoogleAuthError, GoogleCredentialsError } from '@/modules/google-shopping-for-shop/lib/google/errors'
import {
  hasWords,
  parseItemLevelIssues,
  productResourceSegment,
  type IssueExplanation,
  type RawProduct,
} from '@/modules/google-shopping-for-shop/lib/health/parse'
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'

/** The owner is watching a spinner they started. One retry, not a full
 *  backoff: an answer of "not just now, try again" beats seven seconds of
 *  nothing. */
const EXPLAIN_ATTEMPTS = 2

/**
 * The server's own brake, in milliseconds.
 *
 * The disabled button is a courtesy, not a control: anyone holding
 * `shop.products` - a product editor, not an admin - can POST this route in a
 * loop, and `force` was written to skip the cache, so every one of those was a
 * Merchant API call. The account's quota is shared with the daily match
 * refresh and the feed fetch check, so the failure mode is not "this screen is
 * slow", it is everyone's Health tab going dark.
 *
 * Thirty seconds is long enough that no loop gets through and short enough
 * that nobody pressing the button deliberately ever notices: a second press
 * inside it is served from the cache exactly as a fresh one would be, with no
 * error and no different wording.
 *
 * A call that FAILS keeps the slot for the rest of the window. That is the
 * right way round for a brake - a failing endpoint is precisely what should
 * not be hammered - and the wording the owner sees already says to try again
 * in a moment.
 */
const EXPLAIN_COOLDOWN_MS = 30_000

/** One issue with whatever Google has said about it. */
export type ExplainedIssue = {
  code: string
  attribute: string
  /** Google's short sentence, '' when it has sent none. */
  description: string
  detail: string
  documentationUrl: string | null
  reportingContext: string
  applicableCountries: string[]
  /** When we last asked Google about this row, null when never. */
  explainedAt: string | null
}

export type ExplainOutcome =
  | { status: 'ok'; issues: ExplainedIssue[]; fromCache: boolean; checkedAt: string }
  /** Google answered, and had nothing to say about this item. A real answer. */
  | { status: 'no-words'; message: string }
  | { status: 'unavailable'; reason: ExplainUnavailable; message: string }

export const EXPLAIN_UNAVAILABLE = ['no-credentials', 'no-merchant-id', 'no-feed-label', 'nothing-to-explain', 'just-asked', 'not-found', 'denied', 'error'] as const
export type ExplainUnavailable = (typeof EXPLAIN_UNAVAILABLE)[number]

const UNAVAILABLE_COPY: Record<ExplainUnavailable, string> = {
  'no-credentials': 'No Google key has been saved yet, so there is nothing to ask with.',
  'no-merchant-id': 'Fill in your Merchant Center account number on the Google Shopping settings tab and this can be looked up.',
  // The feed label is genuinely required to name a product to Google. Saying
  // so is better than asking about a name we invented and reporting the 404.
  'no-feed-label': 'Google files your products under a feed label, and this site has not been told what it is. '
    + 'Fill in the feed label on the Google Shopping settings tab and this can be looked up.',
  // Also the brake on a junk item id: nothing can reach Google without an
  // open issue row to explain.
  'nothing-to-explain': 'There is nothing open against this item, so there is nothing to ask Google about.',
  // Somebody else holds the claim - another tab, another person, or the press
  // half a second ago. Never "Google had nothing to say": nobody has heard
  // back yet, and saying otherwise would be inventing an answer.
  'just-asked': 'Google was asked about this item a moment ago and has not answered yet. Try again shortly.',
  'not-found': 'Google has no record of this item under your account. It may have dropped out of the feed since the last check.',
  denied: 'Google would not let this key read your products. It needs at least the "Performance and insights" access level in Merchant Center.',
  error: 'Google could not be asked just now. Nothing is wrong with the item as far as we know - try again in a moment.',
}

function unavailable(reason: ExplainUnavailable, detail?: string | null): ExplainOutcome {
  // Google's own sentence is appended where it sent one - it is usually
  // clearer about its own refusals than we could be. GoogleApiError carries
  // Google's message and a status and nothing of ours, so no credential can
  // travel this way.
  const own = detail?.trim()
  return { status: 'unavailable', reason, message: own ? `${UNAVAILABLE_COPY[reason]} Google said: ${own}` : UNAVAILABLE_COPY[reason] }
}

function fromError(error: unknown): ExplainOutcome {
  if (error instanceof GoogleCredentialsError) return unavailable('no-credentials')
  if (error instanceof GoogleAuthError) return unavailable('denied', error.message)
  if (error instanceof GoogleApiError && error.status === 404) return unavailable('not-found', error.message)
  if (error instanceof GoogleApiError && error.forbidden) return unavailable('denied', error.message)
  if (error instanceof GoogleApiError) return unavailable('error', error.message)
  return unavailable('error')
}

type CacheRow = {
  code: string
  attribute: string
  description: string | null
  detail: string | null
  documentation_url: string | null
  explained_at: Date | null
  last_seen_at: Date
}

/**
 * What we already hold for one item, and whether it is still good.
 *
 * Fresh means every open row has been explained SINCE it was last seen. The
 * daily check moves last_seen_at every day an issue is still open, so today's
 * second press is free and tomorrow's first press asks Google again - which is
 * what keeps the wording current without an expiry sweep or a second column.
 */
async function readCached(itemId: string): Promise<{ rows: CacheRow[]; fresh: boolean }> {
  const rows = await prisma.$queryRaw<CacheRow[]>`
    SELECT "code", "attribute", "description", "detail", "documentation_url", "explained_at", "last_seen_at"
    FROM "gsf_item_issues"
    WHERE "item_id" = ${itemId} AND "resolved_at" IS NULL
    ORDER BY "code" ASC, "attribute" ASC
  `
  const fresh = rows.length > 0 && rows.every((row) => row.explained_at !== null && row.explained_at >= row.last_seen_at)
  return { rows, fresh }
}

function toExplained(rows: CacheRow[]): ExplainedIssue[] {
  return rows.map((row) => ({
    code: row.code,
    attribute: row.attribute,
    description: row.description ?? '',
    detail: row.detail ?? '',
    documentationUrl: row.documentation_url,
    // Not cached: the per-context detail belongs to the live answer, and the
    // row already carries the report's own contexts for the badge.
    reportingContext: '',
    applicableCountries: [],
    explainedAt: row.explained_at?.toISOString() ?? null,
  }))
}

/**
 * Writes Google's wording onto the rows it explains.
 *
 * Matched on (code, attribute), which is the table's own key. Google's
 * canonical attribute here is not always spelled the way the report spells it,
 * so an explanation whose code matches but whose attribute does not is applied
 * to every row with that code rather than dropped - the words are about the
 * problem, and losing them over a spelling is worse than attaching them to a
 * sibling row.
 *
 * `explained_at` is stamped on EVERY open row of the item, explained or not.
 * Otherwise an item Google had nothing to say about would look un-asked for
 * ever and re-ask on every press.
 *
 * Exported only so lib/health-sql.test.ts can run these statements against a
 * real Postgres. Nothing else calls it: raw SQL is a string to typecheck,
 * eslint and the build alike, and an UPDATE nothing executes is an UPDATE
 * nobody has checked parses.
 */
export async function cacheExplanations(itemId: string, explanations: IssueExplanation[], askedAt: Date): Promise<void> {
  for (const explanation of explanations) {
    if (!hasWords(explanation)) continue
    await prisma.$executeRaw`
      UPDATE "gsf_item_issues"
      SET "description" = ${explanation.description || null},
          "detail" = ${explanation.detail || null},
          "documentation_url" = ${explanation.documentationUrl}
      WHERE "item_id" = ${itemId}
        -- Open rows only, matching the stamp below. Without it the two halves
        -- disagree about what they are writing to: words would land on issues
        -- closed months ago while the stamp skipped them.
        AND "resolved_at" IS NULL
        AND "code" = ${explanation.code}
        AND ("attribute" = ${explanation.attribute} OR ${explanation.attribute} = '' OR "attribute" = '')
    `
  }
  await prisma.$executeRaw`
    UPDATE "gsf_item_issues" SET "explained_at" = ${askedAt}
    WHERE "item_id" = ${itemId} AND "resolved_at" IS NULL
  `
}

/**
 * Takes the right to ask Google about this item, or finds somebody else has.
 *
 * ONE conditional UPDATE, and the brake's whole correctness rests on it. The
 * shape that was here before - read the stamp, check it, call Google, stamp
 * afterwards - is a time-of-check-to-time-of-use gap several hundred
 * milliseconds wide: every request arriving before the first stamp read the
 * same pre-stamp value and passed, so two hundred parallel presses for one
 * item were two hundred Merchant API calls. Serial pressing was braked;
 * concurrent pressing was not braked at all.
 *
 * Postgres locks the rows this statement touches, so concurrent callers queue
 * and re-evaluate the WHERE against the committed result. Exactly one sees a
 * claimable row and updates it; the rest match nothing and get false. No
 * transaction to manage, no advisory lock to leak, and it works across
 * however many serverless invocations happen to be alive.
 *
 * Returns true when this caller may proceed to Google.
 *
 * Exported so lib/health-sql.test.ts can fire it concurrently against a real
 * Postgres. That is the only way to prove the thing it exists for: a serial
 * test passes against the broken version too, and with no credentials
 * configured a test cannot reach this through explainItem at all - the setup
 * checks above it answer first, by design.
 */
export async function claimExplainSlot(itemId: string): Promise<boolean> {
  const seconds = Math.round(EXPLAIN_COOLDOWN_MS / 1000)
  const claimed = await prisma.$executeRaw`
    UPDATE "gsf_item_issues"
    SET "explain_claimed_at" = CURRENT_TIMESTAMP
    WHERE "item_id" = ${itemId}
      AND "resolved_at" IS NULL
      AND ("explain_claimed_at" IS NULL
           -- Cast because make_interval takes its arguments by name, and a
           -- bare placeholder leaves Postgres unable to infer the type.
           OR "explain_claimed_at" < CURRENT_TIMESTAMP - make_interval(secs => ${seconds}::int))
  `
  return claimed > 0
}

/** Whatever we hold, in the shape the caller expects. */
function serveCached(rows: CacheRow[]): ExplainOutcome {
  const issues = toExplained(rows)
  // Held, and held with nothing in it: Google has been asked and had no
  // words. Say that rather than re-asking on every press.
  if (!issues.some((issue) => issue.description || issue.detail || issue.documentationUrl)) {
    return { status: 'no-words', message: NO_WORDS }
  }
  return { status: 'ok', issues, fromCache: true, checkedAt: rows[0]?.explained_at?.toISOString() ?? new Date().toISOString() }
}

/**
 * Google's words about one item.
 *
 * `force` skips the CACHE - what the "ask Google again" link sends. It does
 * not skip the cooldown, and nothing does: see EXPLAIN_COOLDOWN_MS.
 */
export async function explainItem(itemId: string, options: { force?: boolean } = {}): Promise<ExplainOutcome> {
  const cached = await readCached(itemId)

  // Nothing open against this item, so there is nothing to explain - and no
  // row to claim a slot on either. Refusing here is what stops a made-up item
  // id being an unmetered way to spend the account's quota: every path to
  // Google below has to win a claim, and a claim needs a row.
  if (cached.rows.length === 0) return unavailable('nothing-to-explain')

  // A held answer that is still good costs nothing and takes no slot.
  if (!options.force && cached.fresh) return serveCached(cached.rows)

  // Everything this install has failed to configure, checked BEFORE the slot
  // is claimed. None of these three touches anything outside the building, so
  // none of them is worth a slot - and on a half-set-up install, burning the
  // claim here would replace "fill in your Merchant Center account number"
  // with "Google was asked a moment ago" for the next thirty seconds, which
  // is both untrue and useless. The setup guidance has to stay on screen for
  // as long as the setup is missing.
  if (!hasGoogleCredentials()) return unavailable('no-credentials')
  const settings = await getGsfSettings()
  if (!settings.merchantId) return unavailable('no-merchant-id')
  // The shop's own setting, not a constant here. A product's name at Google is
  // offer id + content language + feed label, and asking under the wrong
  // language asks about a product no feed publishes - which answers, plausibly
  // and uselessly, with nothing. Defaults to 'en' (every page of this platform
  // renders in English) and is validated against the main feed's own by the
  // live updates setup.
  const segment = productResourceSegment({
    contentLanguage: settings.contentLanguage,
    feedLabel: settings.feedLabel,
    offerId: itemId,
  })
  if (!segment) return unavailable('no-feed-label')

  // Past here the call really is going out, so the slot has to be won first.
  // `force` skips the CACHE; nothing skips this.
  if (!await claimExplainSlot(itemId)) {
    // Somebody else has the slot. If we hold real words, they are as true now
    // as they were a moment ago - show them. If we do not, say plainly that
    // the answer has not come back yet rather than reporting silence from
    // Google that nobody has actually heard.
    return cached.fresh ? serveCached(cached.rows) : unavailable('just-asked')
  }

  let product: RawProduct
  try {
    product = await merchantRequest<RawProduct>(
      `products/v1/accounts/${settings.merchantId}/products/${segment}`,
      { method: 'GET', attempts: EXPLAIN_ATTEMPTS },
    )
  } catch (error) {
    return fromError(error)
  }

  const askedAt = new Date()
  const explanations = parseItemLevelIssues(product)
  await cacheExplanations(itemId, explanations, askedAt)

  const withWords = explanations.filter(hasWords)
  if (withWords.length === 0) return { status: 'no-words', message: NO_WORDS }

  return {
    status: 'ok',
    fromCache: false,
    checkedAt: askedAt.toISOString(),
    issues: withWords.map((explanation) => ({
      code: explanation.code,
      attribute: explanation.attribute,
      description: explanation.description,
      detail: explanation.detail,
      documentationUrl: explanation.documentationUrl,
      reportingContext: explanation.reportingContext,
      applicableCountries: explanation.applicableCountries,
      explainedAt: askedAt.toISOString(),
    })),
  }
}

const NO_WORDS = 'Google answered, but had nothing more to say about this one than the reason already shown. '
  + 'Merchant Center sometimes has more - the link beside this item goes straight to its page there.'
