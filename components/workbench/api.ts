// The workbench's calls to its own admin routes, and the shapes they answer
// with. Every call reports failure as a thrown Error carrying the route's own
// plain-English message, so the screen has one way to show a problem.
import type { WorkbenchQuery } from '@/modules/google-shopping-for-shop/lib/workbench-query'
import type { WorkbenchRow, WorkbenchSummary } from '@/modules/google-shopping-for-shop/lib/workbench-view'

export const API_BASE = '/api/m/google-shopping-for-shop/admin'

export type ListResponse = {
  rows: WorkbenchRow[]
  page: number
  pageCount: number
  perPage: number
  total: number
  key: string
  /** Null when the browser already holds the summary for `key`. */
  summary: WorkbenchSummary | null
  catalogue: { readAt: string; ageSeconds: number; stale: boolean; items: number; withheld: number }
  canRefresh: boolean
  serverMs: number
}

export type HistoryEntry = {
  matched: boolean
  merchantTitle: string
  benchmarkAmountMicros: string
  benchmarkCurrency: string
  recordedAt: string
}

export type ChangeEntry = {
  id: string
  summary: string
  itemCount: number
  createdBy: string | null
  createdAt: string
  undoneAt: string | null
}

export type BulkScope =
  | { kind: 'ids'; ids: string[] }
  | { kind: 'query'; query: WorkbenchQuery; expectedCount?: number }

export type BulkAction = { kind: 'set-template'; template: string } | { kind: 'clear-template' }

export type BulkOutcome = {
  dryRun: boolean
  affected: number
  changing: number
  unchanged: number
  replacingOwn: number
  unknownTokenItems: number
  tooLongItems: number
  samples: Array<{ id: string; before: string; after: string; unknownTokens: string[] }>
  /** Present once applied. */
  changed?: number
  batchId?: string | null
}

export type SaveOutcome = { ok: true; batchId: string | null; changed: number; unchanged: number; missing: number }

export type UndoResult = { status: 'undone'; restored: number; skipped: number; batchId: string | null }

export type RefreshResult = { checkedAt: string; products: number; matched: number }

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : fallback
    throw new Error(message)
  }
  if (body === null) throw new Error(fallback)
  return body as T
}

function jsonInit(method: 'POST' | 'PATCH', payload: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
}

export async function fetchList(params: URLSearchParams, signal: AbortSignal): Promise<ListResponse> {
  const response = await fetch(`${API_BASE}/items?${params}`, { signal, cache: 'no-store' })
  return readJson<ListResponse>(response, 'Could not load the Google Shopping list')
}

export async function saveTemplates(updates: Array<{ itemId: string; titleTemplate: string | null }>): Promise<SaveOutcome> {
  const response = await fetch(`${API_BASE}/items`, jsonInit('PATCH', { updates }))
  return readJson<SaveOutcome>(response, 'Could not save the titles')
}

export async function runBulk(scope: BulkScope, action: BulkAction, dryRun: boolean): Promise<BulkOutcome> {
  const response = await fetch(`${API_BASE}/items/bulk`, jsonInit('POST', { scope, action, dryRun }))
  return readJson<BulkOutcome>(response, 'Could not change the titles')
}

export async function fetchHistory(itemId: string): Promise<HistoryEntry[]> {
  const response = await fetch(`${API_BASE}/items/history?${new URLSearchParams({ itemId })}`, { cache: 'no-store' })
  const body = await readJson<{ history?: HistoryEntry[] }>(response, 'Could not load match history')
  return body.history ?? []
}

export async function fetchChanges(): Promise<ChangeEntry[]> {
  const response = await fetch(`${API_BASE}/items/changes`, { cache: 'no-store' })
  const body = await readJson<{ changes?: ChangeEntry[] }>(response, 'Could not load recent changes')
  return body.changes ?? []
}

export async function undoChange(batchId: string): Promise<UndoResult> {
  const response = await fetch(`${API_BASE}/items/changes/undo`, jsonInit('POST', { batchId }))
  return readJson<UndoResult>(response, 'Could not undo that change')
}

export async function refreshMatchStatus(): Promise<RefreshResult> {
  const response = await fetch(`${API_BASE}/items/refresh`, { method: 'POST' })
  return readJson<RefreshResult>(response, 'Could not refresh match status')
}

export function exportHref(params: URLSearchParams): string {
  const query = params.toString()
  return `${API_BASE}/items/export${query ? `?${query}` : ''}`
}
