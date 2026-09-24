// Asking Merchant Center what it holds and lining it up against what this site
// would send. One Google call, no writes.
//
// Used by the Compare button and by the daily check, which is the point: the
// figure in the alert and the figure on the tab come from the same comparison,
// so an owner who opens the tab after an alert sees the thing the alert was
// about rather than a second opinion.
import { buildDeliveryPlan } from '@/modules/google-shopping-for-shop/lib/delivery/plan'
import { diffShippingSettings, type DeliveryDiff } from '@/modules/google-shopping-for-shop/lib/delivery/diff'
import { readShippingSettings } from '@/modules/google-shopping-for-shop/lib/delivery/merchant'
import { readDeliveryState, recordComparison } from '@/modules/google-shopping-for-shop/lib/delivery/state'
import { promoteUnconfirmedPush } from '@/modules/google-shopping-for-shop/lib/delivery/push'
import { GoogleApiError, GoogleAuthError, GoogleCredentialsError, GoogleNetworkError } from '@/modules/google-shopping-for-shop/lib/google/errors'

/** Why a comparison could not be made. Each one is a different sentence and a
 *  different thing for the owner to do, so none of them is an "error". */
export const COMPARE_UNAVAILABLE_REASONS = [
  'no-credentials',
  'no-account',
  'no-delivery-module',
  'delivery-unreadable',
  'nothing-to-send',
  'denied',
  'google-error',
] as const
export type CompareUnavailableReason = (typeof COMPARE_UNAVAILABLE_REASONS)[number]

export type CompareOutcome =
  | {
    status: 'ok'
    diff: DeliveryDiff
    /** True where this comparison settled an earlier send whose outcome had
     *  never been learned - see promoteUnconfirmedPush. Worth saying: it is
     *  also the moment Undo becomes available for that send again. */
    settledEarlierSend?: boolean
  }
  | { status: 'unavailable'; reason: CompareUnavailableReason; message: string }

const COPY: Record<CompareUnavailableReason, string> = {
  'no-credentials': 'No Google key has been saved yet, so Merchant Center cannot be asked what it holds.',
  'no-account': 'Fill in your Merchant Center account number and this can be compared.',
  'no-delivery-module': 'Nothing on this site publishes delivery services, so there is nothing to compare Merchant Center with.',
  'delivery-unreadable': 'Your delivery services could not be read, so there is nothing to compare. Check the delivery settings on this site.',
  'nothing-to-send': 'None of your delivery services has a price that could be sent, so there is nothing to compare.',
  // Reading is the Standard bar. SENDING is the Admin bar, and that is asked
  // separately by the access check - see lib/google/access-check.ts.
  denied: 'Google would not let this key read your delivery settings. It needs at least the "Standard" access level in Merchant Center, under People and access.',
  'google-error': 'Google could not be asked just now. Try again in a moment.',
}

function unavailable(reason: CompareUnavailableReason, detail?: string): CompareOutcome {
  return { status: 'unavailable', reason, message: detail ? `${COPY[reason]} ${detail}` : COPY[reason] }
}

/**
 * Compares, and remembers the answer.
 *
 * Remembering is deliberate: the tab opens on the last comparison rather than
 * ringing Google every time somebody clicks a sub-tab, and the daily check has
 * somewhere to leave what it found.
 */
export async function compareDeliverySettings(options: { record?: boolean } = {}): Promise<CompareOutcome> {
  const plan = await buildDeliveryPlan()
  if (!plan.available) return unavailable('no-delivery-module')
  if (plan.unreadable) return unavailable('delivery-unreadable')
  if (!plan.merchantId) return unavailable('no-account')
  if (!plan.mapping || plan.mapping.services.length === 0) return unavailable('nothing-to-send')

  const state = await readDeliveryState()

  try {
    const current = await readShippingSettings(plan.merchantId)

    // Having the live settings in hand is the one thing needed to settle a send
    // whose outcome was never learned, so it happens here rather than being
    // left for an owner to puzzle over. Its own try: a comparison is still a
    // comparison even if the healing goes wrong, and the diff below is the
    // thing that was actually asked for.
    let settledEarlierSend = false
    try {
      settledEarlierSend = await promoteUnconfirmedPush(current.settings)
    } catch (healError) {
      console.error('[google-shopping] could not settle an unconfirmed delivery push:', healError)
    }

    // AFTER the promotion, so a send that has just been settled is compared
    // with the ownership record it should have had all along.
    const managedNames = settledEarlierSend ? (await readDeliveryState()).managedServices : state.managedServices
    const diff = diffShippingSettings({
      ours: plan.mapping.services,
      theirs: current.settings.services ?? [],
      managedNames,
    })
    if (options.record !== false) await recordComparison(diff)
    return { status: 'ok', diff, ...(settledEarlierSend ? { settledEarlierSend } : {}) }
  } catch (error) {
    if (error instanceof GoogleCredentialsError) return unavailable('no-credentials')
    if (error instanceof GoogleAuthError) return unavailable('denied', error.message)
    if (error instanceof GoogleApiError) {
      return error.forbidden ? unavailable('denied', error.message) : unavailable('google-error', error.message)
    }
    if (error instanceof GoogleNetworkError) return unavailable('google-error', error.message)
    throw error
  }
}
