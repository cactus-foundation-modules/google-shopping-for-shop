'use client'

// "What is this key actually allowed to do?", on the settings tab.
//
// The three things the site asks of Google need different access levels in
// Merchant Center, and the difference only shows up when a job fails halfway
// through with Google's own wording. This asks up front, on a button press, and
// says what to change when the answer is no.
//
// It runs on demand rather than on load: three calls out to Google every time
// somebody opened a settings tab would be three calls too many.
import { useState } from 'react'
import type { AccessProbe, AccessReport } from '@/modules/google-shopping-for-shop/lib/google/access-check'

const BASE = '/api/m/google-shopping-for-shop/admin'

const hint = { display: 'block', fontSize: '0.8125rem', color: 'var(--color-text-muted)', marginTop: '0.25rem' } as const

// Tokens, so the marks read the same in both themes. The word beside each one
// carries the meaning; the colour is only there to help it along.
const TONE: Record<AccessProbe['status'], { mark: string; colour: string; word: string }> = {
  ok: { mark: '✓', colour: 'var(--color-success)', word: 'Yes' },
  denied: { mark: '✕', colour: 'var(--color-danger)', word: 'No' },
  unknown: { mark: '?', colour: 'var(--color-text-muted)', word: 'Not known' },
}

export function GoogleAccessCheck() {
  const [report, setReport] = useState<AccessReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')

  async function check() {
    setChecking(true)
    setError('')
    try {
      const res = await fetch(`${BASE}/google-access`, { method: 'POST' })
      const body = (await res.json()) as { access?: AccessReport; error?: string }
      if (!res.ok || !body.access) throw new Error(body.error ?? 'Could not check your Google access')
      setReport(body.access)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check your Google access')
    } finally {
      setChecking(false)
    }
  }

  return (
    <div style={{ marginTop: '1rem' }}>
      <button type="button" className="btn" disabled={checking} onClick={() => void check()}>
        {checking ? 'Asking Google…' : 'Check what this key can do'}
      </button>
      <span style={hint}>Three quick questions to Google. Nothing is changed by asking.</span>

      {error && <p role="alert" style={{ color: 'var(--color-danger)', fontSize: '0.875rem', marginTop: '0.75rem' }}>{error}</p>}

      {report && (
        <div style={{ marginTop: '0.75rem', border: '1px solid var(--color-border)', borderRadius: 8, padding: '0.75rem 0.875rem' }}>
          {report.serviceAccountEmail && (
            <p style={{ margin: '0 0 0.5rem', fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>
              Asking as <code style={{ fontFamily: 'var(--font-mono, monospace)', color: 'var(--color-text)' }}>{report.serviceAccountEmail}</code>
              {report.merchantId ? <> on account {report.merchantId}.</> : '.'}
              {' '}That is the address to add in Merchant Center under People and access.
            </p>
          )}
          {report.credentials === 'missing' && (
            <p style={{ margin: '0 0 0.5rem', fontSize: '0.875rem', color: 'var(--color-text)' }}>
              No service-account key is saved yet, so there is nothing to check with. Follow the four steps above first.
            </p>
          )}
          {report.credentials === 'malformed' && (
            <p style={{ margin: '0 0 0.5rem', fontSize: '0.875rem', color: 'var(--color-danger)' }}>
              What is saved is not a Google service-account key. Download the JSON key file again and paste the whole thing into the box above.
            </p>
          )}
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
          <p style={{ ...hint, marginTop: '0.5rem' }}>
            Checked {new Date(report.checkedAt).toLocaleString('en-GB')}.
          </p>
        </div>
      )}
    </div>
  )
}
