import { describe, it, expect } from 'vitest'
import type { FeedItem } from '@/modules/google-shopping-for-shop/lib/feed-xml'
import { sweepTargets } from '@/modules/google-shopping-for-shop/lib/push/run'
import type { PushStateRow } from '@/modules/google-shopping-for-shop/lib/push/store'
import type { PushSnapshot } from '@/modules/google-shopping-for-shop/lib/push/types'

// The value-drift backstop.
//
// The hourly sweep is the only thing that catches a price or availability change
// no shop signal saw - the stock-import module writes counts in one bulk UPDATE
// and announces nothing, a feed rule can change what an item is worth, a
// category can move. An earlier version compared MEMBERSHIP only: it removed
// items that had left the feed and never re-sent one that had merely changed,
// so those changes reached Google not late but never.

const item = (over: Partial<FeedItem> = {}): FeedItem => ({
  id: 'p1',
  title: 'Aeron Chair',
  description: 'A chair',
  link: 'https://example.test/chair',
  imageLinks: ['https://example.test/chair.jpg'],
  availability: 'in_stock',
  price: 900,
  currency: 'GBP',
  identifierExists: true,
  condition: 'new',
  ...over,
} as FeedItem)

/** A state row for an item we sent cleanly, at `snapshot`. */
function sent(itemId: string, snapshot: PushSnapshot, over: Partial<PushStateRow> = {}): PushStateRow {
  return {
    itemId,
    parentId: itemId,
    snapshot,
    sentAt: new Date('2026-09-23T09:00:00Z'),
    confirmed: true,
    lastError: null,
    failedAt: null,
    reconciledAt: null,
    reconcileResult: null,
    reconcileDetail: null,
    ...over,
  }
}

const IN_STOCK_900: PushSnapshot = { price: 900, currency: 'GBP', availability: 'IN_STOCK' }

describe('sweepTargets', () => {
  it('sends an item whose price has moved since we last sent it', () => {
    const items = [item({ id: 'p1', price: 850 })]
    const state = new Map([['p1', sent('p1', IN_STOCK_900)]])
    expect(sweepTargets(items, state, new Set()).map((i) => i.id)).toEqual(['p1'])
  })

  it('sends an item whose availability has moved', () => {
    const items = [item({ id: 'p1', availability: 'out_of_stock' })]
    const state = new Map([['p1', sent('p1', IN_STOCK_900)]])
    expect(sweepTargets(items, state, new Set()).map((i) => i.id)).toEqual(['p1'])
  })

  it('sends an item that has never been sent, so switching this on works its way through the catalogue', () => {
    expect(sweepTargets([item({ id: 'new' })], new Map(), new Set()).map((i) => i.id)).toEqual(['new'])
  })

  it('leaves an item alone when it still says exactly what we sent', () => {
    const state = new Map([['p1', sent('p1', IN_STOCK_900)]])
    expect(sweepTargets([item({ id: 'p1', price: 900 })], state, new Set())).toEqual([])
  })

  it('re-sends an item whose last attempt was refused, even though the figures match', () => {
    const state = new Map([['p1', sent('p1', IN_STOCK_900, { failedAt: new Date(), confirmed: false, lastError: 'no' })]])
    expect(sweepTargets([item({ id: 'p1' })], state, new Set()).map((i) => i.id)).toEqual(['p1'])
  })

  it('re-sends an item Google never acknowledged', () => {
    const state = new Map([['p1', sent('p1', IN_STOCK_900, { confirmed: false })]])
    expect(sweepTargets([item({ id: 'p1' })], state, new Set()).map((i) => i.id)).toEqual(['p1'])
  })

  it('skips anything the run has already dealt with', () => {
    const state = new Map([['p1', sent('p1', IN_STOCK_900)]])
    expect(sweepTargets([item({ id: 'p1', price: 1 })], state, new Set(['p1']))).toEqual([])
  })

  it('puts drift ahead of never-sent, because a wrong price is worse than a missing one', () => {
    const items = [item({ id: 'never' }), item({ id: 'drifted', price: 1 })]
    const state = new Map([['drifted', sent('drifted', IN_STOCK_900)]])
    expect(sweepTargets(items, state, new Set()).map((i) => i.id)).toEqual(['drifted', 'never'])
  })
})
