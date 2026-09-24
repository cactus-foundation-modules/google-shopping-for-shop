// Finding, or making, the thing at Google Ads that this site's sales are
// reported against - and making sure it is a SECONDARY one.
//
// Why secondary is the whole point of this file:
//
//   The google-tag module already reports Google Ads conversions from the
//   shopper's browser, on the order confirmation page, against whatever
//   conversion action that account's tag is wired to. If this site ALSO
//   reported the same sale against a primary action, Google would count it
//   twice: once from the browser and once from here. The account would then
//   bid on a doubled figure, which is real money spent on a wrong number.
//
//   Google's own word for "not biddable" is `primary_for_goal = false`. So the
//   action is created with it false, it is READ BACK from Google afterwards,
//   and the upload refuses to send anything unless Google itself has said
//   false - on that run, not at some point in the past. Our intention is not
//   evidence; Google's answer is.
//
//   AND ONE THING SECONDARY DOES NOT COVER. Google's own conversion_action.proto
//   is explicit: "custom conversion goals do not respect primary_for_goal, so if
//   a campaign has a custom conversion goal configured with a
//   primary_for_goal = false conversion action, that conversion action is still
//   biddable." Nothing on the action itself reveals which goals it has been put
//   in, so this cannot be checked from here, and pretending otherwise would be
//   worse than saying so. The panel and the wiki both say it plainly: do not
//   put this tracker in a custom conversion goal. Detecting it is not attempted.
//
// Nothing here has been run against a real Google Ads account. Every field,
// enum and path was checked against Google's published reference for v25 on
// 2026-09-23:
//   conversion_action.type            UPLOAD_CLICKS   ("Import from clicks")
//   conversion_action.category        PURCHASE
//   conversion_action.status          ENABLED
//   conversion_action.primary_for_goal  optional bool, settable on create
//   conversion_action.counting_type   MANY_PER_CLICK
//   POST /v25/customers/{id}/conversionActions:mutate
import { adsRequest, searchAds } from '@/modules/google-shopping-for-shop/lib/google-ads/client'
import {
  ADS_CONVERSION_ACTIONS_QUERY,
  adsConversionActionQuery,
} from '@/modules/google-shopping-for-shop/lib/google-ads/query'
import {
  parseAdsConversionAction,
  parseMutateResourceName,
  type AdsConversionAction,
} from '@/modules/google-shopping-for-shop/lib/google-ads/parse'

/**
 * The name this module gives the conversion action it creates.
 *
 * Stable, because it is also how a second press of "Set it up" finds the one
 * from the first press rather than making another. Generic on purpose - this
 * ships to every install - and worded so it is recognisable in the Google Ads
 * screens beside whatever else the account already has.
 */
export const MANAGED_ACTION_NAME = 'Website sales (imported from this site)'

/** One retry and no more on these: an owner pressed a button and is watching. */
const SETUP_ATTEMPTS = 2

export type ConversionActionOutcome =
  | { status: 'ready'; action: AdsConversionAction; created: boolean; madeSecondary: boolean }
  /** Google answered, and what it holds is not something we may upload against.
   *  The reason is a sentence, not a code. */
  | { status: 'unusable'; action: AdsConversionAction; reason: string }

type ProbeOptions = { attempts?: number; retryBaseMs?: number }

function requestOptions(options: ProbeOptions): ProbeOptions {
  return {
    attempts: options.attempts ?? SETUP_ATTEMPTS,
    ...(options.retryBaseMs === undefined ? {} : { retryBaseMs: options.retryBaseMs }),
  }
}

/** Every enabled "Import from clicks" action on the account. */
export async function listUploadConversionActions(
  customerId: string,
  options: ProbeOptions = {},
): Promise<AdsConversionAction[]> {
  const rows = await searchAds(customerId, ADS_CONVERSION_ACTIONS_QUERY, requestOptions(options))
  const actions: AdsConversionAction[] = []
  for (const row of rows) {
    const action = parseAdsConversionAction(row)
    if (action) actions.push(action)
  }
  return actions
}

/** One action, read back by name. Null when Google no longer has it - which is
 *  what an owner deleting it in the Google Ads screens looks like from here. */
export async function readConversionAction(
  customerId: string,
  resourceName: string,
  options: ProbeOptions = {},
): Promise<AdsConversionAction | null> {
  const rows = await searchAds(customerId, adsConversionActionQuery(resourceName), requestOptions(options))
  const first = rows[0]
  return first ? parseAdsConversionAction(first) : null
}

/** Turns one action secondary. A separate update rather than part of the
 *  create, because `primary_for_goal` has a history of being settable only
 *  afterwards, and an update that is a no-op costs one call and removes the
 *  question entirely. */
async function makeSecondary(customerId: string, resourceName: string, options: ProbeOptions): Promise<void> {
  await adsRequest(`customers/${customerId}/conversionActions:mutate`, {
    ...requestOptions(options),
    body: {
      operations: [{
        update: { resourceName, primaryForGoal: false },
        // Only this one field. A field mask naming more would have Google clear
        // everything else on the action back to its default.
        updateMask: 'primary_for_goal',
      }],
      partialFailure: false,
    },
  })
}

async function createAction(customerId: string, options: ProbeOptions): Promise<string | null> {
  const reply = await adsRequest<unknown>(`customers/${customerId}/conversionActions:mutate`, {
    ...requestOptions(options),
    body: {
      operations: [{
        create: {
          name: MANAGED_ACTION_NAME,
          // Google's enum for what its own screens call "Import from clicks".
          type: 'UPLOAD_CLICKS',
          category: 'PURCHASE',
          status: 'ENABLED',
          // Secondary from birth. Read back below rather than trusted.
          primaryForGoal: false,
          // Every purchase counts, not just the first after a click: a shopper
          // who comes back through the same ad and buys again has bought twice.
          // Sending the order id with each one is what stops the SAME sale
          // being counted twice, and that is Google's own dedupe rather than
          // ours.
          countingType: 'MANY_PER_CLICK',
        },
      }],
      // One operation, and it either works or it does not. Partial failure is
      // for batches.
      partialFailure: false,
    },
  })
  return parseMutateResourceName(reply)
}

/**
 * The conversion action to upload against, made if it does not exist.
 *
 * Run from the "Set it up" button and from nothing else - it writes to the
 * account, so it is never on a timer and never on a page load.
 *
 * The order of it:
 *   1. Read what the account already has.
 *   2. Reuse the one already recorded, if Google still has it.
 *   3. Otherwise reuse one this module made earlier, found by its name.
 *   4. Otherwise make one.
 *   5. If Google says it is primary, turn it secondary and READ IT BACK.
 *   6. Answer with whatever Google last said, never with what we asked for.
 */
export async function ensureConversionAction(input: {
  customerId: string
  /** The action already recorded in settings, where there is one. */
  current: string | null
  options?: ProbeOptions
}): Promise<ConversionActionOutcome> {
  const options = input.options ?? {}
  const existing = await listUploadConversionActions(input.customerId, options)

  let resourceName = input.current !== null && existing.some((action) => action.resourceName === input.current)
    ? input.current
    : existing.find((action) => action.name === MANAGED_ACTION_NAME)?.resourceName ?? null

  let created = false
  if (resourceName === null) {
    resourceName = await createAction(input.customerId, options)
    created = true
    if (resourceName === null) {
      // Google took the create and answered with something we could not read.
      // The action may well exist; saying it does on that basis is exactly the
      // claim this module refuses to make. The next press finds it by name.
      throw new Error(
        'Google accepted the request but did not say what it made. Press "Set it up" again in a moment - '
        + 'it will find whatever was created rather than making a second one.',
      )
    }
  }

  let action = await readConversionAction(input.customerId, resourceName, options)
  if (!action) {
    throw new Error('Google would not tell us about the sales tracker it just reported. Try again in a moment.')
  }

  // Everything below is Google's answer, not our intention.
  //
  // The two shape questions come FIRST, before anything is written: turning a
  // tracker secondary that we are about to report as unusable anyway is a write
  // to somebody's advertising account for no reason at all.
  if (action.type !== 'UPLOAD_CLICKS') {
    return {
      status: 'unusable',
      action,
      reason: 'That tracker at Google Ads is not the "Import from clicks" kind, so sales from this site cannot be sent to it.',
    }
  }
  if (action.status !== 'ENABLED') {
    return {
      status: 'unusable',
      action,
      reason: 'That tracker is switched off at Google Ads. Turn it back on there, then press this again. '
        + 'Nothing new has been made - this is the one this site was already using.',
    }
  }

  let madeSecondary = false
  if (action.primaryForGoal !== false) {
    await makeSecondary(input.customerId, resourceName, options)
    madeSecondary = true
    action = await readConversionAction(input.customerId, resourceName, options) ?? action
  }

  if (action.primaryForGoal !== false) {
    return {
      status: 'unusable',
      action,
      reason: action.primaryForGoal === true
        ? 'Google still has this tracker set as a PRIMARY one, which would have every sale counted twice - once by the tag in '
          + 'the shopper’s browser and once by this site. Set it to secondary in Google Ads, under Goals, and press this again. '
          + 'Nothing will be sent until it is.'
        : 'Google did not say whether this tracker is primary or secondary, and nothing is sent until it does. Try again in a moment.',
    }
  }

  return { status: 'ready', action, created, madeSecondary }
}
