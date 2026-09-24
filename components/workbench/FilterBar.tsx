'use client'

// Search and the finer filters. The search box says when it is waiting for
// you to finish typing and when it is fetching, so a pause never looks frozen.
import type { RefObject } from 'react'
import {
  DEFAULT_WORKBENCH_QUERY,
  ISSUE_CODES,
  ISSUE_FILTERS,
  ISSUE_LABELS,
  FEED_FILTERS,
  GOOGLE_FILTERS,
  GOOGLE_FILTER_LABELS,
  MATCH_FILTERS,
  OVERRIDE_FILTERS,
  PAGE_SIZES,
  PRICE_FILTERS,
  SORT_LABELS,
  SORT_ORDERS,
  isFilteredQuery,
  type FeedFilter,
  type GoogleFilter,
  type MatchFilter,
  type OverrideFilter,
  type PriceFilter,
  type WorkbenchQuery,
} from '@/modules/google-shopping-for-shop/lib/workbench-query'
import { issueCodeLabel } from '@/modules/google-shopping-for-shop/lib/health/types'
import type { FacetCount, WorkbenchSummary } from '@/modules/google-shopping-for-shop/lib/workbench-view'
import { formatCount } from '@/modules/google-shopping-for-shop/components/workbench/format'

type Props = {
  query: WorkbenchQuery
  summary: WorkbenchSummary | null
  searchInput: string
  onSearchInput: (value: string) => void
  onSearchSubmit: () => void
  /** Typed text waiting out the debounce, or a request in flight. */
  searching: boolean
  searchRef: RefObject<HTMLInputElement | null>
  onChange: (patch: Partial<WorkbenchQuery>) => void
  onReset: () => void
  /** The listing's name when the list is narrowed to one listing. */
  listingTitle: string | null
}

const MATCH_OPTIONS: Array<[MatchFilter, string]> = [
  ['all', 'Any match state'],
  ['matched', 'Matched'],
  ['unmatched', 'Not matched'],
  ['unknown', 'Not reported yet'],
]

const OVERRIDE_OPTIONS: Array<[OverrideFilter, string]> = [
  ['all', 'Any title'],
  ['overridden', 'Own Google title'],
  ['plain', 'Site title'],
]

const FEED_OPTIONS: Array<[FeedFilter, string]> = [
  ['in', 'Going to Google'],
  ['out', 'Kept out of the feed'],
  ['all', 'In or out of the feed'],
]

const PRICE_OPTIONS: Array<[PriceFilter, string]> = [
  ['all', 'Any price'],
  ['dearer', 'Dearer than typical'],
  ['cheaper', 'Cheaper than typical'],
  ['level', 'Level with typical'],
  ['no-benchmark', 'No typical price'],
]

/** The option a select landed on, checked against the list it came from. */
function pick<T extends string | number>(options: readonly T[], value: string | number, fallback: T): T {
  return options.find((option) => String(option) === String(value)) ?? fallback
}

// A value from a shared link that the current catalogue no longer has still
// shows in the select, rather than the select quietly reading "All".
function withCurrent(options: FacetCount[], current: string): FacetCount[] {
  if (current === '' || options.some((option) => option.value === current)) return options
  return [{ value: current, count: 0 }, ...options]
}

export function FilterBar({ query, summary, searchInput, onSearchInput, onSearchSubmit, searching, searchRef, onChange, onReset, listingTitle }: Props) {
  const total = summary?.total ?? 0
  const brands = withCurrent(summary?.brands ?? [], query.brand)
  const categories = withCurrent(summary?.categories ?? [], query.category)
  const rules = summary?.rules ?? []
  const ruleKnown = query.rule === '' || rules.some((rule) => rule.id === query.rule)
  const googleCodes = summary?.googleCodes ?? []
  const googleCodeKnown = query.googleCode === '' || googleCodes.some((code) => code.value === query.googleCode)

  return (
    <div className="gsw-filters">
      <div className="gsw-filter-row">
        <form
          className="gsw-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault()
            onSearchSubmit()
          }}
        >
          <label htmlFor="gsw-search-input" className="gsw-sr">Search Google Shopping items</label>
          <input
            id="gsw-search-input"
            ref={searchRef}
            type="search"
            value={searchInput}
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
            placeholder={total > 0 ? `Search ${formatCount(total)} items by title, SKU, MPN, GTIN, brand or category` : 'Search by title, SKU, MPN, GTIN, brand or category'}
            onChange={(event) => onSearchInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && searchInput !== '') {
                event.preventDefault()
                onSearchInput('')
              }
            }}
          />
          <span className="gsw-search-side">
            {searching && <span className="gsw-spinner" role="status" aria-label="Searching" />}
            {searchInput !== ''
              ? <button type="button" className="gsw-search-clear" aria-label="Clear search" onClick={() => onSearchInput('')}>×</button>
              : <kbd className="gsw-kbd" title="Press / to search">/</kbd>}
          </span>
        </form>
        <select className={`gsw-select${query.match !== 'all' ? ' is-set' : ''}`} aria-label="Match state" value={query.match} onChange={(event) => onChange({ match: pick(MATCH_FILTERS, event.target.value, 'all') })}>
          {MATCH_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select className={`gsw-select${query.override !== 'all' ? ' is-set' : ''}`} aria-label="Title" value={query.override} onChange={(event) => onChange({ override: pick(OVERRIDE_FILTERS, event.target.value, 'all') })}>
          {OVERRIDE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select className={`gsw-select${query.issue !== 'all' ? ' is-set' : ''}`} aria-label="Problem" value={query.issue} onChange={(event) => onChange({ issue: pick(ISSUE_FILTERS, event.target.value, 'all') })}>
          <option value="all">Any or no problem</option>
          <option value="any">Any problem</option>
          {ISSUE_CODES.map((code) => <option key={code} value={code}>{ISSUE_LABELS[code]}</option>)}
        </select>
        <select
          className={`gsw-select${query.google !== 'all' ? ' is-set' : ''}`}
          aria-label="What Google says"
          value={query.google}
          onChange={(event) => onChange({ google: pick(GOOGLE_FILTERS, event.target.value, 'all') as GoogleFilter })}
        >
          {GOOGLE_FILTERS.map((value) => <option key={value} value={value}>{GOOGLE_FILTER_LABELS[value]}</option>)}
        </select>
        <select className={`gsw-select${query.price !== 'all' ? ' is-set' : ''}`} aria-label="Price against typical" value={query.price} onChange={(event) => onChange({ price: pick(PRICE_FILTERS, event.target.value, 'all') })}>
          {PRICE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>

      <div className="gsw-filter-row">
        <select className={`gsw-select${query.brand !== '' ? ' is-set' : ''}`} aria-label="Brand" value={query.brand} onChange={(event) => onChange({ brand: event.target.value })}>
          <option value="">Every brand</option>
          {brands.map((brand) => <option key={brand.value} value={brand.value}>{brand.value} ({formatCount(brand.count)})</option>)}
        </select>
        <select className={`gsw-select${query.category !== '' ? ' is-set' : ''}`} aria-label="Category" value={query.category} onChange={(event) => onChange({ category: event.target.value })}>
          <option value="">Every category</option>
          {categories.map((category) => <option key={category.value} value={category.value}>{category.value} ({formatCount(category.count)})</option>)}
        </select>
        <select className={`gsw-select${query.feed !== 'in' ? ' is-set' : ''}`} aria-label="In the feed or not" value={query.feed} onChange={(event) => onChange({ feed: pick(FEED_FILTERS, event.target.value, 'in') })}>
          {FEED_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        {(rules.length > 0 || query.rule !== '') && (
          <select
            className={`gsw-select${query.rule !== '' ? ' is-set' : ''}`}
            aria-label="Feed rule"
            value={query.rule}
            // Picking a rule looks in and out of the feed at once: an Exclude
            // rule's items are all out, and would otherwise show as nothing.
            onChange={(event) => onChange(event.target.value === '' ? { rule: '' } : { rule: event.target.value, feed: 'all' })}
          >
            <option value="">Any or no feed rule</option>
            {!ruleKnown && <option value={query.rule}>A rule that matches nothing now</option>}
            {rules.map((rule) => <option key={rule.id} value={rule.id}>Rule: {rule.name} ({formatCount(rule.count)})</option>)}
          </select>
        )}
        {(googleCodes.length > 0 || query.googleCode !== '') && (
          <select
            className={`gsw-select${query.googleCode !== '' ? ' is-set' : ''}`}
            aria-label="Google's reason"
            value={query.googleCode}
            onChange={(event) => onChange({ googleCode: event.target.value })}
          >
            <option value="">Any reason from Google</option>
            {!googleCodeKnown && <option value={query.googleCode}>{issueCodeLabel(query.googleCode)} (none now)</option>}
            {googleCodes.map((code) => (
              <option key={code.value} value={code.value}>{issueCodeLabel(code.value)} ({formatCount(code.count)})</option>
            ))}
          </select>
        )}
        <select className="gsw-select" aria-label="Sort order" value={query.sort} onChange={(event) => onChange({ sort: pick(SORT_ORDERS, event.target.value, DEFAULT_WORKBENCH_QUERY.sort) })}>
          {SORT_ORDERS.map((order) => <option key={order} value={order}>{SORT_LABELS[order]}</option>)}
        </select>
        <select className="gsw-select" aria-label="Items per page" value={query.perPage} onChange={(event) => onChange({ perPage: pick(PAGE_SIZES, event.target.value, DEFAULT_WORKBENCH_QUERY.perPage) })}>
          {PAGE_SIZES.map((size) => <option key={size} value={size}>{size} a page</option>)}
        </select>
        {isFilteredQuery(query) && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onReset}>Clear filters</button>
        )}
      </div>

      {query.group !== '' && (
        <div className="gsw-chips">
          <button type="button" className="gsw-chip is-active" onClick={() => onChange({ group: '' })}>
            Only this listing: {listingTitle ?? 'one listing'} <span className="gsw-chip-x" aria-hidden>×</span>
            <span className="gsw-sr"> - show every listing</span>
          </button>
        </div>
      )}
    </div>
  )
}
