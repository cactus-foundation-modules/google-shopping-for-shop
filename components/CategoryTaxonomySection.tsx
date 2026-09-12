'use client'

// The Google-category mapping, one row per shop category. Lives in its own file
// rather than in SettingsTab: it has its own address, its own fetch and a list
// as long as the shop's category tree, and none of that belongs in a tab that
// is otherwise a page of switches.
import { useCallback, useEffect, useState } from 'react'
import type { GsfCategoryTaxonomyRow } from '@/modules/google-shopping-for-shop/lib/types'

const BASE = '/api/m/google-shopping-for-shop/admin'

const card = {
  border: '1px solid var(--color-border)',
  borderRadius: 12,
  padding: '1rem 1.25rem',
  background: 'var(--color-surface)',
  marginBottom: '1.25rem',
} as const

const legend = { fontSize: '0.9375rem', fontWeight: 600, margin: '0 0 0.25rem' } as const
const hint = { display: 'block', fontSize: '0.8125rem', color: 'var(--color-text-muted)', marginTop: '0.25rem' } as const
const inputStyle = {
  font: 'inherit',
  fontSize: '0.875rem',
  padding: '0.4rem 0.5rem',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  background: 'var(--color-bg)',
  color: 'var(--color-fg)',
  width: '100%',
} as const

export function CategoryTaxonomySection() {
  const [rows, setRows] = useState<GsfCategoryTaxonomyRow[] | null>(null)
  // Keyed by category so a half-typed value in one row is not thrown away when
  // another row saves and the whole list comes back.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [savingId, setSavingId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const adopt = useCallback((next: GsfCategoryTaxonomyRow[]) => {
    setRows(next)
    setDrafts(Object.fromEntries(next.map((r) => [r.categoryId, r.googleProductCategory])))
  }, [])

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/category-taxonomy`)
      if (!res.ok) throw new Error('Could not load categories')
      const body = (await res.json()) as { categories: GsfCategoryTaxonomyRow[] }
      adopt(body.categories)
    } catch {
      setError('Could not load your categories.')
    }
  }, [adopt])

  useEffect(() => {
    let cancelled = false
    // Yield a microtask first so the opening setState never runs synchronously
    // inside the effect.
    void (async () => {
      await Promise.resolve()
      if (!cancelled) await load()
    })()
    return () => { cancelled = true }
  }, [load])

  async function saveRow(categoryId: string, value: string) {
    setSavingId(categoryId)
    setError('')
    try {
      const res = await fetch(`${BASE}/category-taxonomy`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoryId, googleProductCategory: value }),
      })
      const body = (await res.json()) as { categories?: GsfCategoryTaxonomyRow[]; error?: string }
      if (!res.ok || !body.categories) throw new Error(body.error ?? 'Save failed')
      adopt(body.categories)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSavingId(null)
    }
  }

  if (!rows) {
    return (
      <section style={card}>
        <h3 style={legend}>Google&rsquo;s own categories</h3>
        {error
          ? <p role="alert" style={{ color: 'var(--color-danger)' }}>{error}</p>
          : <p style={{ color: 'var(--color-text-muted)' }}>Loading…</p>}
      </section>
    )
  }

  const unanswered = rows.filter((r) => !r.googleProductCategory && !r.inherited).length

  return (
    <section style={card}>
      <h3 style={legend}>Google&rsquo;s own categories</h3>
      <span style={hint}>
        Google keeps a list of every kind of thing anyone sells, and knowing which one a product is decides where it can be shown and
        what Google expects to be told about it. Your own categories go along too, but they are your wording - this is Google&rsquo;s.
        Find yours in Google&rsquo;s product taxonomy and paste either the number or the full wording, such as{' '}
        <code>Furniture &gt; Chairs &gt; Office Chairs</code>.
      </span>
      <span style={hint}>
        One per category, not per product. A category you leave blank uses whatever its parent says, so the top of your tree usually
        does most of the work. Anything set on an individual product, on its own Google Shopping tab, still wins.
      </span>
      {rows.length === 0 ? (
        <p style={{ ...hint, marginTop: '0.75rem' }}>You have no categories yet, so there is nothing to match up.</p>
      ) : (
        <>
          {unanswered > 0 && (
            <p style={{ ...hint, marginTop: '0.75rem' }}>
              {unanswered === 1
                ? 'One category has nothing to send yet, and neither has anything above it.'
                : `${unanswered} categories have nothing to send yet, and neither has anything above them.`}
            </p>
          )}
          <div style={{ marginTop: '0.75rem', display: 'grid', gap: '0.5rem' }}>
            {rows.map((row) => {
              const draft = drafts[row.categoryId] ?? ''
              return (
                <label
                  key={row.categoryId}
                  style={{ display: 'grid', gridTemplateColumns: 'minmax(min(100%, 12rem), 1fr) minmax(min(100%, 14rem), 1.4fr)', gap: '0.5rem', alignItems: 'center' }}
                >
                  <span style={{ fontSize: '0.875rem', color: 'var(--color-text)' }}>{row.path}</span>
                  <input
                    type="text"
                    value={draft}
                    placeholder={row.inherited ? `${row.inherited} (from above)` : 'Nothing sent'}
                    disabled={savingId === row.categoryId}
                    onChange={(e) => setDrafts((d) => ({ ...d, [row.categoryId]: e.target.value }))}
                    onBlur={() => { if (draft !== row.googleProductCategory) void saveRow(row.categoryId, draft) }}
                    style={inputStyle}
                  />
                </label>
              )
            })}
          </div>
        </>
      )}
      {error && <p role="alert" style={{ color: 'var(--color-danger)', fontSize: '0.875rem', marginTop: '0.75rem' }}>{error}</p>}
    </section>
  )
}
