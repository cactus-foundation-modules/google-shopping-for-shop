'use client'

// A feed-only title template box with a live preview: what Google will be
// sent, how long it is against Google's limits, which tokens do not exist, and
// a palette of this item's tokens to drop in at the cursor. The preview runs
// the feed's own renderer, so what it shows is what the feed sends.
import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { clip } from '@/modules/google-shopping-for-shop/lib/feed-xml'
import {
  GOOGLE_TITLE_MAX,
  GOOGLE_TITLE_VISIBLE,
  renderTitleTemplate,
  type TitleTemplateContext,
} from '@/modules/google-shopping-for-shop/lib/title-template-render'

type Props = {
  label: string
  value: string
  onChange: (value: string) => void
  /** The tokens to preview against; null shows no preview (nothing to fill from). */
  context: TitleTemplateContext | null
  /** The title the item carries with no template. */
  originalTitle: string
  placeholder: string
  dirty?: boolean
  disabled?: boolean
  /** Ctrl/Cmd + Enter. */
  onSubmit?: () => void
  children?: ReactNode
}

// Aliases that render the same as a token already offered; still accepted in a
// template, just not repeated in the palette.
const HIDDEN_ALIASES = new Set(['title', 'parent_product_title', 'color'])
const LEADING_TOKENS = ['original_title', 'parent_title', 'variant_label', 'options', 'brand', 'sku', 'mpn', 'gtin', 'colour', 'size', 'material']

function paletteOf(context: TitleTemplateContext): Array<[string, string]> {
  const entries = Object.entries(context).filter(([token]) => !HIDDEN_ALIASES.has(token))
  const rank = (token: string) => {
    const index = LEADING_TOKENS.indexOf(token)
    return index === -1 ? LEADING_TOKENS.length : index
  }
  return entries.sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
}

export function TemplateEditor({ label, value, onChange, context, originalTitle, placeholder, dirty = false, disabled = false, onSubmit, children }: Props) {
  const inputId = useId()
  const previewId = useId()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [tokensOpen, setTokensOpen] = useState(false)

  const rendered = useMemo(
    () => (context ? renderTitleTemplate(value, context, originalTitle) : null),
    [context, value, originalTitle],
  )
  const palette = useMemo(() => (context ? paletteOf(context) : []), [context])

  function insertToken(token: string) {
    const element = textareaRef.current
    const insert = `<${token}>`
    const start = element?.selectionStart ?? value.length
    const end = element?.selectionEnd ?? value.length
    const before = value.slice(0, start)
    const spacer = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
    const next = `${before}${spacer}${insert}${value.slice(end)}`
    onChange(next)
    const caret = start + spacer.length + insert.length
    requestAnimationFrame(() => {
      element?.focus()
      element?.setSelectionRange(caret, caret)
    })
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && onSubmit) {
      event.preventDefault()
      onSubmit()
    }
  }

  const length = rendered?.title.length ?? 0
  const over = length > GOOGLE_TITLE_MAX
  // Cut exactly where the feed cuts: at 150, back to a word when one is near.
  const kept = rendered && over ? clip(rendered.title, GOOGLE_TITLE_MAX) : rendered?.title ?? ''

  return (
    <div className={`gsw-editor${dirty ? ' is-dirty' : ''}`}>
      <label htmlFor={inputId} className="gsw-sr">{label}</label>
      <textarea
        id={inputId}
        ref={textareaRef}
        value={value}
        rows={2}
        maxLength={500}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        aria-describedby={rendered ? previewId : undefined}
      />
      {rendered && (
        <div className="gsw-preview" id={previewId}>
          <span className="gsw-preview-label">
            {value.trim() ? 'Google will be sent' : 'No template - Google gets the site title'}
          </span>
          <span className="gsw-preview-title">
            {over ? (
              <>
                {kept}
                <span className="gsw-preview-cut" title="The feed cuts titles at 150 characters">{rendered.title.slice(kept.length)}</span>
              </>
            ) : rendered.title}
          </span>
          <span className={`gsw-length${over ? ' is-over' : ''}`}>
            {length} / {GOOGLE_TITLE_MAX} characters
            {over ? ' - the struck-out end is cut off' : length > GOOGLE_TITLE_VISIBLE ? ` - about the first ${GOOGLE_TITLE_VISIBLE} show in results` : ''}
          </span>
          {rendered.unknownTokens.length > 0 && (
            <span className="gsw-warn">
              Not a token on this item, so left out: {rendered.unknownTokens.join(', ')}
            </span>
          )}
        </div>
      )}
      <div className="gsw-editor-actions">
        {children}
        <span className="gsw-spacer" />
        {palette.length > 0 && (
          <button type="button" className="gsw-linkish" aria-expanded={tokensOpen} onClick={() => setTokensOpen((open) => !open)}>
            {tokensOpen ? 'Hide tokens' : 'Insert a token'}
          </button>
        )}
      </div>
      {tokensOpen && palette.length > 0 && (
        <div className="gsw-tokens" role="group" aria-label="Tokens for this item">
          {palette.map(([token, tokenValue]) => (
            <button key={token} type="button" className="gsw-token" disabled={disabled} title={`Insert <${token}> - ${tokenValue}`} onClick={() => insertToken(token)}>
              <span className="gsw-token-name">&lt;{token}&gt;</span>
              <span className="gsw-token-value">{tokenValue}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
