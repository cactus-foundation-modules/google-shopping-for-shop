'use client'

// Sub-tab of shop's settings tab, hosted through 'shop.settings-sub-tabs'.
// Shop lends the space and nothing else: own fetch, own save, own module API.
import { useCallback, useEffect, useState } from 'react'
import { GSF_CONDITIONS, type GsfCondition, type GsfSettingsView } from '@/modules/google-shopping-for-shop/lib/types'

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
  padding: '0.5rem 0.625rem',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  background: 'var(--color-bg)',
  color: 'var(--color-fg)',
  maxWidth: 420,
  width: '100%',
} as const

const CONDITION_LABELS: Record<GsfCondition, string> = {
  new: 'New',
  refurbished: 'Refurbished',
  used: 'Used',
}

export function GoogleShoppingSettingsTab() {
  const [settings, setSettings] = useState<GsfSettingsView | null>(null)
  const [brandDraft, setBrandDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/settings`)
      if (!res.ok) throw new Error('Could not load settings')
      const body = (await res.json()) as { settings: GsfSettingsView }
      setSettings(body.settings)
      setBrandDraft(body.settings.defaultBrand)
    } catch {
      setError('Could not load Google Shopping settings.')
    }
  }, [])

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

  async function save(patch: { enabled?: boolean; defaultBrand?: string; defaultCondition?: GsfCondition; regenerateToken?: boolean }) {
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const res = await fetch(`${BASE}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const body = (await res.json()) as { settings?: GsfSettingsView; error?: string }
      if (!res.ok || !body.settings) throw new Error(body.error ?? 'Save failed')
      setSettings(body.settings)
      setBrandDraft(body.settings.defaultBrand)
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function copyFeedUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not copy - select the address and copy it by hand.')
    }
  }

  if (!settings) {
    return error
      ? <p role="alert" style={{ color: 'var(--color-danger)' }}>{error}</p>
      : <p style={{ color: 'var(--color-text-muted)' }}>Loading…</p>
  }

  return (
    <div>
      <section style={card}>
        <h3 style={legend}>Google Shopping feed</h3>
        <label style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', cursor: 'pointer', marginTop: '0.75rem' }}>
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={saving}
            onChange={(e) => void save({ enabled: e.target.checked })}
            style={{ marginTop: '0.2rem' }}
          />
          <span>
            <span style={{ display: 'block', color: 'var(--color-text)' }}>Serve the product feed</span>
            <span style={hint}>Switched off, the feed address below answers with nothing at all, and Google is none the wiser it exists.</span>
          </span>
        </label>
      </section>

      <section style={card}>
        <h3 style={legend}>Feed address</h3>
        <span style={hint}>
          Paste this into Google Merchant Center (Products → Data sources → Add a file → scheduled fetch). Google re-reads it on its own
          schedule; every product variation goes along as its own listing.
        </span>
        {settings.feedUrl ? (
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
            <input type="text" readOnly value={settings.feedUrl} onFocus={(e) => e.target.select()} style={{ ...inputStyle, maxWidth: 560 }} />
            <button type="button" className="btn" disabled={saving} onClick={() => void copyFeedUrl(settings.feedUrl!)}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        ) : (
          <p style={{ color: 'var(--color-text-muted)', marginTop: '0.75rem' }}>The address appears once the site knows its own URL.</p>
        )}
        <div style={{ marginTop: '0.75rem' }}>
          <button
            type="button"
            className="btn"
            disabled={saving}
            onClick={() => {
              if (window.confirm('Mint a new feed address? The old one stops working straight away, and Merchant Center will need the new address.')) {
                void save({ regenerateToken: true })
              }
            }}
          >
            New address
          </button>
          <span style={hint}>The address carries its own key, so only Google and you know it. If it leaks, mint a new one.</span>
        </div>
      </section>

      <section style={card}>
        <h3 style={legend}>Defaults</h3>
        <label style={{ display: 'block', marginTop: '0.75rem' }}>
          <span style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.25rem' }}>Brand</span>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <input
              type="text"
              value={brandDraft}
              placeholder="e.g. your own trading name"
              onChange={(e) => setBrandDraft(e.target.value)}
              style={inputStyle}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || brandDraft === settings.defaultBrand}
              onClick={() => void save({ defaultBrand: brandDraft.trim() })}
            >
              Save brand
            </button>
          </div>
          <span style={hint}>Written on every listing that has no brand of its own (set per product on its Google Shopping tab). Google wants one on almost everything.</span>
        </label>
        <label style={{ display: 'block', marginTop: '1rem' }}>
          <span style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.25rem' }}>Condition</span>
          <select
            value={settings.defaultCondition}
            disabled={saving}
            onChange={(e) => void save({ defaultCondition: e.target.value as GsfCondition })}
            style={{ ...inputStyle, maxWidth: 220 }}
          >
            {GSF_CONDITIONS.map((c) => (
              <option key={c} value={c}>{CONDITION_LABELS[c]}</option>
            ))}
          </select>
          <span style={hint}>What Google is told unless a product says otherwise. Almost always New.</span>
        </label>
      </section>

      {saved && <p style={{ color: 'var(--color-success, var(--color-text))', fontSize: '0.875rem' }}>Saved.</p>}
      {error && <p role="alert" style={{ color: 'var(--color-danger)', fontSize: '0.875rem' }}>{error}</p>}
    </div>
  )
}
