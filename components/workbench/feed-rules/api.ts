// The Feed Rules tab's calls to its admin routes. Failures come back as a
// thrown Error carrying the route's own plain-English message.
import { API_BASE } from '@/modules/google-shopping-for-shop/components/workbench/api'
import type { CategoryOption } from '@/modules/google-shopping-for-shop/lib/feed-rules/category-options'
import type { RulePreview } from '@/modules/google-shopping-for-shop/lib/feed-rules/preview'
import type { FeedRule, RuleDraft } from '@/modules/google-shopping-for-shop/lib/feed-rules/types'

export type RulesResponse = {
  rules: FeedRule[]
  attributes: Array<{ id: string; name: string }>
  attributesAvailable: boolean
  categories: CategoryOption[]
  rangeAttributeId: string | null
}

export type RuleStats = {
  /** Items each rule matches, switched-off rules included. */
  counts: Record<string, number>
  /** For a switched-off Exclude rule: items it would take out of the feed. */
  wouldExclude: Record<string, number>
  outOfFeed: { rule: number; hand: number }
  inFeed: number
  catalogue: number
  optionNames: string[]
  suggestions: { supplier: string[]; brand: string[] }
  readAt: string
}

export type LogEntry = {
  id: string
  area: string
  action: string
  summary: string
  createdBy: string | null
  createdAt: string
  undoneAt: string | null
  canUndo: boolean
}

export type UndoOutcome = {
  status: 'undone'
  restored: number
  skipped: number
  entryId: string | null
  /** Why, in the area's own words. Present on a skip, where the count alone
   *  says nothing useful. */
  message?: string
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : fallback
    throw new Error(message)
  }
  if (body === null) throw new Error(fallback)
  return body as T
}

function send(method: 'POST' | 'PATCH', payload: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
}

const RULES = `${API_BASE}/feed-rules`

export async function fetchRules(): Promise<RulesResponse> {
  return readJson<RulesResponse>(await fetch(RULES, { cache: 'no-store' }), 'Could not load the feed rules')
}

export async function fetchRuleStats(signal?: AbortSignal): Promise<RuleStats> {
  return readJson<RuleStats>(await fetch(`${RULES}/stats`, { cache: 'no-store', signal }), 'Could not read the catalogue')
}

export async function createRule(draft: RuleDraft): Promise<{ rule: FeedRule; changeId: string }> {
  return readJson(await fetch(RULES, send('POST', { draft })), 'Could not save the rule')
}

export async function updateRule(id: string, draft: RuleDraft): Promise<{ rule: FeedRule; changeId: string | null }> {
  return readJson(await fetch(RULES, send('PATCH', { id, draft })), 'Could not save the rule')
}

export async function deleteRule(id: string): Promise<{ changeId: string }> {
  return readJson(await fetch(`${RULES}?${new URLSearchParams({ id })}`, { method: 'DELETE' }), 'Could not delete the rule')
}

export async function reorderRules(ids: string[]): Promise<{ rules: FeedRule[]; changeId: string | null }> {
  return readJson(await fetch(`${RULES}/reorder`, send('POST', { ids })), 'Could not reorder the rules')
}

export async function setRangeAttribute(attributeId: string | null): Promise<{ rangeAttributeId: string | null; changeId: string | null }> {
  return readJson(await fetch(`${RULES}/range`, send('POST', { attributeId })), 'Could not save that')
}

export async function previewDraft(draft: RuleDraft, id: string | null, signal?: AbortSignal): Promise<{ preview: RulePreview; serverMs: number }> {
  return readJson(await fetch(`${RULES}/preview`, { ...send('POST', { draft, id }), signal }), 'Could not work out what that rule would do')
}

export async function fetchLog(areas: string[]): Promise<LogEntry[]> {
  const params = new URLSearchParams({ limit: '30' })
  for (const area of areas) params.append('area', area)
  const body = await readJson<{ changes?: LogEntry[] }>(await fetch(`${API_BASE}/change-log?${params}`, { cache: 'no-store' }), 'Could not load recent changes')
  return body.changes ?? []
}

export async function undoLogEntry(id: string): Promise<UndoOutcome> {
  return readJson(await fetch(`${API_BASE}/change-log/undo`, send('POST', { id })), 'Could not undo that change')
}
