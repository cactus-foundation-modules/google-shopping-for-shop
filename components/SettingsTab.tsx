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
  const [merchantDraft, setMerchantDraft] = useState('')
  const [feedLabelDraft, setFeedLabelDraft] = useState('')
  const [countryDraft, setCountryDraft] = useState('')
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
      setMerchantDraft(body.settings.merchantId)
      setFeedLabelDraft(body.settings.feedLabel)
      setCountryDraft(body.settings.shippingCountry)
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

  async function save(patch: { enabled?: boolean; defaultBrand?: string; brandFromSupplier?: boolean; defaultCondition?: GsfCondition; merchantId?: string; feedLabel?: string; sendDeliveryOptions?: boolean; shippingCountry?: string; regenerateToken?: boolean }) {
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
      setMerchantDraft(body.settings.merchantId)
      setFeedLabelDraft(body.settings.feedLabel)
      setCountryDraft(body.settings.shippingCountry)
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
        <h3 style={legend}>Your Merchant Center account</h3>
        <span style={hint}>
          Fill these in and every product gains a link straight to its own listing in Merchant Center, one per variation, on the
          product&apos;s Google Shopping tab. Nothing else depends on them - the feed works perfectly well without.
        </span>
        <label style={{ display: 'block', marginTop: '0.75rem' }}>
          <span style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.25rem' }}>Account number</span>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <input
              type="text"
              inputMode="numeric"
              value={merchantDraft}
              placeholder="e.g. 123456789"
              onChange={(e) => setMerchantDraft(e.target.value)}
              style={{ ...inputStyle, maxWidth: 220 }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || merchantDraft === settings.merchantId}
              onClick={() => void save({ merchantId: merchantDraft })}
            >
              Save account
            </button>
          </div>
          <span style={hint}>Merchant Center shows it at the top right of its own pages. Spaces and dashes are fine - only the numbers are kept.</span>
        </label>
        <label style={{ display: 'block', marginTop: '1rem' }}>
          <span style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.25rem' }}>Feed label</span>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <input
              type="text"
              value={feedLabelDraft}
              placeholder="e.g. GB"
              onChange={(e) => setFeedLabelDraft(e.target.value)}
              style={{ ...inputStyle, maxWidth: 160 }}
            />
            <button
              type="button"
              className="btn"
              disabled={saving || feedLabelDraft === settings.feedLabel}
              onClick={() => void save({ feedLabel: feedLabelDraft })}
            >
              Save label
            </button>
          </div>
          <span style={hint}>Whatever Merchant Center lists against your feed, usually the country you sell into. Leave it blank and the links still work, Google just asks which feed you meant.</span>
        </label>
      </section>

      <section style={card}>
        <h3 style={legend}>Delivery</h3>
        <span style={hint}>
          Google can be told your own delivery charges and how long each service takes, product by product, instead of working from the
          flat rates set up in your Merchant Center account.
        </span>
        {!settings.deliveryOptionsAvailable && (
          <p style={{ ...hint, marginTop: '0.75rem' }}>
            Nothing on this site publishes delivery services at the moment, so there is nothing for the switch below to send. Install a
            delivery module and it fills itself in.
          </p>
        )}
        <label style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', cursor: 'pointer', marginTop: '0.75rem' }}>
          <input
            type="checkbox"
            checked={settings.sendDeliveryOptions}
            disabled={saving || !settings.deliveryOptionsAvailable}
            onChange={(e) => void save({ sendDeliveryOptions: e.target.checked })}
            style={{ marginTop: '0.2rem' }}
          />
          <span>
            <span style={{ display: 'block', color: 'var(--color-text)' }}>Send your delivery charges with each product</span>
            <span style={hint}>
              Every service a product can be bought with goes along with it, priced and dated. Google quotes the cheapest one a shopper
              can have, so a product with a free option is advertised as free delivery. Worth knowing: while this is on, your Merchant
              Center delivery rates no longer apply to anything in the feed - these charges do.
            </span>
          </span>
        </label>
        <label style={{ display: 'block', marginTop: '1rem' }}>
          <span style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.25rem' }}>Country these charges apply to</span>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <input
              type="text"
              value={countryDraft}
              placeholder="GB"
              maxLength={2}
              onChange={(e) => setCountryDraft(e.target.value.toUpperCase())}
              style={{ ...inputStyle, maxWidth: 120 }}
            />
            <button
              type="button"
              className="btn"
              disabled={saving || countryDraft === settings.shippingCountry}
              onClick={() => void save({ shippingCountry: countryDraft })}
            >
              Save country
            </button>
          </div>
          <span style={hint}>Two letters, the country you deliver to - GB for the United Kingdom. Google insists on knowing.</span>
        </label>
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
          <span style={hint}>The last resort, used only when a listing has no brand of its own (set per product on its Google Shopping tab) and nothing below fills one in. Google wants one on almost everything.</span>
        </label>
        <label style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', cursor: 'pointer', marginTop: '1rem' }}>
          <input
            type="checkbox"
            checked={settings.brandFromSupplier}
            disabled={saving}
            onChange={(e) => void save({ brandFromSupplier: e.target.checked })}
            style={{ marginTop: '0.2rem' }}
          />
          <span>
            <span style={{ display: 'block', color: 'var(--color-text)' }}>Use the supplier as the brand</span>
            <span style={hint}>Takes the brand from whoever you buy the product from, saving you typing one on each listing. Worth switching off if your suppliers are middlemen rather than the names on the box.</span>
          </span>
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
