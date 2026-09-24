// The live-updates panel's calls to its own admin routes. Failures come back as
// a thrown Error carrying the route's own plain-English message, the same as
// every other part of the workbench.
import { API_BASE } from '@/modules/google-shopping-for-shop/components/workbench/api'
import type { LiveUpdatesView } from '@/modules/google-shopping-for-shop/lib/push/view'
import type { SetupOutcome, SetupPlan } from '@/modules/google-shopping-for-shop/lib/push/setup'
import type { PushRunOutcome } from '@/modules/google-shopping-for-shop/lib/push/types'

export type { LiveUpdatesView, SetupOutcome, SetupPlan, PushRunOutcome }

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : fallback
    throw new Error(message)
  }
  if (body === null) throw new Error(fallback)
  return body as T
}

/** The panel, from our own tables. No call to Google. */
export async function fetchLiveUpdates(signal?: AbortSignal): Promise<LiveUpdatesView> {
  const body = await readJson<{ liveUpdates: LiveUpdatesView }>(
    await fetch(`${API_BASE}/push`, { cache: 'no-store', ...(signal ? { signal } : {}) }),
    'Could not read the live update figures',
  )
  return body.liveUpdates
}

export async function setLiveUpdates(patch: { enabled?: boolean; debounceSeconds?: number; reconcileSample?: number }): Promise<LiveUpdatesView> {
  const body = await readJson<{ liveUpdates: LiveUpdatesView }>(
    await fetch(`${API_BASE}/push`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
    'Could not change that',
  )
  return body.liveUpdates
}

/** Asks Merchant Center what is there. One read, nothing sent. */
export async function checkLiveUpdatesSetup(): Promise<SetupPlan> {
  const body = await readJson<{ plan: SetupPlan }>(
    await fetch(`${API_BASE}/push/setup`, { cache: 'no-store' }),
    'Could not ask Merchant Center what it holds',
  )
  return body.plan
}

/** Creates the extra feed and points the main one at it. Writes to Google. */
export async function runLiveUpdatesSetup(): Promise<{ outcome: SetupOutcome; liveUpdates: LiveUpdatesView }> {
  return readJson<{ outcome: SetupOutcome; liveUpdates: LiveUpdatesView }>(
    await fetch(`${API_BASE}/push/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }),
    'Could not set the live updates up at Merchant Center',
  )
}

/** Takes the link back out, leaving the extra feed where it is. */
export async function unlinkLiveUpdates(): Promise<{ outcome: SetupOutcome; liveUpdates: LiveUpdatesView }> {
  return readJson<{ outcome: SetupOutcome; liveUpdates: LiveUpdatesView }>(
    await fetch(`${API_BASE}/push/setup`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }),
    'Could not unlink the live updates',
  )
}

/** Sends whatever is waiting, now. */
export async function runLiveUpdatesNow(sweep: boolean): Promise<{ outcome: PushRunOutcome; liveUpdates: LiveUpdatesView }> {
  return readJson<{ outcome: PushRunOutcome; liveUpdates: LiveUpdatesView }>(
    await fetch(`${API_BASE}/push/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, sweep }),
    }),
    'Could not send your latest prices to Google',
  )
}
