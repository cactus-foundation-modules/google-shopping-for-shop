// Sending this site's delivery charges to Merchant Center, and putting them
// back again.
//
// The rules this file exists to keep:
//
//   1. Never without being asked, and never something other than what was read.
//      The route takes an explicit confirmation AND a fingerprint of the plan
//      the owner was looking at; a plan that has moved since is refused.
//   2. Never lose somebody else's work. The insert replaces the WHOLE resource,
//      so a push reads what is there, changes only the services this site
//      manages, and copies everything else back byte for byte.
//   3. Never overwrite a change we have not seen. Google's etag comes off the
//      read and goes back on the write; if it has moved, the write is refused
//      and the owner is told to look again, rather than forced through.
//   4. Never a one-way door, and never an unexplained one. The settings as they
//      were are written to the change log BEFORE anything is sent, the entry is
//      amended afterwards with what Google actually came back with, and Undo
//      puts the first back.
//
// On the ordering, which took two goes to get right. Calling Google from
// inside the transaction stopped a log entry existing for a push that never
// happened - but it created the mirror image: a Google write that succeeded
// under a transaction that then failed to commit, leaving a real change at
// Merchant Center with no snapshot and no way back. It also pinned a pooled
// connection across a network call and its retry backoff, inside a route with
// sixty seconds to live.
//
// So the call sits OUTSIDE any transaction, between two short ones: record the
// intent, send, record the outcome. Every way it can fail leaves something
// legible behind -
//   crash before the send      an entry marked 'pending', nothing sent
//   send refused               an entry marked 'failed', nothing changed
//   crash after the send       an entry marked 'pending', change made at Google
// - and 'pending' is exactly the state an owner should look at rather than
// silently undo, which is what the undo handler does with it.
import { prisma } from '@/lib/db/prisma'
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import {
  amendChange,
  listChanges,
  recordChange,
  registerUndoHandler,
  type UndoContext,
  type UndoResult,
} from '@/modules/google-shopping-for-shop/lib/change-log'
import {
  isEtagConflict,
  readShippingSettings,
  writeShippingSettings,
} from '@/modules/google-shopping-for-shop/lib/delivery/merchant'
import { recordPush, readDeliveryState } from '@/modules/google-shopping-for-shop/lib/delivery/state'
import { buildDeliveryPlan } from '@/modules/google-shopping-for-shop/lib/delivery/plan'
import { mergeShippingSettings } from '@/modules/google-shopping-for-shop/lib/delivery/merge'
import { planFingerprint } from '@/modules/google-shopping-for-shop/lib/delivery/fingerprint'
import type { MerchantService, MerchantShippingSettings } from '@/modules/google-shopping-for-shop/lib/delivery/merchant-types'

/** How far a push got. Only 'done' may be undone.
 *
 *  'sending' and 'pending' are BOTH "the outcome is not known", and they are
 *  kept apart because they are not known in the same way: 'sending' is written
 *  before Google is called at all, so the send may never have happened, while
 *  'pending' means it did happen and only the reply was unreadable. Either can
 *  be settled later by looking - see promoteUnconfirmedPush. */
export type PushStatus = 'sending' | 'pending' | 'done' | 'failed'

/** What a push, or an undo of one, put in the change log. */
export type DeliverySnapshot = {
  /** The whole resource as it stood. */
  settings: MerchantShippingSettings
  /** The service names this site owned at that moment. */
  managedServices: string[]
  /** Absent on a `before` snapshot and on entries written by an older build,
   *  which the undo treats as 'done' - that is what they were. */
  status?: PushStatus
}

export type PushOutcome =
  | {
    status: 'pushed'
    services: string[]
    removed: string[]
    changeId: string
    /** False where the send went through but what Merchant Center now holds
     *  could not be read back. Not a failure, and not a success to report as
     *  one: the owner is told to compare. */
    confirmed: boolean
  }
  | { status: 'nothing-to-send'; message: string }
  | { status: 'blocked'; message: string }
  | { status: 'conflict'; message: string }
  | { status: 'stale'; message: string }

const CONFLICT_MESSAGE =
  'Your delivery settings changed at Merchant Center while this page was open, so nothing has been sent. '
  + 'Compare them again and you will see what is there now.'

/** Appended while a send's outcome is unknown, and stripped when it is settled. */
const UNCONFIRMED_SUFFIX = " - sent, but Google's reply could not be read back"
const SENDING_SUFFIX = ' (sending…)'

const STALE_MESSAGE =
  'Your delivery charges have changed since this page worked out what to send, so nothing has been sent. '
  + 'Reload the tab to see what would go now.'

// Short and local. Neither transaction here contains anything but our own
// writes, so the default limits are ample - the network call that used to need
// fifty seconds now sits between them rather than inside one.
const TRANSACTION_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const

/**
 * Sends the current plan to Merchant Center.
 *
 * `expectedFingerprint` is the one the preview handed out. It must still match
 * what the plan would send, or the owner is looking at something other than
 * what would go.
 */
export async function pushDeliverySettings(actor: string | null, expectedFingerprint: string): Promise<PushOutcome> {
  const plan = await buildDeliveryPlan()
  const merchantId = plan.merchantId
  if (!merchantId) {
    return { status: 'blocked', message: 'Fill in your Merchant Center account number first and there will be somewhere to send this.' }
  }
  if (!plan.mapping) {
    return {
      status: 'nothing-to-send',
      message: plan.available
        ? 'Your delivery services could not be read, so nothing has been sent.'
        : 'Nothing on this site publishes delivery services, so there is nothing to send.',
    }
  }
  if (plan.mapping.blocked) {
    const first = plan.mapping.notes.find((note) => note.severity === 'blocking')
    return { status: 'blocked', message: first?.message ?? 'Some of your delivery charges cannot be sent exactly, so nothing has been sent.' }
  }

  const state = await readDeliveryState()

  // The plan the owner read has to be the plan that goes. Checked before the
  // Merchant Center read, so a stale confirmation costs no API call at all.
  if (planFingerprint(plan.mapping.services, state.managedServices) !== expectedFingerprint) {
    return { status: 'stale', message: STALE_MESSAGE }
  }

  const before = await readShippingSettings(merchantId)
  const merged = mergeShippingSettings(before.settings, plan.mapping.services, state.managedServices)
  const managedNow = plan.mapping.services.map((service) => service.serviceName)
  const removed = state.managedServices.filter((name) => !managedNow.includes(name))
  const summary = summarise(managedNow, removed)

  // ---- 1. Record the intent -------------------------------------------------
  const changeId = await prisma.$transaction(async (tx) => recordChange({
    area: 'shipping',
    action: 'push',
    summary: `${summary}${SENDING_SUFFIX}`,
    before: { settings: before.settings, managedServices: state.managedServices } satisfies DeliverySnapshot,
    after: { settings: merged, managedServices: managedNow, status: 'sending' } satisfies DeliverySnapshot,
    createdBy: actor,
  }, tx), TRANSACTION_OPTIONS)

  // ---- 2. Send, outside any transaction -------------------------------------
  // null here means the write went through but Google's reply could not be
  // read - not a failure, and handled below.
  let confirmed: MerchantShippingSettings | null
  try {
    confirmed = await writeShippingSettings(merchantId, { ...merged, etag: before.etag })
  } catch (error) {
    try {
      await amendChange(changeId, {
        summary: `${summary} - Google refused it, so nothing was changed`,
        after: { settings: merged, managedServices: state.managedServices, status: 'failed' } satisfies DeliverySnapshot,
      })
    } catch (amendError) {
      // The one place a lost write leaves nothing behind at all: the send was
      // refused AND the entry could not be marked as refused, so the log still
      // reads 'sending' for something that never happened. Logged with the
      // entry id so it can be found and read by hand. (A later Compare will
      // not settle it either - the evidence test cannot match a send that was
      // refused - so it stays visible rather than quietly becoming 'done'.)
      console.error(`[google-shopping] could not mark delivery push ${changeId} as failed:`, amendError)
    }
    if (isEtagConflict(error)) return { status: 'conflict', message: CONFLICT_MESSAGE }
    throw error
  }

  // What Google now holds, in GOOGLE's words rather than our prediction of
  // them. Undo compares the live settings against this snapshot, so anything
  // Google normalises on the way in has to be in it or every undo would read as
  // "somebody has been in since". A reply we could not parse - or one with no
  // services in it - falls back to a fresh read for the same reason.
  let after = confirmed?.services ? confirmed : null
  if (!after) {
    after = await readShippingSettings(merchantId).then((read) => read.settings).catch(() => null)
  }

  // ---- 3. Record the outcome ------------------------------------------------
  //
  // Where neither Google's reply nor a fresh read could be had, the entry stays
  // 'pending': the send happened, but nothing here knows what Merchant Center
  // ended up holding, and 'done' would licence an Undo to overwrite it with a
  // comparison against a guess. The ownership record is still written - those
  // services ARE ours now, whatever their contents.
  const confirmedSettings = after
  await prisma.$transaction(async (tx) => {
    await recordPush(managedNow, new Date(), tx)
    await amendChange(changeId, {
      summary: confirmedSettings ? summary : `${summary}${UNCONFIRMED_SUFFIX}`,
      after: {
        settings: confirmedSettings ?? merged,
        managedServices: managedNow,
        status: confirmedSettings ? 'done' : 'pending',
      } satisfies DeliverySnapshot,
    }, tx)
  }, TRANSACTION_OPTIONS)

  // `confirmed: false` is the whole point of the branch above reaching the
  // caller. Without it the tab drew a plain green "sent" in exactly the case
  // where we had just gone to the trouble of recording that we do NOT know what
  // Merchant Center holds.
  return { status: 'pushed', services: managedNow, removed, changeId, confirmed: confirmedSettings !== null }
}

function summarise(sent: string[], removed: string[]): string {
  const parts = [`Sent ${sent.length} delivery ${sent.length === 1 ? 'service' : 'services'} to Merchant Center`]
  if (removed.length > 0) parts.push(`and took away ${removed.length} that ${removed.length === 1 ? 'is' : 'are'} no longer offered`)
  return parts.join(' ')
}

// ---------------------------------------------------------------------------
// Settling a send whose outcome was never learned
// ---------------------------------------------------------------------------

/**
 * Promotes the last push to 'done' when the live settings show it landed.
 *
 * Called by the comparison, which is the one moment this site has Merchant
 * Center's live settings in its hands for nothing. Without it a send whose
 * reply could not be read stayed 'pending' FOR EVER: Undo refused it for ever
 * too, and the only sign of any of it was a line on another tab.
 *
 * The evidence test is narrow on purpose. It is not "the settings look
 * plausible" - it is "every service this site meant to send is at Google
 * saying exactly what we meant it to say". Anything else leaves the entry
 * alone, because the alternative is recording somebody ELSE's change as the
 * thing our push left behind, and a later Undo would then revert it.
 *
 * What lands in the snapshot is the LIVE settings rather than our intended
 * ones - including whatever anybody else has in there - because that is what
 * Undo compares against, exactly as it would after an ordinary push.
 *
 * Which widens one window, and it is worth being explicit about. Undo's safety
 * rests on comparing `before` (taken at push time) with `after`: for an
 * ordinary push those two reads are seconds apart, so almost nothing can slip
 * between them. Promotion makes `after` a read from COMPARE time, which may be
 * hours later - and a service somebody added to Merchant Center in that window
 * is in the `after` snapshot, passes the comparison, and would be taken away by
 * an Undo. Still inside what Undo has always promised (it reverses to `before`,
 * and `before` never had that service), but a wider window than before, so the
 * wiki says so in the owner's terms rather than leaving it to be discovered.
 *
 * Also repairs the ownership record. A crash between the send and the commit
 * left 'sending' with the managed-service list unwritten, so a later push
 * would have treated a service this site had just created as somebody else's
 * and left it alone for ever.
 */
export async function promoteUnconfirmedPush(live: MerchantShippingSettings): Promise<boolean> {
  // The newest push only. An older one behind a settled push is not ours to
  // reinterpret, and promoting it would write a stale ownership list over a
  // newer one.
  const [newest] = (await listChanges({ area: 'shipping', limit: 20 })).filter((entry) => entry.action === 'push')
  if (!newest || newest.undoneAt) return false

  const snapshot = readSnapshot(newest.after)
  if (!snapshot) return false
  if (snapshot.status !== 'sending' && snapshot.status !== 'pending') return false

  // Every service we meant to send, as we meant to send it, against what is
  // there now. Only our own: the rest of the account is nobody's business here
  // and would never have matched anyway.
  if (!sameManagedServices(snapshot.settings.services, live.services, snapshot.managedServices)) return false

  const settled = newest.summary.replace(UNCONFIRMED_SUFFIX, '').replace(SENDING_SUFFIX, '')
  await prisma.$transaction(async (tx) => {
    // The push happened when the entry was written, not now.
    await recordPush(snapshot.managedServices, newest.createdAt, tx)
    await amendChange(newest.id, {
      summary: settled,
      after: { settings: live, managedServices: snapshot.managedServices, status: 'done' } satisfies DeliverySnapshot,
    }, tx)
  }, TRANSACTION_OPTIONS)
  return true
}

/**
 * JSON with every object's keys in a fixed order, at every depth.
 *
 * Plain JSON.stringify cannot do this job, and the reason is not obvious: one
 * side of every comparison here has been through Postgres as jsonb, which does
 * NOT preserve key order - it stores keys sorted by length and then by bytes -
 * while the other side is Google's own JSON in whatever order Google sent it.
 * The same settings therefore stringify to two different strings, so a
 * straight comparison would call every snapshot different from the live
 * settings it was taken from, and the undo would refuse for ever.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Whether this entry is the most recent push, which is the only one a
 *  comparison can settle - see promoteUnconfirmedPush, which takes the newest
 *  and no other. Anything older is past settling, and the undo says so rather
 *  than sending an owner off to press a button that will not help. */
async function isNewestPush(entryId: string): Promise<boolean> {
  const [newest] = (await listChanges({ area: 'shipping', limit: 20 })).filter((entry) => entry.action === 'push')
  return newest?.id === entryId
}

/** Whether the named services say the same thing on both sides. Names not
 *  present on either side count as a mismatch: a service we meant to send and
 *  Google has not got is exactly the case where the send did not land. */
function sameManagedServices(
  intended: MerchantService[] | undefined,
  live: MerchantService[] | undefined,
  names: string[],
): boolean {
  if (names.length === 0) return false
  const byName = (services: MerchantService[] | undefined): Map<string, MerchantService> => new Map(
    (services ?? [])
      .filter((service): service is MerchantService & { serviceName: string } => typeof service.serviceName === 'string')
      .map((service) => [service.serviceName, service]),
  )
  const ours = byName(intended)
  const theirs = byName(live)
  return names.every((name) => {
    const mine = ours.get(name)
    const yours = theirs.get(name)
    if (!mine || !yours) return false
    return canonical(mine) === canonical(yours)
  })
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

function readSnapshot(value: unknown): DeliverySnapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (typeof row.settings !== 'object' || row.settings === null) return null
  const managed = Array.isArray(row.managedServices)
    ? row.managedServices.filter((name): name is string => typeof name === 'string')
    : []
  const status = row.status === 'sending' || row.status === 'pending' || row.status === 'failed' || row.status === 'done'
    ? row.status
    : 'done'
  return { settings: row.settings as MerchantShippingSettings, managedServices: managed, status }
}

/** Two sets of services said the same thing. Compared by name and by content,
 *  with the ordering taken out of it - Google is free to list them however it
 *  likes, and a different order is not somebody having changed something. */
function sameServices(a: MerchantService[] | undefined, b: MerchantService[] | undefined): boolean {
  const key = (services: MerchantService[] | undefined): string => canonical(
    [...(services ?? [])].sort((left, right) => String(left.serviceName ?? '').localeCompare(String(right.serviceName ?? ''))),
  )
  return key(a) === key(b)
}

/**
 * Puts one push back.
 *
 * Conservative, the way every undo in this module is: if Merchant Center no
 * longer holds what the push left there, somebody has been in since and their
 * change is not ours to reverse. Skipped, said out loud, nothing sent.
 */
async function undoDeliveryPush(context: UndoContext): Promise<UndoResult> {
  if (context.entry.action !== 'push') return { restored: 0, skipped: 1, summary: 'That delivery entry cannot be put back.' }

  const before = readSnapshot(context.entry.before)
  const after = readSnapshot(context.entry.after)
  if (!before || !after) return { restored: 0, skipped: 1, summary: 'That delivery entry has no readable snapshot to put back.' }

  if (after.status === 'failed') {
    return { restored: 0, skipped: 1, summary: 'That send was refused by Google, so there is nothing to put back.' }
  }
  if (after.status === 'sending' || after.status === 'pending') {
    // The two states where we genuinely do not know. Undoing on a guess could
    // overwrite a change that did land, or claim to reverse one that never did.
    //
    // Comparing settles it - promoteUnconfirmedPush above - but ONLY for the
    // most recent send, so pointing every such entry at Compare would be
    // telling an older one something untrue. Which this is decides the second
    // half of the sentence.
    const newest = await isNewestPush(context.entry.id)
    const what = after.status === 'sending'
      ? 'That send never finished, so it is not known whether it reached Merchant Center.'
      : 'That send went through but its outcome could not be read back.'
    return {
      restored: 0,
      skipped: 1,
      summary: newest
        ? `${what} Compare them and this settles itself.`
        : `${what} A later send has happened since, so this one can no longer be settled or put back - `
          + 'compare your delivery settings and send them again if they are not what you want.',
    }
  }

  const settings = await getGsfSettings()
  if (!settings.merchantId) return { restored: 0, skipped: 1, summary: 'There is no Merchant Center account to put anything back into.' }

  const current = await readShippingSettings(settings.merchantId)
  if (!sameServices(current.settings.services, after.settings.services)) {
    return {
      restored: 0,
      skipped: 1,
      summary: 'Your Merchant Center delivery settings have changed since that was sent, so they have been left alone.',
    }
  }

  try {
    await writeShippingSettings(settings.merchantId, { ...before.settings, etag: current.etag })
  } catch (error) {
    if (isEtagConflict(error)) return { restored: 0, skipped: 1, summary: CONFLICT_MESSAGE }
    throw error
  }
  await recordPush(before.managedServices, new Date(), context.tx)
  return { restored: 1, skipped: 0, summary: 'Put your Merchant Center delivery settings back as they were' }
}

registerUndoHandler('shipping', undoDeliveryPush)
