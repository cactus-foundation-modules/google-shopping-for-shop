'use client'

// A sub-tab that exists but has nothing in it yet.
//
// The tabs go in before the screens behind them, so the shape of the workbench
// settles once rather than moving under the owner every release. A tab that
// says plainly what it is for and when it arrives is a promise; a tab that
// opens on nothing at all is a bug report.
import type { ReactNode } from 'react'

type Props = {
  title: string
  /** What this tab will do, in the owner's terms. */
  blurb: string
  /** What it will show, as a short list. */
  points: readonly string[]
  /** Where to go in the meantime. */
  footer?: ReactNode
}

const panel = {
  border: '1px dashed var(--color-border)',
  borderRadius: 12,
  padding: '1.5rem',
  background: 'var(--color-surface)',
  maxWidth: 640,
} as const

export function ComingSoon({ title, blurb, points, footer }: Props) {
  return (
    <section style={panel} aria-label={title}>
      <h2 style={{ fontSize: '1.0625rem', fontWeight: 600, margin: '0 0 0.5rem', color: 'var(--color-text)' }}>{title}</h2>
      <p style={{ margin: '0 0 0.75rem', fontSize: '0.9375rem', color: 'var(--color-text-secondary)' }}>{blurb}</p>
      <p style={{ margin: '0 0 0.375rem', fontSize: '0.875rem', color: 'var(--color-text-muted)' }}>It will show:</p>
      <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.875rem', color: 'var(--color-text-muted)' }}>
        {points.map((point) => (
          <li key={point} style={{ marginBottom: '0.25rem' }}>{point}</li>
        ))}
      </ul>
      {footer && (
        <p style={{ margin: '1rem 0 0', fontSize: '0.875rem', color: 'var(--color-text-muted)' }}>{footer}</p>
      )}
    </section>
  )
}
