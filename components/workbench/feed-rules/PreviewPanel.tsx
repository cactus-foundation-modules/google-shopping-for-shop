'use client'

// What saving the rule would change, from a dry run over the whole catalogue:
// how many items it catches, how many would actually change and how, and the
// first few of them by name.
import type { RulePreview } from '@/modules/google-shopping-for-shop/lib/feed-rules/preview'
import { formatCount, plural } from '@/modules/google-shopping-for-shop/components/workbench/format'

export type PreviewState =
  | { status: 'idle' }
  | { status: 'loading'; key: string }
  | { status: 'ready'; key: string; preview: RulePreview }
  | { status: 'error'; key: string; message: string }

type Props = {
  state: PreviewState
  /** False once the rule has been edited since this preview was taken. */
  current: boolean
  ruleEnabled: boolean
}

export function PreviewPanel({ state, current, ruleEnabled }: Props) {
  if (state.status === 'idle') {
    return <p className="gsw-muted gsw-small">Preview the rule to see exactly which items it changes. It can be saved once you have.</p>
  }
  if (state.status === 'loading') {
    return (
      <p className="gsw-message is-info" role="status">
        <span className="gsw-spinner" aria-hidden /> Running it over the catalogue. The first time can take a few seconds while the shop is read.
      </p>
    )
  }
  if (state.status === 'error') return <p className="gsw-message is-error" role="alert">{state.message}</p>

  const { preview } = state
  const { changes } = preview
  const lines: string[] = []
  if (changes.leaves > 0) lines.push(`${plural(changes.leaves, 'item')} would be kept out of the feed`)
  if (changes.returns > 0) lines.push(`${plural(changes.returns, 'item')} would go back into the feed`)
  if (changes.label > 0) lines.push(`${plural(changes.label, 'item')} would have a custom label changed`)
  if (changes.title > 0) lines.push(`${plural(changes.title, 'item')} would be sent a different title`)
  if (changes.identifiers > 0) lines.push(`${plural(changes.identifiers, 'item')} would say something different about identifiers`)

  return (
    <section className={`gsr-preview${current ? '' : ' is-stale'}`} aria-live="polite" aria-label="Preview">
      {!current && <p className="gsw-message is-info" role="status">The rule has changed since this preview. Preview again before saving.</p>}
      <p className="gsr-preview-lede">
        Matches <strong>{plural(preview.matched, 'item')}</strong> of {formatCount(preview.catalogue)}.
        {' '}{preview.affected === 0 ? 'Saving it would change nothing.' : <>Saving it would change <strong>{plural(preview.affected, 'item')}</strong>.</>}
      </p>
      {!ruleEnabled && <p className="gsw-small gsw-muted">This is what it would do once switched on. Saved switched off, it changes nothing yet.</p>}
      {lines.length > 0 && <ul className="gsr-preview-list">{lines.map((line) => <li key={line}>{line}</li>)}</ul>}
      {(preview.heldByHand > 0 || preview.alreadyCovered > 0) && (
        <p className="gsw-small gsw-muted">
          {preview.heldByHand > 0 && <>{plural(preview.heldByHand, 'matching item')} {preview.heldByHand === 1 ? 'has' : 'have'} a choice set by hand, which beats any rule. </>}
          {preview.alreadyCovered > 0 && <>{plural(preview.alreadyCovered, 'matching item')} {preview.alreadyCovered === 1 ? 'is' : 'are'} already as this rule would leave {preview.alreadyCovered === 1 ? 'it' : 'them'}, often because a rule higher up does the same job.</>}
        </p>
      )}
      {preview.samples.length > 0 && (
        <details className="gsr-samples" open={preview.samples.length <= 10}>
          <summary>{preview.affected > preview.samples.length ? `The first ${formatCount(preview.samples.length)} of them` : 'Which ones'}</summary>
          <ul>
            {preview.samples.map((sample) => (
              <li key={sample.id}>
                <span className="gsr-sample-title">{sample.title}</span>
                <span className="gsw-small gsw-muted">{sample.changes.join('; ')}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
