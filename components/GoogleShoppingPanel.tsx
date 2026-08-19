'use client'

// Client half of the product editor's Google Shopping tab. Own save button, own
// module API - the editor's Save knows nothing about these fields.
import { useState } from 'react'
import { GSF_CONDITIONS, type GsfCondition, type GsfProductData } from '@/modules/google-shopping-for-shop/lib/types'

const BASE = '/api/m/google-shopping-for-shop/admin'

const field = { display: 'block', marginBottom: '1rem', maxWidth: 480 } as const
const labelStyle = { display: 'block', fontSize: '0.875rem', fontWeight: 600 as const, marginBottom: '0.25rem' }
const hint = { display: 'block', fontSize: '0.8125rem', color: 'var(--color-text-muted)', marginTop: '0.25rem' } as const
const inputStyle = {
  font: 'inherit',
  fontSize: '0.875rem',
  padding: '0.5rem 0.625rem',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  background: 'var(--color-bg)',
  color: 'var(--color-fg)',
  width: '100%',
} as const

const CONDITION_LABELS: Record<GsfCondition, string> = {
  new: 'New',
  refurbished: 'Refurbished',
  used: 'Used',
}

export function GoogleShoppingPanel({ initial }: { initial: GsfProductData }) {
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  function set<K extends keyof GsfProductData>(key: K, value: GsfProductData[K]) {
    setForm((f) => ({ ...f, [key]: value }))
    setSaved(false)
  }

  async function save() {
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const res = await fetch(`${BASE}/product-data`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const body = (await res.json()) as { data?: GsfProductData; error?: string }
      if (!res.ok || !body.data) throw new Error(body.error ?? 'Save failed')
      setForm(body.data)
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const text = (value: string | null) => value ?? ''

  return (
    <div style={{ padding: '0.25rem 0' }}>
      <p style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)', margin: '0 0 1rem', maxWidth: 640 }}>
        Extra details for this product&apos;s Google Shopping listings. Variations share these; each variation&apos;s own barcode
        travels as its identifier. Everything here is optional - the feed fills in sensible answers without it.
      </p>

      <label style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', cursor: 'pointer', marginBottom: '1.25rem' }}>
        <input
          type="checkbox"
          checked={form.excluded}
          onChange={(e) => set('excluded', e.target.checked)}
          style={{ marginTop: '0.2rem' }}
        />
        <span>
          <span style={{ display: 'block', color: 'var(--color-text)' }}>Keep this product out of the feed</span>
          <span style={hint}>The product and every variation of it sit Google Shopping out.</span>
        </span>
      </label>

      <label style={field}>
        <span style={labelStyle}>Brand</span>
        <input type="text" value={text(form.brand)} placeholder="Blank uses the supplier, then the shop-wide default" onChange={(e) => set('brand', e.target.value || null)} style={inputStyle} />
      </label>

      <label style={field}>
        <span style={labelStyle}>GTIN (barcode)</span>
        <input type="text" value={text(form.gtin)} onChange={(e) => set('gtin', e.target.value || null)} style={inputStyle} />
        <span style={hint}>8, 12, 13 or 14 digits. Only used when the product has no barcode of its own; variations always use their own barcodes.</span>
      </label>

      <label style={field}>
        <span style={labelStyle}>MPN</span>
        <input type="text" value={text(form.mpn)} onChange={(e) => set('mpn', e.target.value || null)} style={inputStyle} />
        <span style={hint}>The manufacturer&apos;s part number, if the maker publishes one. Left blank, Google is told the product has no standard identifiers - which is fine.</span>
      </label>

      <label style={field}>
        <span style={labelStyle}>Google product category</span>
        <input
          type="text"
          value={text(form.googleProductCategory)}
          placeholder="e.g. Furniture > Office Furniture > Desks"
          onChange={(e) => set('googleProductCategory', e.target.value || null)}
          style={inputStyle}
        />
        <span style={hint}>A value from Google&apos;s own category list. Optional - Google usually files things correctly on its own.</span>
      </label>

      <label style={field}>
        <span style={labelStyle}>Condition</span>
        <select
          value={form.condition ?? ''}
          onChange={(e) => set('condition', (e.target.value || null) as GsfCondition | null)}
          style={{ ...inputStyle, maxWidth: 220 }}
        >
          <option value="">Shop default</option>
          {GSF_CONDITIONS.map((c) => (
            <option key={c} value={c}>{CONDITION_LABELS[c]}</option>
          ))}
        </select>
      </label>

      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save Google details'}
        </button>
        {saved && <span style={{ color: 'var(--color-success, var(--color-text))', fontSize: '0.875rem' }}>Saved.</span>}
        {error && <span role="alert" style={{ color: 'var(--color-danger)', fontSize: '0.875rem' }}>{error}</span>}
      </div>
    </div>
  )
}
