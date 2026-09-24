'use client'

// The workbench's Feed Rules sub-tab: standing instructions about what goes to
// Google, instead of ticking products one at a time.
//
// The list is the order rules are tried in. Drag a rule by its handle, or use
// the arrows beside it, to move it. Switching a rule on or off saves at once;
// adding or changing one goes through the editor, which will not save until it
// has shown what the change would do. Every change lands in the change log at
// the bottom, with an Undo.
//
// Two fetches, on purpose: the rules themselves come back at once, while the
// counts beside them need the catalogue read, which on a cold server takes a
// few seconds. The list never waits for the counts.
import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import { buildFieldCatalogue, type RuleField } from '@/modules/google-shopping-for-shop/lib/feed-rules/fields'
import { describeAction, describeGroup, type DescribeContext } from '@/modules/google-shopping-for-shop/lib/feed-rules/describe'
import type { FeedRule, RuleDraft } from '@/modules/google-shopping-for-shop/lib/feed-rules/types'
import { workbenchCss } from '@/modules/google-shopping-for-shop/components/workbench/workbench-css'
import { feedRulesCss } from '@/modules/google-shopping-for-shop/components/workbench/feed-rules/feed-rules-css'
import { formatCount, formatDateTime, plural } from '@/modules/google-shopping-for-shop/components/workbench/format'
import { ChangeHistory } from '@/modules/google-shopping-for-shop/components/workbench/feed-rules/ChangeHistory'
import { RuleEditor, newRuleDraft } from '@/modules/google-shopping-for-shop/components/workbench/feed-rules/RuleEditor'
import {
  createRule,
  deleteRule,
  fetchLog,
  fetchRules,
  fetchRuleStats,
  reorderRules,
  setRangeAttribute,
  undoLogEntry,
  updateRule,
  type LogEntry,
  type RulesResponse,
  type RuleStats,
} from '@/modules/google-shopping-for-shop/components/workbench/feed-rules/api'

type Props = {
  /** Opens the Products tab narrowed to the items this rule matches. */
  onShowProducts: (ruleId: string) => void
}

type Notice = { tone: 'ok' | 'error' | 'info'; text: string; undoId?: string | null }

type Editing = { id: string | null; draft: RuleDraft } | null

const LOG_AREAS = ['feed-rules', 'products']

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  const [item] = next.splice(from, 1)
  if (item !== undefined) next.splice(to, 0, item)
  return next
}

export function FeedRulesTab({ onShowProducts }: Props) {
  const [data, setData] = useState<RulesResponse | null>(null)
  const [loadError, setLoadError] = useState('')
  const [stats, setStats] = useState<RuleStats | null>(null)
  const [statsError, setStatsError] = useState('')
  const [log, setLog] = useState<LogEntry[] | null>(null)
  const [logError, setLogError] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [editing, setEditing] = useState<Editing>(null)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [undoingId, setUndoingId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  // A switched-off Exclude rule takes items out of the feed the moment it goes
  // on, with no preview in the way. Nobody should find that out afterwards, so
  // the switch asks first and says how many.
  const [confirmEnable, setConfirmEnable] = useState<{ id: string; count: number | null } | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  const loadRules = useCallback(async () => {
    try {
      const next = await fetchRules()
      setData(next)
      setLoadError('')
    } catch (error) {
      setLoadError(messageOf(error, 'Could not load the feed rules'))
    }
  }, [])

  const loadStats = useCallback(async () => {
    try {
      const next = await fetchRuleStats()
      setStats(next)
      setStatsError('')
    } catch (error) {
      setStatsError(messageOf(error, 'Could not read the catalogue'))
    }
  }, [])

  const loadLog = useCallback(async () => {
    try {
      const next = await fetchLog(LOG_AREAS)
      setLog(next)
      setLogError('')
    } catch (error) {
      setLogError(messageOf(error, 'Could not load recent changes'))
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- first fetch on mount; every setState in these runs after an await
    void loadRules()
    void loadStats()
    void loadLog()
  }, [loadRules, loadStats, loadLog])

  /** After any change: the list, the counts and the log all move together. */
  const refreshAll = useCallback(() => {
    void loadRules()
    void loadStats()
    void loadLog()
  }, [loadRules, loadStats, loadLog])

  const fields: RuleField[] = useMemo(
    () => buildFieldCatalogue(data?.attributes ?? [], stats?.optionNames ?? []),
    [data?.attributes, stats?.optionNames],
  )
  const fieldByKey = useMemo(() => new Map(fields.map((field) => [field.key, field])), [fields])
  const describeCtx: DescribeContext = useMemo(() => ({
    fields: fieldByKey,
    categories: new Map((data?.categories ?? []).map((category) => [category.id, category.path])),
  }), [fieldByKey, data?.categories])
  const suggestions = useMemo(() => ({ supplier: stats?.suggestions.supplier ?? [], brand: stats?.suggestions.brand ?? [] }), [stats])

  const rules = data?.rules ?? []

  // ----- Writes --------------------------------------------------------------
  async function saveDraft(draft: RuleDraft) {
    if (!editing) return
    setSaving(true)
    setNotice(null)
    try {
      const result = editing.id ? await updateRule(editing.id, draft) : await createRule(draft)
      setEditing(null)
      setNotice({
        tone: 'ok',
        text: editing.id ? `Saved "${result.rule.name}". Google picks it up the next time it fetches the feed.` : `Added "${result.rule.name}". Google picks it up the next time it fetches the feed.`,
        undoId: result.changeId,
      })
      refreshAll()
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not save the rule') })
    } finally {
      setSaving(false)
    }
  }

  function askToToggle(rule: FeedRule) {
    setConfirmDelete(null)
    if (!rule.enabled && rule.action.type === 'exclude') {
      const count = stats ? stats.wouldExclude[rule.id] ?? 0 : null
      if (count === null || count > 0) {
        setConfirmEnable({ id: rule.id, count })
        return
      }
    }
    void toggle(rule)
  }

  async function toggle(rule: FeedRule) {
    setConfirmEnable(null)
    setBusyId(rule.id)
    setNotice(null)
    try {
      const result = await updateRule(rule.id, { name: rule.name, enabled: !rule.enabled, conditions: rule.conditions, action: rule.action })
      setNotice({ tone: 'ok', text: `${result.rule.enabled ? 'Switched on' : 'Switched off'} "${rule.name}".`, undoId: result.changeId })
      refreshAll()
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not change that rule') })
    } finally {
      setBusyId(null)
    }
  }

  async function remove(rule: FeedRule) {
    setBusyId(rule.id)
    setConfirmDelete(null)
    setNotice(null)
    try {
      const result = await deleteRule(rule.id)
      setNotice({ tone: 'ok', text: `Deleted "${rule.name}".`, undoId: result.changeId })
      if (editing?.id === rule.id) setEditing(null)
      refreshAll()
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not delete that rule') })
    } finally {
      setBusyId(null)
    }
  }

  async function reorder(from: number, to: number) {
    if (!data || from === to || to < 0 || to >= rules.length) return
    const next = moved(rules, from, to)
    // Shown at once; put back if the save fails.
    setData({ ...data, rules: next })
    setNotice(null)
    try {
      const result = await reorderRules(next.map((rule) => rule.id))
      setNotice({ tone: 'ok', text: 'Order saved.', undoId: result.changeId })
      refreshAll()
    } catch (error) {
      setData({ ...data, rules })
      setNotice({ tone: 'error', text: messageOf(error, 'Could not reorder the rules') })
    }
  }

  async function chooseRange(attributeId: string) {
    setNotice(null)
    try {
      const result = await setRangeAttribute(attributeId || null)
      setNotice({ tone: 'ok', text: attributeId ? 'Range attribute saved.' : 'No range attribute now.', undoId: result.changeId })
      refreshAll()
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not save that') })
    }
  }

  async function undo(id: string) {
    setUndoingId(id)
    setNotice(null)
    try {
      const result = await undoLogEntry(id)
      // The area's own reason where it gave one: "changed again since" is only
      // one of the ways an undo can decline, and the others read quite
      // differently - a send that never finished, one already overtaken.
      setNotice(result.restored > 0
        ? { tone: 'ok', text: result.message ?? 'Put back as it was.', undoId: result.entryId }
        : { tone: 'info', text: result.message ?? 'That had been changed again since, so it was left as it is.' })
      if (editing) setEditing(null)
      refreshAll()
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error, 'Could not undo that change') })
    } finally {
      setUndoingId(null)
    }
  }

  // ----- Drag and drop ------------------------------------------------------
  function onDragStart(event: DragEvent, index: number) {
    setDragIndex(index)
    event.dataTransfer.effectAllowed = 'move'
    // Firefox will not start a drag without some data on it.
    event.dataTransfer.setData('text/plain', String(index))
  }

  function onDragOver(event: DragEvent, index: number) {
    if (dragIndex === null) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (dropIndex !== index) setDropIndex(index)
  }

  function onDrop(event: DragEvent, index: number) {
    event.preventDefault()
    const from = dragIndex
    setDragIndex(null)
    setDropIndex(null)
    if (from !== null) void reorder(from, index)
  }

  const editorCtx = { fields, fieldByKey, categories: data?.categories ?? [], suggestions }
  const busy = saving || busyId !== null

  return (
    <div className="gsw gsr">
      <style dangerouslySetInnerHTML={{ __html: workbenchCss + feedRulesCss }} />

      <header className="gsr-head">
        <div>
          <h2 className="gsw-title">Feed rules</h2>
          <p className="gsw-lede">
            Standing instructions about what goes to Google: keep items out, label them for bidding and reports, set their titles, or change what they say about barcodes and brands.
            A choice made by hand on a product or variation always beats a rule, and any Exclude rule that matches keeps the item out.
            For everything else, the higher rule in the list wins.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!data || editing !== null}
          onClick={() => setEditing({ id: null, draft: newRuleDraft({ fields }) })}
        >
          Add a rule
        </button>
      </header>

      <div className="gsr-counts" aria-live="polite">
        {stats ? (
          <>
            <span><strong>{formatCount(stats.inFeed)}</strong> going to Google</span>
            <span><strong>{formatCount(stats.outOfFeed.rule)}</strong> kept out by rules</span>
            <span><strong>{formatCount(stats.outOfFeed.hand)}</strong> kept out by hand</span>
            <span>Shop read {formatDateTime(stats.readAt)}</span>
          </>
        ) : statsError ? (
          <span role="alert">{statsError} <button type="button" className="gsw-linkish" onClick={() => void loadStats()}>Try again</button></span>
        ) : (
          <span><span className="gsw-spinner" aria-hidden /> Reading the catalogue for counts…</span>
        )}
      </div>

      {data && data.attributesAvailable && data.attributes.length > 0 && (
        <label className="gsr-range">
          <span>Your range is the attribute</span>
          <select className="gsw-select" value={data.rangeAttributeId ?? ''} disabled={busy} onChange={(e) => void chooseRange(e.target.value)}>
            <option value="">None - no Range field</option>
            {data.attributes.map((attribute) => <option key={attribute.id} value={attribute.id}>{attribute.name}</option>)}
          </select>
        </label>
      )}

      {notice && (
        <p className={`gsw-message is-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
          <span>{notice.text}</span>
          {notice.undoId && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={undoingId !== null} onClick={() => void undo(notice.undoId ?? '')}>Undo</button>
          )}
          <button type="button" className="gsw-search-clear" aria-label="Dismiss" onClick={() => setNotice(null)}>×</button>
        </p>
      )}

      {loadError && (
        <p className="gsw-message is-error" role="alert">
          <span>{loadError}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void loadRules()}>Try again</button>
        </p>
      )}

      {editing && (
        <RuleEditor
          key={editing.id ?? 'new'}
          ruleId={editing.id}
          initial={editing.draft}
          ctx={editorCtx}
          saving={saving}
          onSave={(draft) => void saveDraft(draft)}
          onCancel={() => setEditing(null)}
        />
      )}

      {!data && !loadError && <p className="gsw-muted gsw-small"><span className="gsw-spinner" aria-hidden /> Loading the rules…</p>}

      {data && rules.length === 0 && !editing && (
        <div className="gsw-card gsw-empty">
          <strong>No rules yet.</strong>
          Everything active, visible and photographed goes to Google. Add a rule to keep some of it back, or to label it.
        </div>
      )}

      {rules.length > 0 && (
        <ol className="gsr-list" aria-label="Feed rules, in the order they are tried">
          {rules.map((rule, index) => {
            const count = stats?.counts[rule.id]
            return (
              <li
                key={rule.id}
                className={`gsr-rule${rule.enabled ? '' : ' is-off'}${dragIndex === index ? ' is-dragging' : ''}${dropIndex === index && dragIndex !== index ? ' is-drop-target' : ''}`}
                onDragOver={(event) => onDragOver(event, index)}
                onDrop={(event) => onDrop(event, index)}
                onDragEnd={() => { setDragIndex(null); setDropIndex(null) }}
              >
                <div className="gsr-handle">
                  <span
                    className="gsr-grip"
                    draggable={!busy && editing === null}
                    onDragStart={(event) => onDragStart(event, index)}
                    title="Drag to move"
                    aria-hidden
                  >
                    ⋮⋮
                  </span>
                  <button type="button" className="gsr-move" aria-label={`Move "${rule.name}" up`} disabled={busy || index === 0} onClick={() => void reorder(index, index - 1)}>▲</button>
                  <button type="button" className="gsr-move" aria-label={`Move "${rule.name}" down`} disabled={busy || index === rules.length - 1} onClick={() => void reorder(index, index + 1)}>▼</button>
                </div>
                <div className="gsr-rule-body">
                  <span className="gsr-rule-name">{index + 1}. {rule.name}</span>
                  <span className="gsr-rule-when">When {describeGroup(rule.conditions, describeCtx) || 'nothing (this rule is damaged - change or delete it)'}</span>
                  <span className="gsr-rule-then">Then: {describeAction(rule.action)}</span>
                  <span className="gsr-rule-meta">
                    {!rule.enabled && <span className="badge badge-default">Switched off</span>}
                    {count !== undefined && <span>Matches {plural(count, 'item')}</span>}
                    {stats && count === undefined && <span>Matches nothing today</span>}
                    {(count ?? 0) > 0 && (
                      <button type="button" className="gsw-linkish" onClick={() => onShowProducts(rule.id)}>Show them</button>
                    )}
                    <span>Last changed {formatDateTime(rule.updatedAt)}</span>
                  </span>
                </div>
                <div className="gsr-rule-actions">
                  <label className="gsr-switch">
                    <input type="checkbox" checked={rule.enabled} disabled={busy} onChange={() => askToToggle(rule)} />
                    <span>{rule.enabled ? 'On' : 'Off'}</span>
                  </label>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy || editing !== null}
                    onClick={() => setEditing({ id: rule.id, draft: { name: rule.name, enabled: rule.enabled, conditions: rule.conditions, action: rule.action } })}
                  >
                    Change
                  </button>
                  {confirmEnable?.id === rule.id && (
                    <p className="gsw-message is-info gsr-confirm" role="status">
                      <span>
                        {confirmEnable.count === null
                          ? 'Switching this on takes every item it matches out of the feed. The count is still being worked out.'
                          : `Switching this on takes ${plural(confirmEnable.count, 'item')} out of the feed straight away.`}
                      </span>
                      <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => void toggle(rule)}>Switch it on</button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmEnable(null)}>Leave it off</button>
                    </p>
                  )}
                  {confirmDelete === rule.id ? (
                    <>
                      <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => void remove(rule)}>Delete it</button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(null)}>Keep it</button>
                    </>
                  ) : (
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setConfirmDelete(rule.id)}>Delete</button>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      )}

      <ChangeHistory
        entries={log}
        error={logError}
        undoingId={undoingId}
        onUndo={(entry) => void undo(entry.id)}
        onRetry={() => void loadLog()}
      />
    </div>
  )
}
