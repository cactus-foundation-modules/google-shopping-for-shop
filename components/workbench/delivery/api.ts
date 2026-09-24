// The Delivery tab's calls to its admin routes. Failures come back as a thrown
// Error carrying the route's own plain-English message, the same as every
// other part of the workbench.
import { API_BASE } from '@/modules/google-shopping-for-shop/components/workbench/api'
import type { DeliveryTabView } from '@/modules/google-shopping-for-shop/lib/delivery/view'
import type { CompareOutcome } from '@/modules/google-shopping-for-shop/lib/delivery/compare'
import type { PushOutcome } from '@/modules/google-shopping-for-shop/lib/delivery/push'

export type { DeliveryTabView, CompareOutcome, PushOutcome }

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : fallback
    throw new Error(message)
  }
  if (body === null) throw new Error(fallback)
  return body as T
}

/** What this site would send, and the last comparison. No call to Google. */
export async function fetchDelivery(signal?: AbortSignal): Promise<DeliveryTabView> {
  const body = await readJson<{ delivery: DeliveryTabView }>(
    await fetch(`${API_BASE}/delivery`, { cache: 'no-store', ...(signal ? { signal } : {}) }),
    'Could not work out your delivery settings',
  )
  return body.delivery
}

/** Asks Merchant Center what it holds. One read, nothing sent. */
export async function compareDelivery(): Promise<CompareOutcome> {
  return readJson<CompareOutcome>(
    await fetch(`${API_BASE}/delivery/compare`, { method: 'POST' }),
    'Could not compare your delivery settings with Google',
  )
}

/** Sends them. Both the confirmation and the fingerprint of what was on screen
 *  go in the body, because the server refuses without either - the button is
 *  not the guard, the payload is. */
export async function pushDelivery(fingerprint: string): Promise<PushOutcome> {
  return readJson<PushOutcome>(
    await fetch(`${API_BASE}/delivery/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, fingerprint }),
    }),
    'Could not send your delivery settings to Google',
  )
}

/** The daily check's switch. */
export async function setDeliverySync(syncEnabled: boolean): Promise<DeliveryTabView> {
  const body = await readJson<{ delivery: DeliveryTabView }>(
    await fetch(`${API_BASE}/delivery`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ syncEnabled }),
    }),
    'Could not change the daily check',
  )
  return body.delivery
}
