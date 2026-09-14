'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

const BASE = '/api/m/google-shopping-for-shop/admin'

type MatchState = 'matched' | 'unmatched' | 'unknown'

type Token = {
  token: string
  value: string
}

type WorkbenchItem = {
  id: string
  parentTitle: string
  originalTitle: string
  renderedTitle: string
  titleTemplate: string | null
  unknownTokens: string[]
  availableTokens: Token[]
  sku: string
  mpn: string
  gtin: string
  productType: string
  price: string
  imageUrl: string
  url: string
  matched: MatchState
  benchmarkAmountMicros: string
  benchmarkCurrency: string
  checkedAt: string | null
}

type WorkbenchResponse = {
  items: WorkbenchItem[]
  page: number
  perPage: number
  total: number
  summary: {
    total: number
    matched: number
    unmatched: number
    unknown: number
    overridden: number
    lastCheckedAt: string | null
    canRefresh: boolean
  }
  error?: string
}

const shell = { display: 'grid', gap: '1rem' } as const
const toolbar = { display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' } as const
const input = {
  font: 'inherit',
  fontSize: '0.875rem',
  padding: '0.5rem 0.625rem',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  background: 'var(--color-bg)',
  color: 'var(--color-fg)',
} as const
const muted = { color: 'var(--color-text-muted)', fontSize: '0.8125rem' } as const

function badge(state: MatchState) {
  const colour = state === 'matched' ? 'var(--color-success, #257a3e)' : state === 'unmatched' ? 'var(--color-danger, #a33)' : 'var(--color-text-muted)'
  return <span style={{ color: colour, fontWeight: 700, textTransform: 'capitalize' }}>{state}</span>
}

function moneyFromMicros(value: string, currency: string): string {
  const number = Number(value)
  if (!Number.isFinite(number)) return ''
  return (number / 1_000_000).toLocaleString('en-GB', { style: 'currency', currency: currency || 'GBP' })
}

function tokenPreview(tokens: Token[]): string {
  return tokens
    .filter((t) => ['sku', 'parent_title', 'original_title', 'variant_label', 'colour', 'color', 'size', 'material', 'frame_colour', 'upholstery_colour', 'finish'].includes(t.token))
    .slice(0, 12)
    .map((t) => `<${t.token}>`)
    .join(' ')
}

export function GoogleShoppingWorkbench() {
  const [items, setItems] = useState<WorkbenchItem[]>([])
  const [summary, setSummary] = useState<WorkbenchResponse['summary'] | null>(null)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [query, setQuery] = useState('')
  const [match, setMatch] = useState('all')
  const [override, setOverride] = useState('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [bulkTemplate, setBulkTemplate] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const perPage = 50
  const selectedItems = useMemo(() => items.filter((item) => selected.has(item.id)), [items, selected])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ page: String(page), perPage: String(perPage), match, override })
      if (query.trim()) params.set('q', query.trim())
      const res = await fetch(`${BASE}/items?${params}`)
      const body = await res.json() as WorkbenchResponse
      if (!res.ok) throw new Error(body.error ?? 'Could not load Google Shopping products')
      setItems(body.items)
      setSummary(body.summary)
      setTotal(body.total)
      setDrafts(Object.fromEntries(body.items.map((item) => [item.id, item.titleTemplate ?? ''])))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load Google Shopping products')
    } finally {
      setLoading(false)
    }
  }, [match, override, page, query])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await Promise.resolve()
      if (!cancelled) await load()
    })()
    return () => { cancelled = true }
  }, [load])

  async function saveUpdates(updates: Array<{ itemId: string; titleTemplate: string | null }>) {
    setSaving(true)
    setMessage('')
    setError('')
    try {
      const res = await fetch(`${BASE}/items`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      })
      const body = await res.json() as { error?: string }
      if (!res.ok) throw new Error(body.error ?? 'Save failed')
      setMessage(updates.length === 1 ? 'Saved title template.' : `Saved ${updates.length} title templates.`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function refreshMatchStatus() {
    setSaving(true)
    setMessage('')
    setError('')
    try {
      const res = await fetch(`${BASE}/items/refresh`, { method: 'POST' })
      const body = await res.json() as { products?: number; matched?: number; error?: string }
      if (!res.ok) throw new Error(body.error ?? 'Refresh failed')
      setMessage(`Refreshed ${body.products ?? 0} Merchant products; ${body.matched ?? 0} have a match snapshot.`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refresh failed')
    } finally {
      setSaving(false)
    }
  }

  function toggle(id: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function selectVisible(checked: boolean) {
    setSelected((current) => {
      const next = new Set(current)
      for (const item of items) {
        if (checked) next.add(item.id)
        else next.delete(item.id)
      }
      return next
    })
  }

  return (
    <div style={shell}>
      <div>
        <h2 style={{ margin: '0 0 0.25rem' }}>Google Shopping</h2>
        <p style={{ ...muted, margin: 0 }}>
          Feed items, Google match snapshots and feed-only title templates. Website product names and option labels are left alone.
        </p>
      </div>

      {summary && (
        <div style={{ ...toolbar, ...muted }}>
          <strong>{summary.total.toLocaleString()} feed items</strong>
          <span>{summary.matched.toLocaleString()} matched</span>
          <span>{summary.unmatched.toLocaleString()} unmatched</span>
          <span>{summary.unknown.toLocaleString()} unknown</span>
          <span>{summary.overridden.toLocaleString()} overrides</span>
          {summary.lastCheckedAt && <span>Checked {new Date(summary.lastCheckedAt).toLocaleString()}</span>}
        </div>
      )}

      <div style={toolbar}>
        <input
          value={query}
          placeholder="Search title, SKU, MPN or GTIN"
          onChange={(e) => { setQuery(e.target.value); setPage(1) }}
          style={{ ...input, width: 320 }}
        />
        <select value={match} onChange={(e) => { setMatch(e.target.value); setPage(1) }} style={input}>
          <option value="all">All match states</option>
          <option value="matched">Matched</option>
          <option value="unmatched">Unmatched</option>
          <option value="unknown">Unknown</option>
        </select>
        <select value={override} onChange={(e) => { setOverride(e.target.value); setPage(1) }} style={input}>
          <option value="all">All titles</option>
          <option value="overridden">With override</option>
          <option value="plain">No override</option>
        </select>
        <button type="button" className="btn" disabled={loading} onClick={() => void load()}>Reload</button>
        {summary?.canRefresh && (
          <button type="button" className="btn" disabled={saving} onClick={() => void refreshMatchStatus()}>
            Refresh match status
          </button>
        )}
      </div>

      <div style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: '0.75rem', display: 'grid', gap: '0.75rem' }}>
        <div style={toolbar}>
          <strong>{selected.size.toLocaleString()} selected</strong>
          <button type="button" className="btn" disabled={items.length === 0} onClick={() => selectVisible(true)}>Select visible</button>
          <button type="button" className="btn" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>Clear selection</button>
        </div>
        <textarea
          value={bulkTemplate}
          onChange={(e) => setBulkTemplate(e.target.value)}
          placeholder="Bulk template, e.g. ISO Stacking Chair <upholstery_colour> Fabric <frame_colour> Frame <sku>"
          rows={2}
          style={{ ...input, width: '100%', resize: 'vertical' }}
        />
        <div style={toolbar}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || selected.size === 0}
            onClick={() => void saveUpdates([...selected].map((itemId) => ({ itemId, titleTemplate: bulkTemplate || null })))}
          >
            Apply to selected
          </button>
          {selectedItems[0] && <span style={muted}>Tokens on first selected row: {tokenPreview(selectedItems[0].availableTokens)}</span>}
        </div>
      </div>

      {message && <p style={{ color: 'var(--color-success, var(--color-text))', margin: 0 }}>{message}</p>}
      {error && <p role="alert" style={{ color: 'var(--color-danger)', margin: 0 }}>{error}</p>}

      <div style={{ overflowX: 'auto', border: '1px solid var(--color-border)', borderRadius: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1180 }}>
          <thead>
            <tr style={{ textAlign: 'left', background: 'var(--color-surface)' }}>
              <th style={{ padding: '0.625rem' }}><input type="checkbox" checked={items.length > 0 && items.every((item) => selected.has(item.id))} onChange={(e) => selectVisible(e.target.checked)} /></th>
              <th style={{ padding: '0.625rem' }}>Product</th>
              <th style={{ padding: '0.625rem' }}>Match</th>
              <th style={{ padding: '0.625rem' }}>Codes</th>
              <th style={{ padding: '0.625rem' }}>Title override</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} style={{ borderTop: '1px solid var(--color-border)', verticalAlign: 'top' }}>
                <td style={{ padding: '0.625rem' }}>
                  <input type="checkbox" checked={selected.has(item.id)} onChange={(e) => toggle(item.id, e.target.checked)} />
                </td>
                <td style={{ padding: '0.625rem', width: 430 }}>
                  <div style={{ display: 'flex', gap: '0.75rem' }}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- feed images are external Merchant Center inputs */}
                    {item.imageUrl && <img src={item.imageUrl} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--color-border)' }} />}
                    <div>
                      <a href={item.url} target="_blank" rel="noreferrer" style={{ fontWeight: 700 }}>{item.originalTitle}</a>
                      <div style={{ ...muted, marginTop: '0.25rem' }}>Google title: {item.renderedTitle}</div>
                      {item.unknownTokens.length > 0 && <div style={{ color: 'var(--color-danger)', fontSize: '0.8125rem' }}>Unknown token: {item.unknownTokens.join(', ')}</div>}
                    </div>
                  </div>
                </td>
                <td style={{ padding: '0.625rem', width: 130 }}>
                  {badge(item.matched)}
                  {item.benchmarkAmountMicros && <div style={muted}>Benchmark {moneyFromMicros(item.benchmarkAmountMicros, item.benchmarkCurrency)}</div>}
                </td>
                <td style={{ padding: '0.625rem', width: 190, ...muted }}>
                  <div>SKU {item.sku || 'n/a'}</div>
                  <div>MPN {item.mpn || 'n/a'}</div>
                  <div>GTIN {item.gtin || 'n/a'}</div>
                </td>
                <td style={{ padding: '0.625rem', minWidth: 360 }}>
                  <textarea
                    value={drafts[item.id] ?? ''}
                    onChange={(e) => setDrafts((current) => ({ ...current, [item.id]: e.target.value }))}
                    rows={2}
                    style={{ ...input, width: '100%', resize: 'vertical' }}
                    placeholder="Blank uses the normal feed title"
                  />
                  <div style={{ ...toolbar, marginTop: '0.4rem' }}>
                    <button type="button" className="btn" disabled={saving} onClick={() => void saveUpdates([{ itemId: item.id, titleTemplate: drafts[item.id] || null }])}>
                      Save
                    </button>
                    <span style={muted}>{tokenPreview(item.availableTokens)}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ ...toolbar, justifyContent: 'space-between' }}>
        <span style={muted}>{total.toLocaleString()} matching rows</span>
        <div style={toolbar}>
          <button type="button" className="btn" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
          <span style={muted}>Page {page}</span>
          <button type="button" className="btn" disabled={page * perPage >= total || loading} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      </div>
    </div>
  )
}
