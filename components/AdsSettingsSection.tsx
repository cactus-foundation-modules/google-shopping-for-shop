'use client'

// The Google Ads connection, on the Google Shopping settings tab.
//
// Google Ads is a SEPARATE account from Merchant Center with a SEPARATE
// sign-in, and the whole job of this section is to make that obvious rather
// than leaving an owner wondering why the service-account key they already
// pasted in did not cover it.
//
// Stored the way the service-account key is stored: pasted here, saved through
// core's own environment-variable route, and never read back. The section shows
// only whether each one is set. Nothing here ever displays, masks or reports
// the length of a value.
//
// The check button mirrors the Merchant Center one next to it: it asks Google
// four questions on a press and changes nothing at all.
import { useCallback, useEffect, useState } from 'react'
import { ADS_ENV_COPY, ADS_ENV_VARS, type AdsEnvVar } from '@/modules/google-shopping-for-shop/lib/google-ads/types'
import type { AdsAccessReport } from '@/modules/google-shopping-for-shop/lib/google-ads/access-check'

const BASE = '/api/m/google-shopping-for-shop/admin'

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

// Tokens, so the marks read the same in both themes. The word beside each one
// carries the meaning; the colour only helps it along.
const TONE: Record<AdsAccessReport['probes'][number]['status'], { mark: string; colour: string; word: string }> = {
  ok: { mark: '✓', colour: 'var(--color-success)', word: 'Yes' },
  denied: { mark: '✕', colour: 'var(--color-danger)', word: 'No' },
  unknown: { mark: '?', colour: 'var(--color-text-muted)', word: 'Not known' },
}

type Drafts = Partial<Record<AdsEnvVar, string>>

export function AdsSettingsSection() {
  const [present, setPresent] = useState<Record<string, boolean>>({})
  const [drafts, setDrafts] = useState<Drafts>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [checking, setChecking] = useState(false)
  const [report, setReport] = useState<AdsAccessReport | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/env')
      const body = response.ok ? (await response.json()) as { vars?: Record<string, boolean> } : { vars: {} }
      setPresent(body.vars ?? {})
    } catch {
      // Not worth an error banner: the section still works, it just cannot say
      // which values are already there.
      setPresent({})
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

  const save = useCallback(async () => {
    const vars = ADS_ENV_VARS
      .map((key) => ({ key, value: (drafts[key] ?? '').trim() }))
      .filter((entry) => entry.value !== '')
    if (vars.length === 0) return

    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const response = await fetch('/api/admin/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vars }),
      })
      const body = (await response.json()) as { error?: string }
      if (!response.ok) throw new Error(body.error ?? 'Could not save your Google Ads details')
      setDrafts({})
      setPresent((held) => ({ ...held, ...Object.fromEntries(vars.map((entry) => [entry.key, true])) }))
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save your Google Ads details')
    } finally {
      setSaving(false)
    }
  }, [drafts])

  const check = useCallback(async () => {
    setChecking(true)
    setError('')
    try {
      const response = await fetch(`${BASE}/ads/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job: 'check' }),
      })
      const body = (await response.json()) as { access?: AdsAccessReport; error?: string }
      if (!response.ok || !body.access) throw new Error(body.error ?? 'Could not check your Google Ads connection')
      setReport(body.access)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not check your Google Ads connection')
    } finally {
      setChecking(false)
    }
  }, [])

  const missingRequired = ADS_ENV_VARS.filter((key) => ADS_ENV_COPY[key].required && present[key] !== true)

  return (
    <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--color-border)' }}>
      <h4 style={{ fontSize: '0.875rem', fontWeight: 600, margin: '0 0 0.25rem' }}>Google Ads</h4>
      <span style={hint}>
        Your paid Shopping adverts live in Google Ads, which is a different account from Merchant Center and signs in a different
        way - the service-account key above does not cover it. Fill these in and Cactus can show what the adverts cost, and tell
        Google Ads which of its clicks turned into a sale. Everything to do with it is switched on separately, on the Google
        Shopping tab under Products, in Health.
      </span>

      {missingRequired.length === 0
        ? <p style={{ ...hint, marginTop: '0.5rem' }}>All four are saved. Press &ldquo;Check the connection&rdquo; below to see what Google will let this site do.</p>
        : <p style={{ ...hint, marginTop: '0.5rem' }}>Not connected yet - {missingRequired.length} of the four still to fill in.</p>}

      {ADS_ENV_VARS.map((key) => (
        <label key={key} style={{ display: 'block', marginTop: '0.75rem' }}>
          <span style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.25rem' }}>
            {ADS_ENV_COPY[key].label}
            {!ADS_ENV_COPY[key].required && <span style={{ color: 'var(--color-text-muted)' }}> (optional)</span>}
            {' '}
            <span style={{ color: present[key] ? 'var(--color-success)' : 'var(--color-text-muted)', fontSize: '0.8125rem' }}>
              {present[key] ? '✓ saved' : 'not set'}
            </span>
          </span>
          <input
            type={key === 'GOOGLE_ADS_CUSTOMER_ID' || key === 'GOOGLE_ADS_LOGIN_CUSTOMER_ID' ? 'text' : 'password'}
            value={drafts[key] ?? ''}
            spellCheck={false}
            autoComplete="off"
            placeholder={present[key] ? 'Saved - type here only to replace it' : ''}
            onChange={(event) => setDrafts((held) => ({ ...held, [key]: event.target.value }))}
            style={inputStyle}
          />
          <span style={hint}>{ADS_ENV_COPY[key].where}</span>
        </label>
      ))}

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
        <button
          type="button"
          className="btn"
          disabled={saving || ADS_ENV_VARS.every((key) => (drafts[key] ?? '').trim() === '')}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : saved ? 'Saved' : 'Save Google Ads details'}
        </button>
        <button type="button" className="btn" disabled={checking} onClick={() => void check()}>
          {checking ? 'Asking Google…' : 'Check the connection'}
        </button>
      </div>
      <span style={hint}>Cactus stores these as environment variables and never shows them again. Nothing is changed by checking.</span>

      {error && <p role="alert" style={{ color: 'var(--color-danger)', fontSize: '0.875rem', marginTop: '0.75rem' }}>{error}</p>}

      {report && (
        <div style={{ marginTop: '0.75rem', border: '1px solid var(--color-border)', borderRadius: 8, padding: '0.75rem 0.875rem' }}>
          <p style={{ margin: '0 0 0.5rem', fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>
            {report.accountName
              ? <>Google Ads answered for <strong style={{ color: 'var(--color-text)' }}>{report.accountName}</strong>{report.customerId ? <> ({report.customerId})</> : null}.</>
              : <>Asked about account {report.customerId ?? 'not set'}.</>}
            {report.loginCustomerId && <> Signed in through manager account {report.loginCustomerId}.</>}
            {report.currency && <> It bills in {report.currency}.</>}
          </p>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {report.probes.map((probe) => (
              <li key={probe.id} style={{ display: 'flex', gap: '0.625rem', alignItems: 'flex-start', padding: '0.375rem 0' }}>
                <span aria-hidden style={{ color: TONE[probe.status].colour, fontWeight: 700, lineHeight: 1.4 }}>{TONE[probe.status].mark}</span>
                <span>
                  <span style={{ display: 'block', fontSize: '0.875rem', color: 'var(--color-text)' }}>
                    {probe.label} - <strong>{TONE[probe.status].word}</strong>
                  </span>
                  <span style={hint}>{probe.detail}</span>
                </span>
              </li>
            ))}
          </ul>
          <p style={{ ...hint, marginTop: '0.5rem' }}>Checked {new Date(report.checkedAt).toLocaleString('en-GB')}.</p>
        </div>
      )}
    </div>
  )
}
