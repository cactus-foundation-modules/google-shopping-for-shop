// Telling Google Ads which of its clicks turned into a sale.
//
// This is the only thing in the module that sends a shopper's Google click
// identifier back to Google, so it is worth reading the guards before the code:
//
//  1. CONSENT IS CHECKED AT THE MOMENT OF SENDING, not at the moment of the
//     landing. The eligibility query (lib/google-ads/store.ts) reads the
//     consent flag and the click identifier out of gsf_click_events on every
//     run, and withdrawing marketing consent clears both in one transaction.
//     A shopper who withdrew an hour ago simply is not in the list.
//
//  2. NO CLICK IDENTIFIER IS EVER COPIED. It is read from the landing row when
//     the conversion is built and is not written into our own upload table, so
//     erasing it really does erase it. The upload row records that Google has
//     been told about the order and nothing about whose visit it was.
//
//  3. THE CONVERSION ACTION MUST BE SECONDARY, AND GOOGLE MUST HAVE SAID SO
//     THIS RUN. The google-tag module already reports Google Ads conversions
//     from the shopper's browser. If this one were primary too, every ad sale
//     would be counted twice and the account would bid on the doubled figure.
//     So every run asks Google again (verifyConversionAction below) before it
//     sends anything: the answer recorded when the tracker was set up says
//     nothing about what somebody changed in the Google Ads screens a week
//     later, and an owner who marks it primary over there would otherwise go on
//     being double-counted for ever with nothing to say so.
//
//     THE ONE THING THAT CHECK CANNOT SEE: a CUSTOM CONVERSION GOAL. Google's
//     own conversion_action.proto says "custom conversion goals do not respect
//     primary_for_goal, so if a campaign has a custom conversion goal
//     configured with a primary_for_goal = false conversion action, that
//     conversion action is still biddable". There is no field on the action
//     that reveals it, so secondary is not an unconditional guarantee and
//     nothing here pretends otherwise: the screens and the wiki say plainly
//     that this tracker must not be put in a custom conversion goal.
//
//  4. NOTHING IS CLAIMED THAT GOOGLE DID NOT CONFIRM. A row Google did not
//     answer for is recorded as refused, never as sent.
//
// On retrying: `order_id` is Google's own dedupe key - its reference says "an
// order id can only be used for one conversion per conversion action" - so
// sending the same order twice leaves Google in the state one send would have,
// and a duplicate complaint is read here as proof it already landed. That is
// what makes a retry safe.
//
// NOTHING HERE HAS BEEN RUN AGAINST A REAL GOOGLE ADS ACCOUNT. There is no
// access to one on the machine it was written on. Every field name, enum and
// path was checked against Google's published reference for v25.
import { getGsfSettings, recordAdsConversionAction } from '@/modules/google-shopping-for-shop/lib/settings'
import { googleAdsCredentialsFromEnv } from '@/modules/google-shopping-for-shop/lib/google-ads/credentials'
import { adsRequest } from '@/modules/google-shopping-for-shop/lib/google-ads/client'
import { readConversionAction } from '@/modules/google-shopping-for-shop/lib/google-ads/conversion-action'
import { GoogleAdsApiError, parseAdsFailure, type AdsFailureItem } from '@/modules/google-shopping-for-shop/lib/google-ads/errors'
import {
  ADS_SKIP_COPY,
  NOT_ALLOWLISTED,
  PROJECT_NOT_APPROVED,
  isAccountWideCode,
  isUploadableClickIdKind,
  type AdsSkipReason,
  type ClickConversionBody,
  type UploadClickConversionsBody,
} from '@/modules/google-shopping-for-shop/lib/google-ads/types'
import {
  claimAdsRun,
  countUploadableOrders,
  readUploadTotals,
  readUploadableOrders,
  recordUploadOutcome,
  releaseAdsRun,
  abandonAdsRun,
  type UploadableOrder,
} from '@/modules/google-shopping-for-shop/lib/google-ads/store'
import { ALERT_KEYS, isAlertUp, setAdsUploadAlert } from '@/modules/google-shopping-for-shop/lib/health/alerts'
import { recordChange } from '@/modules/google-shopping-for-shop/lib/change-log'

/** Sales in one request to Google. Google takes far more than this; the cap is
 *  here so one refusal costs one modest batch rather than the whole run, and so
 *  the wall-clock check below happens often enough to mean something. */
const BATCH_SIZE = 100

/** Sales taken off the waiting list in one run. */
const MAX_PER_RUN = 500

/** How long a run keeps sending before it leaves the rest for next time. A
 *  module route has sixty seconds in total. */
const BUDGET_MS = 30_000

/**
 * How long the last answer about the tracker may be leaned on when Google
 * cannot be reached to ask again.
 *
 * The run asks every time. This is only the fallback for the run that could not
 * ask at all - a rate limit, a network wobble - and it is short on purpose: the
 * upload goes hourly, so a day's grace is two dozen chances to get a fresh
 * answer, and past that the honest thing is to stop sending rather than to keep
 * sending on the strength of something nobody has checked since yesterday.
 */
export const ACTION_TRUST_WINDOW_MS = 24 * 60 * 60 * 1000

/** How many times a refused sale is offered to Google again before it is left
 *  alone. Most refusals are permanent - the click was too old, or was never an
 *  ad click - and offering them for ever would crowd out the new ones. */
export const MAX_UPLOAD_ATTEMPTS = 3

/**
 * An instant as Google's `conversionDateTime`.
 *
 * Google's reference: "The timezone must be specified, and the format must be
 * `yyyy-mm-dd HH:mm:ss+|-HH:mm`". Rendered in UTC with an explicit +00:00
 * offset, which names the same instant as any other zone would and needs
 * nothing to be known about the account's own timezone - one less thing to get
 * wrong, and one less thing to be silently wrong about twice a year when the
 * clocks go back.
 */
export function conversionDateTime(instant: Date): string {
  const iso = instant.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}+00:00`
}

/**
 * One sale as a ClickConversion, or a refusal to build one.
 *
 * Pure, and exported, because it is the whole request shape and the only way to
 * test it without a Google Ads account.
 *
 * The two refusals:
 *   - a click identifier we may not upload. `srsltid` is the one that matters:
 *     Google appends it to free Shopping clicks as well as to ads, ClickConversion
 *     has no field for it, and stage 5 already counts a bare one as free.
 *   - a conversion earlier than the click. Google's reference says the
 *     conversion time "must be after the click time", so such a row would be
 *     refused anyway - and sending a time we know to be wrong, or quietly
 *     nudging it forward, would be inventing data to get past a validation.
 */
export function buildClickConversion(input: {
  order: UploadableOrder
  conversionAction: string
}): { ok: true; conversion: ClickConversionBody } | { ok: false; reason: string } {
  const { order } = input
  if (!isUploadableClickIdKind(order.clickIdKind)) {
    return { ok: false, reason: 'That visit did not carry a Google Ads click, so there is nothing for Google to match it to.' }
  }
  if (order.confirmedAt.getTime() < order.landedAt.getTime()) {
    return {
      ok: false,
      reason: 'The payment is recorded as having settled before the visit it is credited to, which Google will not accept. '
        + 'Nothing has been sent for this one.',
    }
  }
  const value = Number(order.value)
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, reason: 'That order has no readable total, so there is no value to report.' }
  }
  return {
    ok: true,
    conversion: {
      conversionAction: input.conversionAction,
      conversionDateTime: conversionDateTime(order.confirmedAt),
      conversionValue: value,
      currencyCode: order.currency.toUpperCase(),
      // Google's own dedupe key, and ours. Belt and braces by construction.
      orderId: order.orderId,
      // Only `adUserData`. Google's reference for Consent says `adPersonalization`
      // "can only be set for OfflineUserDataJobService and UserDataService",
      // and every one of its own samples for this call sets the one field.
      // GRANTED without a condition because a shopper who had not granted it
      // has no stored click identifier at all - the eligibility query could not
      // have returned this row.
      consent: { adUserData: 'GRANTED' },
      [order.clickIdKind]: order.clickId,
    } as ClickConversionBody,
  }
}

/** Google's answer for one operation in the batch. */
type BatchVerdict =
  | { kind: 'uploaded' }
  | { kind: 'refused'; message: string; code: string | null; accountWide: boolean }

/**
 * What Google said about each sale in the batch.
 *
 * Positional: `results[i]` belongs to `conversions[i]`, and Google's reference
 * says the entry is "empty for rows that received an error". The complaints
 * live in `partialFailureError`, each carrying the index of the operation it is
 * about - or no index at all, which means the complaint is about the request as
 * a whole and every sale in it went nowhere.
 *
 * Pure and exported: this is the part most likely to be wrong, and the only way
 * to be sure of it without an account is to put Google's documented shapes
 * through it.
 */
export function readBatchVerdicts(reply: unknown, count: number): BatchVerdict[] {
  const body = typeof reply === 'object' && reply !== null ? reply as Record<string, unknown> : {}
  const results = Array.isArray(body.results) ? body.results : []
  const failures: AdsFailureItem[] = body.partialFailureError === undefined
    ? []
    : parseAdsFailure({ error: body.partialFailureError })

  const perRow = new Map<number, AdsFailureItem>()
  const wholeRequest: AdsFailureItem[] = []
  for (const failure of failures) {
    if (failure.operationIndex >= 0) {
      // First complaint per row wins: Google can send several about one
      // operation and the first is the one that names the cause.
      if (!perRow.has(failure.operationIndex)) perRow.set(failure.operationIndex, failure)
    } else {
      wholeRequest.push(failure)
    }
  }

  const verdicts: BatchVerdict[] = []
  for (let index = 0; index < count; index++) {
    const complaint = perRow.get(index) ?? wholeRequest[0]
    if (complaint) {
      const code = complaint.code?.toUpperCase() ?? null
      // Google already holds this order against this action. Which is to say:
      // it landed. Recording it as a failure would have the run offer it again
      // for ever and report a problem that does not exist.
      if (code === 'DUPLICATE_ORDER_ID' || code === 'ORDER_ID_ALREADY_IN_USE') {
        verdicts.push({ kind: 'uploaded' })
        continue
      }
      verdicts.push({
        kind: 'refused',
        message: complaint.message,
        code,
        accountWide: perRow.has(index) ? isAccountWideCode(code) : true,
      })
      continue
    }
    const result = results[index]
    const answered = typeof result === 'object' && result !== null && Object.keys(result as object).length > 0
    if (answered) {
      verdicts.push({ kind: 'uploaded' })
      continue
    }
    // No complaint and no answer. Never counted as sent: the one figure on the
    // screen that is supposed to mean "Google has this" would stop meaning it.
    verdicts.push({
      kind: 'refused',
      message: 'Google accepted the request but did not say what became of this sale, so it has not been counted as sent.',
      code: null,
      accountWide: false,
    })
  }
  return verdicts
}

export type UploadSummary = {
  status: 'ok' | 'part' | 'failed'
  uploaded: number
  /** Google refused them. Tried again on a later run, up to the cap. */
  failed: number
  /** This site declined to send them, and will not try again. */
  skipped: number
  /** Still waiting when the run stopped, because the budget ran out. */
  leftWaiting: number
  message?: string
  /** Set when Google refused the whole account rather than a sale: nothing
   *  will get through until somebody does something about it. */
  blockedCode?: string
}

export type UploadOutcome =
  | { status: 'ran'; summary: UploadSummary }
  | { status: 'skipped'; reason: AdsSkipReason; message: string }

export type UploadRunOptions = {
  /** Who pressed the button, for the change log. Null for the cron. */
  actor?: string | null
  budgetMs?: number
  now?: () => number
  attempts?: number
  retryBaseMs?: number
}

function skipped(reason: AdsSkipReason): UploadOutcome {
  return { status: 'skipped', reason, message: ADS_SKIP_COPY[reason] }
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof GoogleAdsApiError) return error.message
  return error instanceof Error ? error.message : fallback
}

/**
 * Plain English for the two refusals an owner can actually do something about.
 *
 * Both are about permission rather than about a sale, and both are likely: the
 * first is what a Google Cloud project that has never uploaded an offline
 * conversion gets, which is every new connection since Google restricted the
 * feature in June 2026.
 */
export function explainBlock(code: string | null, googlesWords: string): string {
  if (code === NOT_ALLOWLISTED) {
    return 'Google will not accept imported sales from this connection. Since 15 June 2026 it only accepts them from connections '
      + 'that were already sending them before that date, and points everyone else at its separate Data Manager service. '
      + 'Everything else on this tab carries on as normal - only the sending of sales is affected.'
  }
  if (code === PROJECT_NOT_APPROVED) {
    return 'The Google Cloud project behind your Google Ads sign-in only has test access, so Google will not let it touch a real '
      + 'advertising account. Apply for access on that project’s Google Ads API page and this can start.'
  }
  return googlesWords
}

/**
 * Asks Google, now, whether the tracker is still one we may send to.
 *
 * Separated out and exported so the decision can be tested without a run around
 * it, because it is the safeguard rather than a detail of one.
 *
 * Four answers, and only the first sends anything:
 *   secondary          Google says primary_for_goal is false. Recorded, and go.
 *   action-is-primary  Google says it is true. Recorded, and stop.
 *   action-missing     Google has never heard of it - deleted over there.
 *   action-unchecked   Google answered without the field, so nobody knows.
 *   action-stale       Google could not be asked at all, and the last answer is
 *                      older than ACTION_TRUST_WINDOW_MS.
 *
 * A read that FAILS falls back to the stored answer while it is fresh, which is
 * what stops a rate limit from stopping a shop's reporting - but the fallback
 * is time-limited, and a stored `true` or `null` still refuses whatever its
 * age. The fallback can only ever let through an answer Google itself gave
 * recently.
 */
export async function verifyConversionAction(input: {
  customerId: string
  resourceName: string
  stored: { primary: boolean | null; checkedAt: Date | null }
  options?: { attempts?: number; retryBaseMs?: number }
  now?: () => number
}): Promise<{ status: 'secondary' | 'action-is-primary' | 'action-missing' | 'action-unchecked' | 'action-stale' }> {
  const now = input.now ?? (() => Date.now())
  let primary = input.stored.primary
  try {
    const action = await readConversionAction(input.customerId, input.resourceName, input.options ?? {})
    if (!action) {
      // Google no longer has it. Forget it on our side too, so the panel says
      // "not set up" rather than naming something that does not exist.
      await recordAdsConversionAction({ resourceName: null, name: null, primary: null, checkedAt: new Date(now()) })
      return { status: 'action-missing' }
    }
    primary = action.primaryForGoal
    await recordAdsConversionAction({
      resourceName: action.resourceName,
      name: action.name,
      primary: action.primaryForGoal,
      checkedAt: new Date(now()),
    })
  } catch (error) {
    // Could not ask. Everything below leans on what was last recorded, and only
    // while that is recent enough to mean anything.
    console.error('[google-shopping] could not re-check the Google Ads tracker:', error)
    const checkedAt = input.stored.checkedAt
    if (checkedAt === null || now() - checkedAt.getTime() > ACTION_TRUST_WINDOW_MS) return { status: 'action-stale' }
  }
  if (primary === true) return { status: 'action-is-primary' }
  if (primary === null) return { status: 'action-unchecked' }
  return { status: 'secondary' }
}

/**
 * Sends every confirmed, consented, paid sale Google Ads has not been told
 * about.
 *
 * Never throws for an ordinary refusal: everything comes back as an outcome, so
 * the cron does not lose its other jobs to this one.
 */
export async function runConversionUpload(options: UploadRunOptions = {}): Promise<UploadOutcome> {
  const settings = await getGsfSettings()

  // ---- The ways out that are nobody's fault --------------------------------
  // Every one of them takes the notice DOWN. A notice raised by yesterday's
  // failure and left up because the owner switched the feature off is a notice
  // about something that is no longer happening.
  if (!settings.adsEnabled) {
    await setAdsUploadAlert({ failed: false })
    return skipped('off')
  }
  if (!settings.adsConversionUploadEnabled) {
    await setAdsUploadAlert({ failed: false })
    return skipped('upload-off')
  }

  // ---- The ways out that ARE worth a notice --------------------------------
  // Switched on and unable to run is a problem: the owner believes their sales
  // are reaching Google Ads and they are not.
  const alreadyUp = await isAlertUp(ALERT_KEYS.adsUpload)
  const refuse = async (reason: AdsSkipReason): Promise<UploadOutcome> => {
    await setAdsUploadAlert({ failed: true, message: ADS_SKIP_COPY[reason], alreadyUp })
    return skipped(reason)
  }
  const credentials = googleAdsCredentialsFromEnv()
  if (!credentials) return refuse('no-credentials')
  if (!settings.adsConversionAction) return refuse('no-conversion-action')

  const waiting = await countUploadableOrders(MAX_UPLOAD_ATTEMPTS)
  if (waiting === 0) {
    // Nothing waiting is a healthy state, and takes the notice down - a refused
    // sale that has used up its attempts is not "waiting", and leaving a notice
    // up about it for ever would make the bell useless.
    //
    // Checked BEFORE the tracker is verified below, deliberately: a shop with
    // nothing to send cannot double-count anything, and asking Google an
    // unnecessary question every hour on every quiet install is a quota bill
    // nobody agreed to. The verification happens on every run that would
    // actually send.
    await setAdsUploadAlert({ failed: false })
    return skipped('nothing-to-do')
  }

  // ---- Is the tracker STILL secondary? -------------------------------------
  // Asked of Google now, not read out of our own row. See the note at the top.
  const verified = await verifyConversionAction({
    customerId: credentials.customerId,
    resourceName: settings.adsConversionAction,
    stored: { primary: settings.adsConversionActionPrimary, checkedAt: settings.adsConversionActionCheckedAt },
    options: { ...(options.attempts === undefined ? {} : { attempts: options.attempts }), ...(options.retryBaseMs === undefined ? {} : { retryBaseMs: options.retryBaseMs }) },
  })
  if (verified.status !== 'secondary') return refuse(verified.status)

  // ---- The slot ------------------------------------------------------------
  // No alert change on this branch: another run holds the slot, and whatever it
  // finds is its news to report.
  if (!await claimAdsRun()) return skipped('already-running')

  const conversionAction = settings.adsConversionAction
  const clock = options.now ?? (() => Date.now())
  const deadline = clock() + (options.budgetMs ?? BUDGET_MS)
  const request = {
    ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
    ...(options.retryBaseMs === undefined ? {} : { retryBaseMs: options.retryBaseMs }),
  }

  let uploaded = 0
  let failed = 0
  let skippedCount = 0
  let blockedCode: string | undefined
  let firstProblem: string | undefined

  try {
    let taken = 0
    while (taken < MAX_PER_RUN && clock() < deadline && blockedCode === undefined) {
      const batch = await readUploadableOrders(Math.min(BATCH_SIZE, MAX_PER_RUN - taken), MAX_UPLOAD_ATTEMPTS)
      if (batch.length === 0) break
      taken += batch.length

      // Built first, so the ones this site declines to send never reach Google
      // and are recorded with the reason rather than with Google's complaint
      // about a request we knew was wrong.
      const sending: UploadableOrder[] = []
      const conversions: ClickConversionBody[] = []
      for (const order of batch) {
        const built = buildClickConversion({ order, conversionAction })
        if (!built.ok) {
          skippedCount++
          if (firstProblem === undefined) firstProblem = built.reason
          await recordUploadOutcome({
            orderId: order.orderId,
            orderNumber: order.orderNumber,
            clickEventId: order.clickEventId,
            status: 'skipped',
            conversionAction,
            conversionDateTime: null,
            value: order.value,
            currency: order.currency,
            clickIdKind: order.clickIdKind,
            message: built.reason,
            errorCode: null,
          })
          continue
        }
        sending.push(order)
        conversions.push(built.conversion)
      }
      if (sending.length === 0) continue

      const body: UploadClickConversionsBody = {
        conversions,
        // Google's own reference: "This should always be set to true." Without
        // it, one unrecognised click throws away the whole batch.
        partialFailure: true,
      }

      let verdicts: BatchVerdict[]
      try {
        const reply = await adsRequest<unknown>(`customers/${credentials.customerId}:uploadClickConversions`, {
          ...request,
          body,
        })
        verdicts = readBatchVerdicts(reply, sending.length)
      } catch (error) {
        // The request itself was refused, so none of these sales went anywhere.
        const code = error instanceof GoogleAdsApiError ? error.code : null
        const message = messageOf(error, 'Google Ads refused the upload')
        verdicts = sending.map(() => ({ kind: 'refused' as const, message, code, accountWide: true }))
      }

      for (let index = 0; index < sending.length; index++) {
        const order = sending[index]
        const verdict = verdicts[index]
        if (!order || !verdict) continue
        if (verdict.kind === 'uploaded') {
          uploaded++
          await recordUploadOutcome({
            orderId: order.orderId,
            orderNumber: order.orderNumber,
            clickEventId: order.clickEventId,
            status: 'uploaded',
            conversionAction,
            conversionDateTime: conversions[index]?.conversionDateTime ?? null,
            value: order.value,
            currency: order.currency,
            clickIdKind: order.clickIdKind,
          })
          continue
        }
        failed++
        const words = explainBlock(verdict.code, verdict.message)
        if (firstProblem === undefined) firstProblem = words
        if (verdict.accountWide && blockedCode === undefined) blockedCode = verdict.code ?? 'UNKNOWN'
        await recordUploadOutcome({
          orderId: order.orderId,
          orderNumber: order.orderNumber,
          clickEventId: order.clickEventId,
          status: 'refused',
          conversionAction,
          conversionDateTime: conversions[index]?.conversionDateTime ?? null,
          value: order.value,
          currency: order.currency,
          clickIdKind: order.clickIdKind,
          message: words,
          errorCode: verdict.code,
        })
      }
    }
  } catch (error) {
    // Whatever went wrong, the slot has to go back or nothing runs for five
    // minutes. The stamp records a FAILURE rather than being left alone, so no
    // screen can read the run before this one as though it were this one.
    const message = messageOf(error, 'The upload did not finish')
    const summary: UploadSummary = {
      status: 'failed', uploaded, failed, skipped: skippedCount, leftWaiting: waiting - uploaded - failed - skippedCount, message,
    }
    await releaseAdsRun({ status: 'failed', uploaded, failed, skipped: skippedCount, message })
      .catch((stampError) => console.error('[google-shopping] could not stamp the failed Google Ads upload:', stampError))
    await setAdsUploadAlert({ failed: true, message, alreadyUp }).catch(() => {})
    return { status: 'ran', summary }
  }

  const leftWaiting = await countUploadableOrders(MAX_UPLOAD_ATTEMPTS)
  const status: UploadSummary['status'] = failed === 0 ? 'ok' : uploaded > 0 ? 'part' : 'failed'
  const summary: UploadSummary = {
    status,
    uploaded,
    failed,
    skipped: skippedCount,
    leftWaiting,
    ...(firstProblem === undefined ? {} : { message: firstProblem }),
    ...(blockedCode === undefined ? {} : { blockedCode }),
  }

  if (uploaded === 0 && failed === 0 && skippedCount === 0) {
    // Nothing happened after all - another run got there first between the
    // count and the claim. Let the slot go without overwriting the last real
    // run's figures with zeroes.
    await abandonAdsRun()
  } else {
    await releaseAdsRun({
      status,
      uploaded,
      failed,
      skipped: skippedCount,
      ...(firstProblem === undefined ? {} : { message: firstProblem }),
    })
  }

  // Raised or cleared from what the TABLE says rather than from this run's own
  // figures, so a clean run cannot take down a notice about the two hundred
  // sales still sitting refused from yesterday.
  const totals = await readUploadTotals()
  await setAdsUploadAlert(
    totals.refused === 0
      ? { failed: false }
      : { failed: true, items: totals.refused, alreadyUp, ...(firstProblem === undefined ? {} : { message: firstProblem }) },
  )

  if (uploaded > 0 || failed > 0 || skippedCount > 0) {
    // One entry per run that did something. A run that found nothing writes
    // nothing: the log is for changes, and "nothing changed" is not one.
    await recordChange({
      area: 'google-ads',
      action: 'upload',
      summary: describeUpload(summary),
      before: null,
      after: summary,
      createdBy: options.actor ?? null,
    }).catch((error) => console.error('[google-shopping] could not record the Google Ads upload:', error))
  }

  return { status: 'ran', summary }
}

/** The run in a sentence, for the change log. */
export function describeUpload(summary: UploadSummary): string {
  const parts: string[] = []
  if (summary.uploaded > 0) {
    parts.push(`Told Google Ads about ${summary.uploaded === 1 ? '1 sale' : `${summary.uploaded.toLocaleString('en-GB')} sales`}`)
  }
  if (summary.failed > 0) {
    parts.push(`${summary.failed === 1 ? '1 was' : `${summary.failed.toLocaleString('en-GB')} were`} refused`)
  }
  if (summary.skipped > 0) {
    parts.push(`${summary.skipped === 1 ? '1 was' : `${summary.skipped.toLocaleString('en-GB')} were`} left out`)
  }
  if (parts.length === 0) return 'Nothing needed sending to Google Ads'
  return `${parts.join(', ')}.`
}
