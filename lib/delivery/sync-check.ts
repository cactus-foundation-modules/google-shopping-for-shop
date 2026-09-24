// The daily "are the two still saying the same thing?" check.
//
// Delivery settings drift for ordinary reasons: somebody edits a rate in
// Merchant Center to test something, a delivery price changes here and nobody
// sends it over, a service is retired on one side only. None of that announces
// itself, and the first sign of it is usually a customer being quoted one
// delivery charge on Google and another at the checkout.
//
// So it is checked on a timer, and it feeds the alert stage 2 set up for it -
// raised while the two disagree, cleared the moment they agree again.
//
// Off unless the owner switches it on. It costs one Merchant API call a day
// and means nothing until they have pushed something, so it is theirs to
// enable rather than ours to start doing to them.
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { ALERT_KEYS, isAlertUp, setDeliverySyncAlert } from '@/modules/google-shopping-for-shop/lib/health/alerts'
import { compareDeliverySettings } from '@/modules/google-shopping-for-shop/lib/delivery/compare'

export type DeliverySyncCheck =
  | { status: 'ok'; differences: number; alerted: boolean }
  | { status: 'skipped'; reason: 'switched-off' }
  | { status: 'unavailable'; reason: string; message: string }

/**
 * Runs the comparison and moves the alert to match.
 *
 * A comparison that could NOT be made never clears the alert and never raises
 * one. "We could not ask Google today" is not evidence that the settings agree,
 * and it is not evidence that they do not either - so the bell is left exactly
 * as it was and the Delivery tab goes on showing the last real answer with the
 * date it was taken.
 */
export async function runDeliverySyncCheck(): Promise<DeliverySyncCheck> {
  const settings = await getGsfSettings()
  if (!settings.deliverySyncEnabled) return { status: 'skipped', reason: 'switched-off' }

  const outcome = await compareDeliverySettings()
  if (outcome.status === 'unavailable') {
    return { status: 'unavailable', reason: outcome.reason, message: outcome.message }
  }

  const alreadyUp = await isAlertUp(ALERT_KEYS.deliverySync)
  const disagreeing = outcome.diff.services.filter((service) => service.status !== 'match' && !(service.status === 'only-in-google' && !service.managed))
  const alerted = await setDeliverySyncAlert({
    differences: outcome.diff.differences,
    ...(disagreeing.length > 0
      ? { detail: `These delivery services do not match what Merchant Center holds: ${disagreeing.map((service) => service.serviceName).join(', ')}.` }
      : {}),
    alreadyUp,
  })
  return { status: 'ok', differences: outcome.diff.differences, alerted }
}
