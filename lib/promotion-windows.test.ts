import { describe, it, expect } from 'vitest'
import {
  PROMOTION_RENEW_BEFORE_DAYS,
  PROMOTION_WINDOW_DAYS,
  type PromotionWindow,
  freshWindow,
  needsRenewal,
  promotionIdForRevision,
  resolveWindows,
  windowEnd,
} from '@/modules/google-shopping-for-shop/lib/promotion-windows'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-09-22T12:00:00.000Z')
const days = (n: number) => new Date(NOW.getTime() + n * DAY_MS)

const stored = (over: Partial<PromotionWindow> = {}): PromotionWindow => ({
  baseKey: 'osd-dynamic-office-solutions-nm2i-4000',
  revision: 0,
  startsAt: NOW,
  endsAt: windowEnd(NOW),
  ...over,
})

describe('promotionIdForRevision', () => {
  it('leaves revision 0 exactly as derived', () => {
    // A shop that never hits a burned id or a renewal must see the id it always
    // saw, or every existing promotion would be replaced by the upgrade itself.
    expect(promotionIdForRevision('osd-alliance-seating-9bpj-3000', 0)).toBe('osd-alliance-seating-9bpj-3000')
  })

  it('suffixes later revisions', () => {
    expect(promotionIdForRevision('osd-alliance-seating-9bpj-3000', 1)).toBe('osd-alliance-seating-9bpj-3000-r1')
    expect(promotionIdForRevision('osd-alliance-seating-9bpj-3000', 12)).toBe('osd-alliance-seating-9bpj-3000-r12')
  })

  it('never produces the same id for two revisions', () => {
    const seen = new Set(Array.from({ length: 20 }, (_, r) => promotionIdForRevision('x', r)))
    expect(seen.size).toBe(20)
  })
})

describe('windowEnd', () => {
  it('stays inside Google 183-day cap', () => {
    expect(PROMOTION_WINDOW_DAYS).toBeLessThan(183)
    const end = windowEnd(NOW)
    expect((end.getTime() - NOW.getTime()) / DAY_MS).toBe(PROMOTION_WINDOW_DAYS)
  })
})

describe('needsRenewal', () => {
  it('leaves a fresh window alone', () => {
    expect(needsRenewal(stored(), NOW)).toBe(false)
  })

  it('renews once inside the notice period', () => {
    const nearlyUp = stored({ startsAt: days(-PROMOTION_WINDOW_DAYS + PROMOTION_RENEW_BEFORE_DAYS - 1) })
    expect(needsRenewal({ startsAt: nearlyUp.startsAt, endsAt: windowEnd(nearlyUp.startsAt) }, NOW)).toBe(true)
  })

  it('renews one already past its end', () => {
    const expired = days(-PROMOTION_WINDOW_DAYS - 30)
    expect(needsRenewal({ startsAt: expired, endsAt: windowEnd(expired) }, NOW)).toBe(true)
  })

  it('renews a window that starts absurdly far in the future', () => {
    // Only a clock that went backwards or a row written by something else can
    // produce this, and a date nobody can explain is worse than a fresh one.
    const future = days(PROMOTION_WINDOW_DAYS + 10)
    expect(needsRenewal({ startsAt: future, endsAt: windowEnd(future) }, NOW)).toBe(true)
  })
})

describe('resolveWindows', () => {
  it('opens a window for an offer it has never seen', () => {
    const { windows, toWrite } = resolveWindows(['a'], [], NOW)
    expect(windows.get('a')).toEqual(freshWindow('a', 0, NOW))
    expect(toWrite).toEqual([freshWindow('a', 0, NOW)])
  })

  it('hands back the stored dates unchanged, and writes nothing', () => {
    // The whole point: Google refuses a changed start time, so an unchanged
    // offer must send the same date it sent last time.
    const existing = stored({ baseKey: 'a', startsAt: days(-30), endsAt: windowEnd(days(-30)) })
    const { windows, toWrite } = resolveWindows(['a'], [existing], NOW)
    expect(windows.get('a')).toEqual(existing)
    expect(toWrite).toEqual([])
  })

  it('bumps the revision when the window is nearly up', () => {
    const startsAt = days(-PROMOTION_WINDOW_DAYS + 3)
    const existing = stored({ baseKey: 'a', revision: 2, startsAt, endsAt: windowEnd(startsAt) })
    const { windows, toWrite } = resolveWindows(['a'], [existing], NOW)
    expect(windows.get('a')).toEqual(freshWindow('a', 3, NOW))
    expect(toWrite).toEqual([freshWindow('a', 3, NOW)])
  })

  it('ignores stored rows for offers this run does not have', () => {
    const { windows } = resolveWindows(['a'], [stored({ baseKey: 'b' })], NOW)
    expect([...windows.keys()]).toEqual(['a'])
  })

  it('gives every requested key a window', () => {
    const keys = ['a', 'b', 'c']
    const { windows } = resolveWindows(keys, [stored({ baseKey: 'b' })], NOW)
    // feed-data stamps items from this map; a missing key would leave a product
    // advertising a promotion that the promotions document never describes.
    expect(keys.every((k) => windows.has(k))).toBe(true)
  })
})
