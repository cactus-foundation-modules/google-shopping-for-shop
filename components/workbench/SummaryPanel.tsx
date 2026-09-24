'use client'

// The catalogue at a glance - match rate, own titles, problems, price position -
// where every figure is also the filter that lists those items.
import {
  GOOGLE_FILTER_LABELS,
  ISSUE_CODES,
  ISSUE_LABELS,
  type GoogleFilter,
  type IssueFilter,
  type MatchFilter,
  type OverrideFilter,
  type PriceFilter,
  type WorkbenchQuery,
} from '@/modules/google-shopping-for-shop/lib/workbench-query'
import { issueCodeLabel } from '@/modules/google-shopping-for-shop/lib/health/types'
import type { PricePosition, WorkbenchSummary } from '@/modules/google-shopping-for-shop/lib/workbench-view'
import { formatCount } from '@/modules/google-shopping-for-shop/components/workbench/format'

type Props = {
  summary: WorkbenchSummary | null
  query: WorkbenchQuery
  onChange: (patch: Partial<WorkbenchQuery>) => void
}

type Tile = {
  label: string
  value: number
  note?: string
  tone?: 'good' | 'bad' | 'warn'
  active: boolean
  patch: Partial<WorkbenchQuery>
}

const PRICE_LABELS: Record<PricePosition, string> = {
  dearer: 'Dearer than typical',
  cheaper: 'Cheaper than typical',
  level: 'Level',
  'no-benchmark': 'No comparison',
}

function percent(part: number, whole: number): string {
  if (whole === 0) return '0%'
  const value = (part / whole) * 100
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`
}

function tilesOf(summary: WorkbenchSummary, query: WorkbenchQuery): Tile[] {
  const onlyMatch = (match: MatchFilter): Partial<WorkbenchQuery> => ({ match: query.match === match ? 'all' : match })
  const onlyOverride = (override: OverrideFilter): Partial<WorkbenchQuery> => ({ override: query.override === override ? 'all' : override })
  const onlyIssue = (issue: IssueFilter): Partial<WorkbenchQuery> => ({ issue: query.issue === issue ? 'all' : issue })
  return [
    {
      label: 'Feed items',
      value: summary.total,
      note: 'Everything Google is sent',
      active: query.match === 'all' && query.override === 'all' && query.issue === 'all' && query.price === 'all',
      patch: { match: 'all', override: 'all', issue: 'all', price: 'all' },
    },
    { label: 'Matched', value: summary.matched, note: `${percent(summary.matched, summary.total)} of the feed`, tone: 'good', active: query.match === 'matched', patch: onlyMatch('matched') },
    { label: 'Not matched', value: summary.unmatched, note: `${percent(summary.unmatched, summary.total)} of the feed`, active: query.match === 'unmatched', patch: onlyMatch('unmatched') },
    { label: 'Not reported yet', value: summary.unknown, note: 'No word from Google', active: query.match === 'unknown', patch: onlyMatch('unknown') },
    { label: 'Own Google titles', value: summary.overridden, note: 'Items with a template', active: query.override === 'overridden', patch: onlyOverride('overridden') },
    { label: 'Need attention', value: summary.anyIssue, note: 'Any problem below', tone: summary.anyIssue > 0 ? 'warn' : undefined, active: query.issue === 'any', patch: onlyIssue('any') },
    {
      label: 'Turned down by Google',
      value: summary.google.disapproved,
      note: 'Not being shown at all',
      tone: summary.google.disapproved > 0 ? 'bad' : undefined,
      active: query.google === 'disapproved',
      patch: { google: query.google === 'disapproved' ? 'all' : 'disapproved' },
    },
  ]
}

function SkeletonTiles() {
  return (
    <div className="gsw-tiles" aria-hidden>
      {Array.from({ length: 7 }, (_unused, index) => (
        <div key={index} className="gsw-tile">
          <span className="skeleton gsw-skeleton-value" style={{ width: '6rem', height: '0.75rem' }} />
          <span className="skeleton gsw-skeleton-value" />
        </div>
      ))}
    </div>
  )
}

export function SummaryPanel({ summary, query, onChange }: Props) {
  if (!summary) return <SkeletonTiles />

  const priceOrder: Array<Exclude<PriceFilter, 'all'>> = ['dearer', 'cheaper', 'level', 'no-benchmark']
  return (
    <div className="gsw-filters">
      <div className="gsw-tiles">
        {tilesOf(summary, query).map((tile) => (
          <button key={tile.label} type="button" className={`gsw-tile${tile.active ? ' is-active' : ''}`} aria-pressed={tile.active} onClick={() => onChange(tile.patch)}>
            <span className="gsw-tile-label">{tile.label}</span>
            <span className={`gsw-tile-value${tile.tone ? ` is-${tile.tone}` : ''}`}>{formatCount(tile.value)}</span>
            {tile.note && <span className="gsw-tile-note">{tile.note}</span>}
          </button>
        ))}
      </div>

      <div className="gsw-chips" role="group" aria-label="Filter by problem">
        <span className="gsw-chips-label">Problems</span>
        {ISSUE_CODES.map((code) => {
          const active = query.issue === code
          const count = summary.issues[code]
          return (
            <button key={code} type="button" className={`gsw-chip${active ? ' is-active' : ''}`} aria-pressed={active} disabled={count === 0 && !active} onClick={() => onChange({ issue: active ? 'all' : code })}>
              {ISSUE_LABELS[code]} <span className="gsw-chip-count">{formatCount(count)}</span>
            </button>
          )
        })}
      </div>

      {(summary.google.any > 0 || summary.google.none > 0) && (
        <div className="gsw-chips" role="group" aria-label="Filter by what Google says">
          <span className="gsw-chips-label">Google says</span>
          {(['any', 'none', 'disapproved', 'demoted', 'pending'] as const).map((value: Exclude<GoogleFilter, 'all'>) => {
            const active = query.google === value
            const count = value === 'any' ? summary.google.any : summary.google[value]
            return (
              <button key={value} type="button" className={`gsw-chip${active ? ' is-active' : ''}`} aria-pressed={active} disabled={count === 0 && !active} onClick={() => onChange({ google: active ? 'all' : value })}>
                {GOOGLE_FILTER_LABELS[value]} <span className="gsw-chip-count">{formatCount(count)}</span>
              </button>
            )
          })}
        </div>
      )}

      {summary.googleCodes.length > 0 && (
        <div className="gsw-chips" role="group" aria-label="Filter by Google's reason">
          <span className="gsw-chips-label">Google&apos;s reasons</span>
          {/* The worst handful. The full list is the select in the filter bar,
              and the Health tab has every one of them with its own counts. */}
          {summary.googleCodes.slice(0, 8).map((code) => {
            const active = query.googleCode === code.value
            return (
              <button key={code.value} type="button" className={`gsw-chip${active ? ' is-active' : ''}`} aria-pressed={active} onClick={() => onChange({ googleCode: active ? '' : code.value })}>
                {issueCodeLabel(code.value)} <span className="gsw-chip-count">{formatCount(code.count)}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className="gsw-chips" role="group" aria-label="Filter by price against the typical price">
        <span className="gsw-chips-label">Price against typical</span>
        {priceOrder.map((position) => {
          const active = query.price === position
          const count = summary.prices[position]
          return (
            <button key={position} type="button" className={`gsw-chip${active ? ' is-active' : ''}`} aria-pressed={active} disabled={count === 0 && !active} onClick={() => onChange({ price: active ? 'all' : position })}>
              {PRICE_LABELS[position]} <span className="gsw-chip-count">{formatCount(count)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
