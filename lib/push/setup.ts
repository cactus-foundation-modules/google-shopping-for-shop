// Setting the live updates up at Merchant Center, and taking them back out.
//
// Two writes to somebody's advertising account, so both follow the pattern the
// delivery push established (lib/delivery/push.ts) rather than inventing a
// second one:
//
//   1. the intent is recorded in the change log BEFORE the call, so a crash
//      leaves a record of what was attempted;
//   2. the call happens outside any transaction, because holding a Postgres
//      row lock open across a round trip to Google is how a five-second
//      transaction timeout becomes a half-written change;
//   3. the outcome amends the entry afterwards - and where Google's reply could
//      not be read back, it says exactly that rather than 'done'.
//
// The linking step is the dangerous one. Google replaces a primary data
// source's whole default rule on a patch - "It doesn't work as an addition", in
// its own words - so the rule is read, merged and written back, and the
// previous rule is kept in the change log so Undo can put it back.
import {
  amendChange,
  recordChange,
  registerUndoHandler,
  type UndoContext,
  type UndoResult,
} from '@/modules/google-shopping-for-shop/lib/change-log'
import { canonicalJson } from '@/modules/google-shopping-for-shop/lib/feed-rules/canonical'
import { getSiteUrl } from '@/lib/config/env'
import { hasGoogleCredentials } from '@/modules/google-shopping-for-shop/lib/google/credentials'
import { checkWriteAccess } from '@/modules/google-shopping-for-shop/lib/google/access-check'
import { GoogleApiError } from '@/modules/google-shopping-for-shop/lib/google/errors'
import { isOurFeedUrl } from '@/modules/google-shopping-for-shop/lib/health/parse'
import { feedUrl } from '@/modules/google-shopping-for-shop/lib/feed-url'
import { getGsfSettings, recordPushDataSource } from '@/modules/google-shopping-for-shop/lib/settings'
import {
  createSupplementalDataSource,
  linkPlacement,
  linkedRule,
  listDataSourceDetails,
  readDataSourceDetail,
  unlinkedRule,
  writeDefaultRule,
  PUSH_SOURCE_DISPLAY_NAME,
  type DataSourceDetail,
  type RuleReference,
} from '@/modules/google-shopping-for-shop/lib/push/data-source'

/** What the change log keeps for a link, so Undo has the rule to put back. */
export type LinkSnapshot = {
  primaryId: string
  primaryName: string
  supplementalName: string
  rule: RuleReference[]
  status?: 'sending' | 'done' | 'pending' | 'failed'
}

export type SetupPlan = {
  /** Null when Merchant Center has not been linked at all. */
  merchantId: string | null
  /** The primary data source Google fetches our feed from, when it could be
   *  found. Everything is linked into this one and no other. */
  primary: { id: string; displayName: string; fetchUri: string } | null
  /** Ours, when it already exists. */
  supplemental: { id: string; displayName: string } | null
  /** True when the primary source's rule takes from ours AHEAD of its own feed.
   *  Deliberately not "is ours in the list": the list is first-wins, so ours
   *  sitting behind `self` is the same as not being there at all. */
  linked: boolean
  /** True when ours IS in the rule but behind the feed, so it is being ignored.
   *  Its own state because the fix is different: nothing to create, just an
   *  order to put back. */
  behind: boolean
  /** What pressing the button would do, in the owner's terms. */
  steps: string[]
  /** Why it cannot be done, in the owner's terms. Empty means it can. */
  blockers: string[]
}

export type SetupOutcome =
  | { status: 'ready'; dataSourceId: string; primaryId: string; created: boolean; linked: boolean; confirmed: boolean; changeId: string | null }
  | { status: 'blocked'; message: string }
  | { status: 'failed'; message: string }

const PROBE_OPTIONS = { attempts: 2 } as const

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof GoogleApiError) return error.message
  return error instanceof Error ? error.message : fallback
}

/** Our supplemental source among the account's, matched on the id we recorded
 *  first and on the display name only as a fallback - so an account set up
 *  twice does not end up with two of them. */
function findOurs(sources: readonly DataSourceDetail[], recordedId: string | null): DataSourceDetail | null {
  if (recordedId) {
    const byId = sources.find((source) => source.id === recordedId)
    if (byId) return byId
  }
  return sources.find((source) => source.kind === 'supplemental' && source.displayName === PUSH_SOURCE_DISPLAY_NAME) ?? null
}

/**
 * "Would a product we send under these settings actually be THIS feed's
 * product?"
 *
 * A product's identity at Google is offer id + content language + feed label,
 * and all three are immutable once it exists. Send under a feed label the main
 * feed does not publish and Google files the input against a product no feed
 * has ever carried: it accepts it, stores it, reports nothing - and then the
 * hourly check GETs that same phantom name, finds exactly the figures it sent
 * and records "agrees". Alert clear for ever, nothing on the real listings
 * moving, and a typo on first setup is all it takes.
 *
 * So it is checked BEFORE anything is created or linked, against the primary
 * source's own declaration. A source that declares neither (which Google
 * allows for one with no file input) says nothing either way, and the products
 * carry their own - so that is not a mismatch and is not treated as one.
 *
 * Returns the sentences to show, empty when there is nothing to say.
 */
function identityBlockers(primary: DataSourceDetail, feedLabel: string, contentLanguage: string): string[] {
  const blockers: string[] = []
  // Still case-insensitive even though the setting is now stored upper-cased
  // (asFeedLabel): this reads what GOOGLE reports for the primary source, and
  // a comparison that assumed both sides were normalised would turn a passing
  // setup into a blocked one the day Google reported a label differently.
  if (primary.feedLabel !== '' && primary.feedLabel.toUpperCase() !== feedLabel.trim().toUpperCase()) {
    blockers.push(
      `Your feed label here is "${feedLabel.trim()}", but your main feed at Merchant Center is labelled "${primary.feedLabel}". `
      + 'Google files a product under its label, so updates sent with the wrong one would go to a product that does not exist and '
      + 'nothing on your listings would change. Put the same label on the Google Shopping settings tab and try again.',
    )
  }
  if (primary.contentLanguage !== '' && primary.contentLanguage.toLowerCase() !== contentLanguage.trim().toLowerCase()) {
    blockers.push(
      `Your listings language here is "${contentLanguage.trim()}", but your main feed at Merchant Center is in `
      + `"${primary.contentLanguage}". Those have to match, for the same reason the label does.`,
    )
  }
  return blockers
}

/** The primary source Google fetches our feed from: the one the owner chose,
 *  else the one stage 2 detected, else the one whose fetch address is ours. */
function findPrimary(sources: readonly DataSourceDetail[], chosenId: string | null, detectedId: string | null, ourFeedUrl: string | null): DataSourceDetail | null {
  const primaries = sources.filter((source) => source.kind === 'primary')
  for (const id of [chosenId, detectedId]) {
    if (!id) continue
    const found = primaries.find((source) => source.id === id)
    if (found) return found
  }
  if (!ourFeedUrl) return null
  return primaries.find((source) => source.fetchUri !== '' && isOurFeedUrl(source.fetchUri, ourFeedUrl)) ?? null
}

/**
 * What setting up would do, without doing any of it.
 *
 * Reads Merchant Center - one list call - and nothing else. The button next to
 * it is the only thing that writes.
 */
export async function planSetup(): Promise<SetupPlan> {
  const settings = await getGsfSettings()
  const empty: SetupPlan = { merchantId: settings.merchantId, primary: null, supplemental: null, linked: false, behind: false, steps: [], blockers: [] }

  if (!hasGoogleCredentials()) {
    return { ...empty, blockers: ['No Google service-account key has been saved yet, so there is nothing to set this up with.'] }
  }
  if (!settings.merchantId) {
    return { ...empty, blockers: ['Fill in your Merchant Center account number first.'] }
  }
  if (!settings.feedLabel) {
    return { ...empty, blockers: ['Fill in your feed label first. Google needs it to know which products these updates belong to.'] }
  }

  let sources: DataSourceDetail[]
  try {
    sources = await listDataSourceDetails(settings.merchantId, PROBE_OPTIONS)
  } catch (error) {
    return { ...empty, blockers: [`Your Merchant Center data sources could not be read: ${messageOf(error, 'Google did not answer')}`] }
  }

  const ourFeedUrl = feedUrl(getSiteUrl(), settings.feedToken)
  const primary = findPrimary(sources, settings.feedDataSourceId, settings.feedDataSourceDetectedId, ourFeedUrl)
  const supplemental = findOurs(sources, settings.pushDataSourceId)
  // Placement, not membership. See linkPlacement: [self, ours] is a rule that
  // looks connected on every screen and overrides nothing.
  const placement = primary && supplemental ? linkPlacement(primary.defaultRule, supplemental.name) : 'missing'
  const linked = placement === 'ahead'
  const behind = placement === 'behind'

  if (!primary) {
    return {
      ...empty,
      ...(supplemental ? { supplemental: { id: supplemental.id, displayName: supplemental.displayName } } : {}),
      blockers: [
        'Google is not reading a feed from this site yet, so there is nothing for the live updates to sit alongside. '
        + 'Give Merchant Center the feed address first, let it fetch once, then come back.',
      ],
    }
  }

  const found = {
    merchantId: settings.merchantId,
    primary: { id: primary.id, displayName: primary.displayName, fetchUri: primary.fetchUri },
    ...(supplemental ? { supplemental: { id: supplemental.id, displayName: supplemental.displayName } } : { supplemental: null }),
    linked,
    behind,
  }

  // The identity check first: a mismatch here is the one failure that is
  // completely silent afterwards, so it has to stop the button rather than
  // colour it.
  const mismatch = identityBlockers(primary, settings.feedLabel, settings.contentLanguage)
  if (mismatch.length > 0) return { ...found, steps: [], blockers: mismatch }

  // Then whether the key may write at all. `dataSources.list` above succeeds
  // for a reports-only key, so without this the preview cheerfully offered to
  // create and link and the write came back as a bare 403.
  const write = await checkWriteAccess(settings.merchantId, PROBE_OPTIONS).catch(() => null)
  if (write?.status === 'denied') return { ...found, steps: [], blockers: [write.detail] }

  const steps: string[] = []
  if (!supplemental) steps.push(`Create a second, small feed at Merchant Center called "${PUSH_SOURCE_DISPLAY_NAME}".`)
  if (behind) {
    // The repair case, which reads quite differently from setting it up: the
    // connection is there and is being ignored.
    steps.push(
      `Put this site's prices back in FRONT in your main feed "${primary.displayName || primary.id}". They are connected but sitting `
      + 'behind the feed itself, and Merchant Center takes the first answer it gets - so nothing sent from here is reaching a shopper.',
    )
  } else if (!linked) {
    // Said out loud because it is a real change to their setup, not a detail:
    // the list is first-wins, and this feature only works from the front of it.
    const others = primary.defaultRule.filter((entry) => entry.supplementalDataSourceName).length
    if (others > 0) {
      steps.push(
        `This site's prices would come first, ahead of ${others === 1 ? 'the other extra feed' : `the other ${others} extra feeds`} `
        + 'your main feed already reads. Everything they set that this site does not send is untouched.',
      )
    }
  }
  if (write?.status === 'unknown') {
    steps.push('Merchant Center did not say what this key is allowed to do, so this may still be refused. Check its access level under People and access.')
  }

  return { ...found, steps, blockers: [] }
}

/**
 * Creates the supplemental source if it is missing, and links it in.
 *
 * Safe to press twice: both halves check first, and the create is only ever
 * called when the account has no source of ours - Google's own note on the
 * create method is "This method always creates a new data source", so a
 * speculative call would leave a second one behind for ever.
 */
export async function runSetup(actor: string | null): Promise<SetupOutcome> {
  const settings = await getGsfSettings()
  if (!hasGoogleCredentials()) return { status: 'blocked', message: 'No Google service-account key has been saved yet.' }
  if (!settings.merchantId) return { status: 'blocked', message: 'Fill in your Merchant Center account number first.' }
  if (!settings.feedLabel) return { status: 'blocked', message: 'Fill in your feed label first.' }
  const merchantId = settings.merchantId

  let sources: DataSourceDetail[]
  try {
    sources = await listDataSourceDetails(merchantId)
  } catch (error) {
    return { status: 'failed', message: `Your Merchant Center data sources could not be read: ${messageOf(error, 'Google did not answer')}` }
  }

  const ourFeedUrl = feedUrl(getSiteUrl(), settings.feedToken)
  const primary = findPrimary(sources, settings.feedDataSourceId, settings.feedDataSourceDetectedId, ourFeedUrl)
  if (!primary) {
    return {
      status: 'blocked',
      message: 'Google is not reading a feed from this site yet, so there is nothing for the live updates to sit alongside.',
    }
  }

  // Checked again here, not only in the preview: this route can be called
  // directly, and a mismatch is the one failure nothing downstream would ever
  // notice.
  const mismatch = identityBlockers(primary, settings.feedLabel, settings.contentLanguage)
  if (mismatch.length > 0) return { status: 'blocked', message: mismatch[0] ?? '' }

  // ---- The supplemental source ---------------------------------------------
  let supplemental = findOurs(sources, settings.pushDataSourceId)
  let created = false
  if (!supplemental) {
    const createId = await recordChange({
      area: 'live-updates',
      action: 'create-source',
      summary: 'Creating the live updates feed at Merchant Center…',
      before: { dataSourceId: null },
      after: { dataSourceId: null, status: 'sending' },
      createdBy: actor,
    })
    let made: DataSourceDetail | null
    try {
      made = await createSupplementalDataSource(merchantId)
    } catch (error) {
      const message = messageOf(error, 'Google would not create it')
      await amendChange(createId, { summary: `Google would not create the live updates feed: ${message}`, after: { dataSourceId: null, status: 'failed' } })
        .catch((amendError) => console.error(`[google-shopping] could not mark setup ${createId} as failed:`, amendError))
      return { status: 'failed', message: `The live updates feed could not be created: ${message}` }
    }
    if (!made) {
      // Google took the create and its reply could not be read. Something may
      // now exist up there; saying "done" would be a guess, and creating
      // another would be worse.
      await amendChange(createId, {
        summary: 'The live updates feed was created, but Google’s reply could not be read back',
        after: { dataSourceId: null, status: 'pending' },
      }).catch(() => {})
      return {
        status: 'failed',
        message: 'Merchant Center took the request but did not say what it made of it. Press this again in a minute and it will pick up whatever is there.',
      }
    }
    supplemental = made
    created = true
    await recordPushDataSource({ dataSourceId: supplemental.id })
    await amendChange(createId, {
      summary: `Created the live updates feed "${supplemental.displayName || supplemental.id}" at Merchant Center`,
      after: { dataSourceId: supplemental.id, status: 'done' },
    }).catch(() => {})
  } else if (settings.pushDataSourceId !== supplemental.id) {
    // Found by name rather than by the id we held. Record it so the next run
    // does not have to go looking.
    await recordPushDataSource({ dataSourceId: supplemental.id })
  }

  // ---- The link -------------------------------------------------------------
  // Read BEFORE the merge, because linkedRule is about to change the list and
  // the owner's log entry should say which of the two jobs this was: making a
  // connection, or putting one back in front of the feed it was sitting behind.
  const placement = linkPlacement(primary.defaultRule, supplemental.name)
  const nextRule = linkedRule(primary.defaultRule, supplemental.name)
  if (!nextRule) {
    await recordPushDataSource({ dataSourceId: supplemental.id, linkedSourceIds: [primary.id], linkedAt: new Date() })
    return { status: 'ready', dataSourceId: supplemental.id, primaryId: primary.id, created, linked: true, confirmed: true, changeId: null }
  }

  const before: LinkSnapshot = {
    primaryId: primary.id,
    primaryName: primary.displayName || primary.id,
    supplementalName: supplemental.name,
    rule: primary.defaultRule,
  }
  const summary = placement === 'behind'
    ? `Put this site's prices back in front in your main feed "${before.primaryName}", where they had fallen behind the feed itself`
    : `Told your main feed "${before.primaryName}" to take prices and stock from the live updates feed, ahead of everything else it reads`
  const changeId = await recordChange({
    area: 'live-updates',
    action: 'link',
    summary: `${summary} (sending…)`,
    before,
    after: { ...before, rule: nextRule, status: 'sending' } satisfies LinkSnapshot,
    createdBy: actor,
  })

  let written: DataSourceDetail | null
  try {
    written = await writeDefaultRule(merchantId, primary.id, nextRule)
  } catch (error) {
    const message = messageOf(error, 'Google refused it')
    await amendChange(changeId, {
      summary: `${summary} - Google refused it, so nothing was changed`,
      after: { ...before, rule: primary.defaultRule, status: 'failed' } satisfies LinkSnapshot,
    }).catch((amendError) => console.error(`[google-shopping] could not mark link ${changeId} as failed:`, amendError))
    return { status: 'failed', message: `The link could not be made: ${message}` }
  }

  // What Google now holds, in Google's words rather than our prediction of
  // them - the same rule the delivery push follows, and for the same reason:
  // Undo compares the live rule against this snapshot, so anything Google
  // normalises on the way in has to be in it.
  const confirmedRule = written?.defaultRule.length ? written.defaultRule : null
  await recordPushDataSource({ dataSourceId: supplemental.id, linkedSourceIds: [primary.id], linkedAt: new Date() })
  await amendChange(changeId, {
    summary: confirmedRule ? summary : `${summary} - sent, but Google's reply could not be read back`,
    after: { ...before, rule: confirmedRule ?? nextRule, status: confirmedRule ? 'done' : 'pending' } satisfies LinkSnapshot,
  }).catch(() => {})

  return {
    status: 'ready',
    dataSourceId: supplemental.id,
    primaryId: primary.id,
    created,
    linked: true,
    confirmed: confirmedRule !== null,
    changeId,
  }
}

/**
 * Takes the link back out, leaving the supplemental source itself alone.
 *
 * Used by Undo, and by the panel's own "stop sending and unlink" button. The
 * source is deliberately NOT deleted: deleting it would throw away whatever
 * Merchant Center still holds from it in one irreversible step, and an owner
 * who only wanted to pause can link it back in with one press.
 */
export async function unlinkSetup(actor: string | null): Promise<SetupOutcome> {
  const settings = await getGsfSettings()
  if (!hasGoogleCredentials()) return { status: 'blocked', message: 'No Google service-account key has been saved yet.' }
  if (!settings.merchantId) return { status: 'blocked', message: 'Fill in your Merchant Center account number first.' }
  if (!settings.pushDataSourceId) return { status: 'blocked', message: 'There is no live updates feed to unlink.' }
  const merchantId = settings.merchantId

  let sources: DataSourceDetail[]
  try {
    sources = await listDataSourceDetails(merchantId)
  } catch (error) {
    return { status: 'failed', message: `Your Merchant Center data sources could not be read: ${messageOf(error, 'Google did not answer')}` }
  }
  const supplemental = findOurs(sources, settings.pushDataSourceId)
  if (!supplemental) {
    await recordPushDataSource({ dataSourceId: null, linkedSourceIds: [], linkedAt: null })
    return { status: 'blocked', message: 'Merchant Center no longer has a live updates feed for this site, so there was nothing to unlink.' }
  }

  const primaries = sources.filter((source) => source.kind === 'primary' && source.defaultRule.some((entry) => entry.supplementalDataSourceName === supplemental.name))
  if (primaries.length === 0) {
    await recordPushDataSource({ dataSourceId: supplemental.id, linkedSourceIds: [], linkedAt: null })
    return { status: 'ready', dataSourceId: supplemental.id, primaryId: '', created: false, linked: false, confirmed: true, changeId: null }
  }

  let lastChangeId: string | null = null
  let allConfirmed = true
  for (const primary of primaries) {
    const nextRule = unlinkedRule(primary.defaultRule, supplemental.name)
    if (!nextRule) continue
    const before: LinkSnapshot = {
      primaryId: primary.id,
      primaryName: primary.displayName || primary.id,
      supplementalName: supplemental.name,
      rule: primary.defaultRule,
    }
    const summary = `Stopped your main feed "${before.primaryName}" taking prices and stock from the live updates feed`
    const changeId = await recordChange({
      area: 'live-updates',
      action: 'unlink',
      summary: `${summary} (sending…)`,
      before,
      after: { ...before, rule: nextRule, status: 'sending' } satisfies LinkSnapshot,
      createdBy: actor,
    })
    lastChangeId = changeId
    let written: DataSourceDetail | null
    try {
      written = await writeDefaultRule(merchantId, primary.id, nextRule)
    } catch (error) {
      const message = messageOf(error, 'Google refused it')
      await amendChange(changeId, {
        summary: `${summary} - Google refused it, so nothing was changed`,
        after: { ...before, rule: primary.defaultRule, status: 'failed' } satisfies LinkSnapshot,
      }).catch(() => {})
      return { status: 'failed', message: `The link could not be taken out: ${message}` }
    }
    const confirmedRule = written?.defaultRule.length ? written.defaultRule : null
    if (!confirmedRule) allConfirmed = false
    await amendChange(changeId, {
      summary: confirmedRule ? summary : `${summary} - sent, but Google's reply could not be read back`,
      after: { ...before, rule: confirmedRule ?? nextRule, status: confirmedRule ? 'done' : 'pending' } satisfies LinkSnapshot,
    }).catch(() => {})
  }

  await recordPushDataSource({ dataSourceId: supplemental.id, linkedSourceIds: [], linkedAt: null })
  return {
    status: 'ready',
    dataSourceId: supplemental.id,
    primaryId: primaries[0]?.id ?? '',
    created: false,
    linked: false,
    confirmed: allConfirmed,
    changeId: lastChangeId,
  }
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

function readLinkSnapshot(value: unknown): LinkSnapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (typeof row.primaryId !== 'string' || typeof row.supplementalName !== 'string') return null
  if (!Array.isArray(row.rule)) return null
  return {
    primaryId: row.primaryId,
    primaryName: typeof row.primaryName === 'string' ? row.primaryName : row.primaryId,
    supplementalName: row.supplementalName,
    rule: row.rule as RuleReference[],
    ...(typeof row.status === 'string' ? { status: row.status as LinkSnapshot['status'] } : {}),
  }
}

const NOT_RESTORABLE =
  'A price already sent to Google cannot be unsent. The next send puts whatever this site now says back in front of shoppers, '
  + 'and the Undo button on this entry would only pretend otherwise.'

/**
 * Puts a link (or an unlink) back.
 *
 * Refuses rather than guesses in three cases, each of which has cost somebody
 * an afternoon elsewhere in this module:
 *   - the entry never got its confirmation, so nothing here knows what Google
 *     ended up holding;
 *   - Merchant Center's rule is no longer the one this entry left behind, so
 *     somebody has been in since and overwriting them would be worse than
 *     doing nothing;
 *   - the entry is a send of prices, which cannot be unsent at all.
 *
 * The comparison is canonicalJson, never JSON.stringify of the raw values:
 * Postgres hands jsonb keys back in its own order, so two snapshots of the same
 * rule compare unequal on a plain stringify.
 */
async function undoLiveUpdates(context: UndoContext): Promise<UndoResult> {
  const { entry } = context

  if (entry.action !== 'link' && entry.action !== 'unlink') {
    return { restored: 0, skipped: 1, summary: NOT_RESTORABLE }
  }

  const before = readLinkSnapshot(entry.before)
  const after = readLinkSnapshot(entry.after)
  if (!before || !after) return { restored: 0, skipped: 1, summary: 'This entry was written by a different version and cannot be read back.' }
  if (after.status === 'failed') return { restored: 0, skipped: 1, summary: 'That change never went through, so there is nothing to undo.' }
  if (after.status !== 'done') {
    return { restored: 0, skipped: 1, summary: 'Google never confirmed that change, so nothing here knows what it ended up holding. Compare the two first.' }
  }

  const settings = await getGsfSettings()
  if (!settings.merchantId) return { restored: 0, skipped: 1, summary: 'Your Merchant Center account number is no longer filled in.' }

  const live = await readDataSourceDetail(settings.merchantId, before.primaryId).catch(() => null)
  if (!live) return { restored: 0, skipped: 1, summary: 'That feed could not be read at Merchant Center, so nothing has been changed.' }
  if (canonicalJson(live.defaultRule) !== canonicalJson(after.rule)) {
    return {
      restored: 0,
      skipped: 1,
      summary: 'Your main feed has been changed at Merchant Center since this happened, so nothing has been put back. Have a look at it there first.',
    }
  }

  const written = await writeDefaultRule(settings.merchantId, before.primaryId, before.rule)
  const stillLinked = (written?.defaultRule ?? before.rule).some((reference) => reference.supplementalDataSourceName === before.supplementalName)
  await recordPushDataSource({
    dataSourceId: settings.pushDataSourceId,
    linkedSourceIds: stillLinked ? [before.primaryId] : [],
    linkedAt: stillLinked ? new Date() : null,
  })

  return {
    restored: 1,
    skipped: 0,
    summary: entry.action === 'link'
      ? `Stopped your main feed "${before.primaryName}" taking prices and stock from the live updates feed`
      : `Put your main feed "${before.primaryName}" back to taking prices and stock from the live updates feed`,
  }
}

registerUndoHandler('live-updates', undoLiveUpdates)
