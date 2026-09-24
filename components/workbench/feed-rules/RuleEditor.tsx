'use client'

// Adding or changing one rule: its name, its conditions, what it does, and -
// before it can be saved - a preview of exactly what saving it would change.
//
// Save stays shut until the preview on screen is the preview of the rule on
// screen. Change anything and the preview is marked out of date and Save
// closes again: a count taken from an earlier draft is not a count of this
// one, and "I thought it only caught forty" is the mistake this exists to stop.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CUSTOM_LABEL_MAX,
  CUSTOM_LABEL_SLOTS,
  IDENTIFIER_MODES,
  RuleDraftSchema,
  normaliseDraft,
  ruleProblems,

  type IdentifierMode,
  type RuleAction,
  type RuleActionType,
  type RuleDraft,
} from '@/modules/google-shopping-for-shop/lib/feed-rules/types'
import { canonicalJson } from '@/modules/google-shopping-for-shop/lib/feed-rules/canonical'
import { ConditionGroupEditor, blankCondition, type BuilderContext } from '@/modules/google-shopping-for-shop/components/workbench/feed-rules/ConditionEditor'
import { PreviewPanel, type PreviewState } from '@/modules/google-shopping-for-shop/components/workbench/feed-rules/PreviewPanel'
import { previewDraft } from '@/modules/google-shopping-for-shop/components/workbench/feed-rules/api'

type Props = {
  /** Null when adding. */
  ruleId: string | null
  initial: RuleDraft
  ctx: Omit<BuilderContext, 'disabled'>
  saving: boolean
  onSave: (draft: RuleDraft) => void
  onCancel: () => void
}

const ACTION_LABELS: Record<RuleActionType, string> = {
  exclude: 'Keep them out of the feed',
  custom_label: 'Give them a custom label',
  title_template: 'Send them a title template',
  identifiers: 'Change what they say about identifiers',
}

const IDENTIFIER_LABELS: Record<IdentifierMode, string> = {
  no_identifiers: 'Say they have no identifiers (no barcode or part number)',
  mpn_from_sku: 'Send each one\'s SKU as its MPN',
  brand: 'Send a brand of your choosing',
}

function actionFor(type: RuleActionType, previous: RuleAction): RuleAction {
  if (type === previous.type) return previous
  switch (type) {
    case 'exclude': return { type: 'exclude' }
    case 'custom_label': return { type: 'custom_label', slot: 0, value: '' }
    case 'title_template': return { type: 'title_template', template: '' }
    case 'identifiers': return { type: 'identifiers', mode: 'no_identifiers' }
  }
}

export function newRuleDraft(ctx: Pick<BuilderContext, 'fields'>): RuleDraft {
  return { name: '', enabled: true, conditions: { op: 'all', items: [blankCondition(ctx.fields)] }, action: { type: 'exclude' } }
}

export function RuleEditor({ ruleId, initial, ctx, saving, onSave, onCancel }: Props) {
  const [draft, setDraft] = useState<RuleDraft>(initial)
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' })
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  const builder: BuilderContext = { ...ctx, disabled: saving }
  const kindOf = (field: string) => ctx.fieldByKey.get(field)?.kind ?? null
  const tidy = useMemo(() => {
    const parsed = RuleDraftSchema.safeParse(draft)
    return parsed.success ? normaliseDraft(parsed.data) : null
  }, [draft])
  const schemaError = useMemo(() => {
    const parsed = RuleDraftSchema.safeParse(draft)
    return parsed.success ? null : parsed.error.issues[0]?.message ?? 'The rule is not complete yet'
  }, [draft])
  const problems = tidy ? ruleProblems(tidy, kindOf) : []
  const blocker = schemaError ?? problems[0] ?? null
  const key = tidy ? canonicalJson(tidy) : ''
  const current = preview.status !== 'idle' && preview.key === key
  const canSave = !saving && blocker === null && preview.status === 'ready' && current

  async function runPreview() {
    if (!tidy || blocker) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const runKey = key
    setPreview({ status: 'loading', key: runKey })
    try {
      const result = await previewDraft(tidy, ruleId, controller.signal)
      setPreview({ status: 'ready', key: runKey, preview: result.preview })
    } catch (error) {
      if (controller.signal.aborted) return
      setPreview({ status: 'error', key: runKey, message: error instanceof Error ? error.message : 'Could not work out what that rule would do' })
    }
  }

  const action = draft.action

  return (
    <section className="gsr-editor" aria-label={ruleId ? 'Change this rule' : 'New rule'}>
      <h3 className="gsr-editor-title">{ruleId ? 'Change this rule' : 'New rule'}</h3>

      <label className="gsr-field-block">
        <span className="gsr-label">Name</span>
        <input
          className="gsr-input"
          type="text"
          maxLength={120}
          value={draft.name}
          placeholder="e.g. Made-to-order items from one supplier"
          disabled={saving}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </label>

      <div className="gsr-field-block">
        <span className="gsr-label">When an item matches</span>
        <ConditionGroupEditor group={draft.conditions} ctx={builder} onChange={(conditions) => setDraft({ ...draft, conditions })} />
      </div>

      <div className="gsr-field-block">
        <label className="gsr-label" htmlFor="gsr-action">Then</label>
        <div className="gsr-action">
          <select
            id="gsr-action"
            className="gsw-select"
            value={action.type}
            disabled={saving}
            onChange={(e) => {
              const type = (Object.keys(ACTION_LABELS) as RuleActionType[]).find((t) => t === e.target.value) ?? 'exclude'
              setDraft({ ...draft, action: actionFor(type, action) })
            }}
          >
            {(Object.keys(ACTION_LABELS) as RuleActionType[]).map((type) => <option key={type} value={type}>{ACTION_LABELS[type]}</option>)}
          </select>

          {action.type === 'custom_label' && (
            <>
              <select
                className="gsw-select"
                aria-label="Which custom label"
                value={action.slot}
                disabled={saving}
                onChange={(e) => {
                  const slot = CUSTOM_LABEL_SLOTS.find((s) => String(s) === e.target.value) ?? 0
                  setDraft({ ...draft, action: { ...action, slot } })
                }}
              >
                {CUSTOM_LABEL_SLOTS.map((slot) => <option key={slot} value={slot}>Custom label {slot}</option>)}
              </select>
              <input
                className="gsr-input"
                type="text"
                aria-label="Label value"
                maxLength={CUSTOM_LABEL_MAX}
                placeholder="e.g. clearance"
                value={action.value}
                disabled={saving}
                onChange={(e) => setDraft({ ...draft, action: { ...action, value: e.target.value } })}
              />
            </>
          )}

          {action.type === 'title_template' && (
            <input
              className="gsr-input gsr-wide"
              type="text"
              aria-label="Title template"
              maxLength={500}
              placeholder="e.g. <brand> <parent_title> - <colour>"
              value={action.template}
              disabled={saving}
              onChange={(e) => setDraft({ ...draft, action: { ...action, template: e.target.value } })}
            />
          )}

          {action.type === 'identifiers' && (
            <>
              <select
                className="gsw-select"
                aria-label="Identifier change"
                value={action.mode}
                disabled={saving}
                onChange={(e) => {
                  const mode = IDENTIFIER_MODES.find((m) => m === e.target.value) ?? 'no_identifiers'
                  setDraft({ ...draft, action: mode === 'brand' ? { type: 'identifiers', mode, brand: action.brand ?? '' } : { type: 'identifiers', mode } })
                }}
              >
                {IDENTIFIER_MODES.map((mode) => <option key={mode} value={mode}>{IDENTIFIER_LABELS[mode]}</option>)}
              </select>
              {action.mode === 'brand' && (
                <input
                  className="gsr-input"
                  type="text"
                  aria-label="Brand to send"
                  maxLength={70}
                  value={action.brand ?? ''}
                  disabled={saving}
                  onChange={(e) => setDraft({ ...draft, action: { ...action, brand: e.target.value } })}
                />
              )}
            </>
          )}
        </div>
        <p className="gsw-muted gsw-small gsr-hint">
          {action.type === 'exclude' && 'Any Exclude rule that matches keeps the item out, wherever it sits in the list.'}
          {action.type === 'custom_label' && 'Labels group items in Google Ads and Merchant Center reports. Where two rules fill the same label, the higher one in the list wins.'}
          {action.type === 'title_template' && 'Uses the same tokens as the Products tab. A title set on an item itself beats this, and the higher rule in the list wins over a lower one.'}
          {action.type === 'identifiers' && 'A brand, barcode or part number typed on the product itself beats this. The higher rule in the list wins over a lower one.'}
        </p>
      </div>

      <label className="gsr-switch">
        <input type="checkbox" checked={draft.enabled} disabled={saving} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
        <span>Switched on</span>
      </label>

      {blocker && <p className="gsw-message is-info" role="status">{blocker}</p>}

      <PreviewPanel state={preview} current={current} ruleEnabled={draft.enabled} />

      <div className="gsr-editor-actions">
        <button type="button" className="btn btn-secondary" disabled={saving || blocker !== null || preview.status === 'loading'} onClick={() => void runPreview()}>
          {preview.status === 'loading' ? <><span className="gsw-spinner" aria-hidden /> Working it out…</> : current && preview.status === 'ready' ? 'Preview again' : 'Preview'}
        </button>
        <span className="gsw-spacer" />
        <button type="button" className="btn btn-ghost" disabled={saving} onClick={onCancel}>Cancel</button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canSave}
          title={canSave ? undefined : 'Preview the rule first, so you can see what it changes'}
          onClick={() => tidy && onSave(tidy)}
        >
          {saving ? <><span className="gsw-spinner" aria-hidden /> Saving…</> : ruleId ? 'Save the rule' : 'Add the rule'}
        </button>
      </div>
    </section>
  )
}
