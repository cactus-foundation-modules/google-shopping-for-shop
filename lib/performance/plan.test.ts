import { describe, it, expect } from 'vitest'
import { cursorAfter, planImport, REVISION_DAYS, WINDOW_DAYS } from '@/modules/google-shopping-for-shop/lib/performance/plan'
import { addDays } from '@/modules/google-shopping-for-shop/lib/performance/days'

const TODAY = '2026-09-23'

describe('planImport', () => {
  it('reaches back the whole backfill window on a first run', () => {
    const plan = planImport({ today: TODAY, importedThrough: null, backfillDays: 90 })
    expect(plan.span).toEqual({ from: '2026-06-26', to: TODAY })
    expect(plan.backfilling).toBe(true)
    // Windows are contiguous, oldest first, and cover the whole span.
    expect(plan.windows[0]?.from).toBe('2026-06-26')
    expect(plan.windows[plan.windows.length - 1]?.to).toBe(TODAY)
    // No gap and no overlap: each window starts the day after the last one
    // ended. A gap here is a fortnight of figures nobody would ever fetch.
    for (let i = 1; i < plan.windows.length; i++) {
      expect(plan.windows[i]?.from).toBe(addDays(plan.windows[i - 1]?.to ?? '', 1))
    }
  })

  it('cuts the span into windows of WINDOW_DAYS', () => {
    const plan = planImport({ today: TODAY, importedThrough: null, backfillDays: WINDOW_DAYS * 3 })
    expect(plan.windows).toHaveLength(3)
    expect(plan.windows[0]).toEqual({ from: '2026-09-03', to: '2026-09-09' })
  })

  it('re-reads the newest days for ever, however far the cursor has got', () => {
    // Cursor right up to date. Google is still revising the last few days, so
    // they are asked for again rather than trusted.
    const plan = planImport({ today: TODAY, importedThrough: '2026-09-22', backfillDays: 90 })
    expect(plan.span).toEqual({ from: '2026-09-21', to: TODAY })
    expect(plan.backfilling).toBe(false)
    expect(plan.windows).toHaveLength(1)
  })

  it('carries on from the cursor when there is history still to fetch', () => {
    const plan = planImport({ today: TODAY, importedThrough: '2026-07-10', backfillDays: 90 })
    expect(plan.span?.from).toBe('2026-07-11')
    expect(plan.backfilling).toBe(true)
  })

  it('does not go back through months a narrowed backfill window no longer wants', () => {
    // The cursor says January, but the owner has since asked for 30 days.
    const plan = planImport({ today: TODAY, importedThrough: '2026-01-01', backfillDays: 30 })
    expect(plan.span?.from).toBe('2026-08-25')
  })

  it('never plans a span that ends before it starts', () => {
    const plan = planImport({ today: TODAY, importedThrough: TODAY, backfillDays: 90 })
    // The revision tail still gets re-read, so there is always something.
    expect(plan.windows.length).toBeGreaterThan(0)
    expect(plan.span?.from).toBe('2026-09-21')
  })

  it('treats a nonsense backfill window as one day rather than as nothing', () => {
    const plan = planImport({ today: TODAY, importedThrough: null, backfillDays: 0 })
    expect(plan.span).toEqual({ from: TODAY, to: TODAY })
  })
})

describe('cursorAfter', () => {
  it('stays where it was when no window completed', () => {
    expect(cursorAfter({ today: TODAY, completed: [], previous: '2026-07-10' })).toBe('2026-07-10')
    expect(cursorAfter({ today: TODAY, completed: [], previous: null })).toBeNull()
  })

  it('never names a day Google is still revising', () => {
    const settled = '2026-09-20'
    expect(cursorAfter({ today: TODAY, completed: [{ from: '2026-09-17', to: TODAY }], previous: null })).toBe(settled)
    expect(REVISION_DAYS).toBe(3)
  })

  it('moves to the end of the last whole window on a run that was cut short', () => {
    expect(cursorAfter({
      today: TODAY,
      completed: [{ from: '2026-06-26', to: '2026-07-02' }, { from: '2026-07-03', to: '2026-07-09' }],
      previous: null,
    })).toBe('2026-07-09')
  })

  it('never goes backwards', () => {
    // A run that only re-read the revision tail has learned nothing new about
    // settled history, so a cursor already past it stays put.
    expect(cursorAfter({
      today: TODAY,
      completed: [{ from: '2026-09-21', to: TODAY }],
      previous: '2026-09-22',
    })).toBe('2026-09-22')
  })
})
