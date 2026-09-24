'use client'

// Client half of the product editor's Google Shopping tab. Own save button, own
// module API - the editor's Save knows nothing about these fields.
//
// The feed choice is three-way: follow the feed rules (the default), always
// send, never send. The owner's choice beats every rule, and a variation's own
// choice beats its listing's. Both saves come back with an Undo, which goes
// through the workbench change log like every other change to the feed.
import { useState } from 'react'
import { FEED_CHOICES, GSF_CONDITIONS, type FeedChoice, type GsfCondition, type GsfProductData } from '@/modules/google-shopping-for-shop/lib/types'
import { FEED_CHOICE_LABELS, VARIATION_CHOICE_LABELS } from '@/modules/google-shopping-for-shop/lib/feed-choice-copy'

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

const CHOICE_HINTS: Record<FeedChoice, string> = {
  rules: 'Goes to Google unless one of the feed rules keeps it out.',
  include: 'Goes to Google whatever the feed rules say.',
  exclude: 'The product and every variation of it sit Google Shopping out, whatever the rules say.',
}

export type PanelVariation = { id: string; label: string; enabled: boolean; choice: FeedChoice }

async function undoChange(id: string): Promise<void> {
  const res = await fetch(`${BASE}/change-log/undo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  const body = (await res.json().catch(() => null)) as { error?: string; restored?: number } | null
  if (!res.ok) throw new Error(body?.error ?? 'Could not undo that')
  if (!body?.restored) throw new Error('It had been changed again since, so it was left as it is.')
}

function VariationChoices({ productId, initial }: { productId: string; initial: PanelVariation[] }) {
  const [saved, setSaved] = useState(initial)
  const [draft, setDraft] = useState<Record<string, FeedChoice>>(() => Object.fromEntries(initial.map((v) => [v.id, v.choice])))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string; undoId?: string | null } | null>(null)

  const dirty = saved.some((v) => draft[v.id] !== v.choice)

  async function save() {
    setBusy(true)
    setMessage(null)
    try {
      const choices = saved.filter((v) => draft[v.id] !== v.choice).map((v) => ({ variationId: v.id, choice: draft[v.id] ?? 'rules' }))
      const res = await fetch(`${BASE}/product-data/variations`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, choices }),
      })
      const body = (await res.json().catch(() => null)) as { error?: string; changed?: number; changeId?: string | null } | null
      if (!res.ok) throw new Error(body?.error ?? 'Save failed')
      setSaved((list) => list.map((v) => ({ ...v, choice: draft[v.id] ?? v.choice })))
      setMessage({ tone: 'ok', text: 'Saved. Google picks it up the next time it fetches the feed.', undoId: body?.changeId ?? null })
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : 'Save failed' })
    } finally {
      setBusy(false)
    }
  }

  async function undo(id: string) {
    setBusy(true)
    try {
      await undoChange(id)
      const res = await fetch(`${BASE}/product-data/variations?${new URLSearchParams({ productId })}`, { cache: 'no-store' })
      const body = (await res.json().catch(() => null)) as { variations?: PanelVariation[] } | null
      const fresh = body?.variations ?? saved
      setSaved(fresh)
      setDraft(Object.fromEntries(fresh.map((v) => [v.id, v.choice])))
      setMessage({ tone: 'ok', text: 'Put back as it was.' })
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : 'Could not undo that' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <fieldset style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: '0.75rem 1rem', margin: '0 0 1.25rem', maxWidth: 640 }}>
      <legend style={{ ...labelStyle, padding: '0 0.25rem', marginBottom: 0 }}>Each variation</legend>
      <p style={{ ...hint, marginTop: 0, marginBottom: '0.75rem' }}>
        &ldquo;As the product&rdquo; does whatever the choice above does. Either of the others beats it, and every feed rule, for that variation alone.
      </p>
      <div style={{ display: 'grid', gap: '0.375rem' }}>
        {saved.map((variation) => (
          <label key={variation.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '0.875rem', color: 'var(--color-text)', minWidth: 0, overflowWrap: 'anywhere' }}>
              {variation.label || 'Unnamed variation'}
              {!variation.enabled && <span style={{ color: 'var(--color-text-muted)' }}> (switched off in the shop)</span>}
            </span>
            <select
              value={draft[variation.id] ?? 'rules'}
              disabled={busy}
              aria-label={`Google Shopping for ${variation.label || 'this variation'}`}
              onChange={(e) => {
                const value = FEED_CHOICES.find((c) => c === e.target.value) ?? 'rules'
                setDraft((d) => ({ ...d, [variation.id]: value }))
                setMessage(null)
              }}
              style={{ ...inputStyle, width: 'auto', minWidth: 170 }}
            >
              {FEED_CHOICES.map((c) => <option key={c} value={c}>{VARIATION_CHOICE_LABELS[c]}</option>)}
            </select>
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center', marginTop: '0.75rem' }}>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save variation choices'}
        </button>
        {message && (
          <span role={message.tone === 'error' ? 'alert' : 'status'} style={{ fontSize: '0.875rem', color: message.tone === 'error' ? 'var(--color-danger)' : 'var(--color-text)' }}>
            {message.text}
          </span>
        )}
        {message?.undoId && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void undo(message.undoId ?? '')}>Undo</button>
        )}
      </div>
    </fieldset>
  )
}

export function GoogleShoppingPanel({ initial, variations }: { initial: GsfProductData; variations: PanelVariation[] }) {
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [undoId, setUndoId] = useState<string | null>(null)

  function set<K extends keyof GsfProductData>(key: K, value: GsfProductData[K]) {
    setForm((f) => ({ ...f, [key]: value }))
    setSaved(false)
    setUndoId(null)
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
      const body = (await res.json().catch(() => ({}))) as { data?: GsfProductData; error?: string; changeId?: string | null }
      if (!res.ok || !body.data) throw new Error(body.error ?? 'Save failed')
      setForm(body.data)
      setSaved(true)
      setUndoId(body.changeId ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function undoChoice(id: string) {
    setSaving(true)
    setError('')
    try {
      await undoChange(id)
      const res = await fetch(`${BASE}/product-data?${new URLSearchParams({ productId: form.productId })}`, { cache: 'no-store' })
      const body = (await res.json().catch(() => ({}))) as { data?: GsfProductData }
      if (body.data) setForm(body.data)
      setUndoId(null)
      setSaved(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not undo that')
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

      <fieldset style={{ border: 0, padding: 0, margin: '0 0 1.25rem', maxWidth: 640 }}>
        <legend style={labelStyle}>Send to Google</legend>
        {FEED_CHOICES.map((choice) => (
          <label key={choice} style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', cursor: 'pointer', marginTop: '0.5rem' }}>
            <input
              type="radio"
              name={`gsf-feed-choice-${form.productId}`}
              value={choice}
              checked={form.feedChoice === choice}
              onChange={() => set('feedChoice', choice)}
              style={{ marginTop: '0.2rem' }}
            />
            <span>
              <span style={{ display: 'block', color: 'var(--color-text)' }}>{FEED_CHOICE_LABELS[choice]}</span>
              <span style={hint}>{CHOICE_HINTS[choice]}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {variations.length > 0 && <VariationChoices productId={form.productId} initial={variations} />}

      <p style={{ ...hint, maxWidth: 640, marginTop: 0, marginBottom: '1.25rem' }}>
        A feed rule can also keep this product out of Google. Only the choice above shows in the Merchant Center links
        further up this tab, and only it holds this product&apos;s reviews back from Google - a product kept out by a
        rule still appears in both, though Google ignores reviews for a product it is not being sent.
      </p>

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
        {saved && undoId && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={() => void undoChoice(undoId)}>Undo the Google choice</button>
        )}
        {error && <span role="alert" style={{ color: 'var(--color-danger)', fontSize: '0.875rem' }}>{error}</span>}
      </div>
    </div>
  )
}
