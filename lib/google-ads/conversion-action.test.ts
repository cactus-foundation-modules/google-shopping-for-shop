import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The client is the only thing between this file and Google, so it is the only
// thing stubbed. Everything else - which action gets reused, what order the
// verdicts come in, when a write happens at all - is the code under test.
const searchAds = vi.hoisted(() => vi.fn())
const adsRequest = vi.hoisted(() => vi.fn())
vi.mock('@/modules/google-shopping-for-shop/lib/google-ads/client', () => ({ searchAds, adsRequest }))

const {
  MANAGED_ACTION_NAME,
  ensureConversionAction,
  listUploadConversionActions,
  readConversionAction,
} = await import('@/modules/google-shopping-for-shop/lib/google-ads/conversion-action')

const CUSTOMER = '1234567890'
const OURS = `customers/${CUSTOMER}/conversionActions/555`
const THEIRS = `customers/${CUSTOMER}/conversionActions/999`

type ActionShape = {
  resourceName?: string
  name?: string
  type?: string
  status?: string
  category?: string
  primaryForGoal?: boolean
}

function row(action: ActionShape) {
  return {
    conversionAction: {
      type: 'UPLOAD_CLICKS',
      status: 'ENABLED',
      category: 'PURCHASE',
      name: MANAGED_ACTION_NAME,
      ...action,
    },
  }
}

/** Answers the two queries apart: the list, and one action by name. `byName`
 *  may be a queue, so a read AFTER an update can answer differently from the
 *  one before it - which is the whole point of reading back. */
function stubGoogle(options: { list: ReturnType<typeof row>[]; reads: Array<ReturnType<typeof row>[]> }) {
  let readAt = 0
  searchAds.mockImplementation(async (_customer: string, query: string) => {
    if (query.includes('FROM conversion_action') && query.includes("resource_name = '")) {
      const next = options.reads[Math.min(readAt, options.reads.length - 1)] ?? []
      readAt++
      return next
    }
    return options.list
  })
}

beforeEach(() => {
  searchAds.mockReset()
  adsRequest.mockReset()
  adsRequest.mockResolvedValue({ results: [{ resourceName: OURS }] })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('listUploadConversionActions', () => {
  it('asks for every "Import from clicks" tracker, switched on or off', async () => {
    searchAds.mockResolvedValue([row({ resourceName: OURS })])
    await listUploadConversionActions(CUSTOMER)
    const query = String(searchAds.mock.calls[0]?.[1])
    expect(query).toContain("conversion_action.type = 'UPLOAD_CLICKS'")
    // A paused tracker found here is what stops the setup creating a duplicate
    // and handing the owner Google's DUPLICATE_NAME refusal.
    expect(query).not.toContain("status = 'ENABLED'")
  })

  it('drops a row with nothing to hang an action on', async () => {
    searchAds.mockResolvedValue([{ conversionAction: { name: 'no resource name' } }, row({ resourceName: OURS })])
    expect(await listUploadConversionActions(CUSTOMER)).toHaveLength(1)
  })
})

describe('readConversionAction', () => {
  it('answers null when Google no longer has it', async () => {
    searchAds.mockResolvedValue([])
    expect(await readConversionAction(CUSTOMER, OURS)).toBeNull()
  })
})

describe('ensureConversionAction', () => {
  it('reuses the one already recorded, writing nothing', async () => {
    stubGoogle({ list: [row({ resourceName: OURS, primaryForGoal: false })], reads: [[row({ resourceName: OURS, primaryForGoal: false })]] })
    const outcome = await ensureConversionAction({ customerId: CUSTOMER, current: OURS })
    expect(outcome.status).toBe('ready')
    expect(outcome.status === 'ready' && outcome.created).toBe(false)
    expect(outcome.status === 'ready' && outcome.madeSecondary).toBe(false)
    // Nothing was sent to the account at all.
    expect(adsRequest).not.toHaveBeenCalled()
  })

  it('finds the one it made earlier by name when the recorded id has gone', async () => {
    stubGoogle({ list: [row({ resourceName: OURS, primaryForGoal: false })], reads: [[row({ resourceName: OURS, primaryForGoal: false })]] })
    const outcome = await ensureConversionAction({ customerId: CUSTOMER, current: 'customers/1/conversionActions/1' })
    expect(outcome.status === 'ready' && outcome.created).toBe(false)
    expect(adsRequest).not.toHaveBeenCalled()
  })

  it('ignores somebody else’s tracker and makes its own', async () => {
    stubGoogle({
      list: [row({ resourceName: THEIRS, name: 'Purchases (theirs)', primaryForGoal: false })],
      reads: [[row({ resourceName: OURS, primaryForGoal: false })]],
    })
    const outcome = await ensureConversionAction({ customerId: CUSTOMER, current: null })
    expect(outcome.status === 'ready' && outcome.created).toBe(true)

    const body = adsRequest.mock.calls[0]?.[1]?.body as { operations: Array<{ create: Record<string, unknown> }> }
    expect(body.operations[0]?.create).toMatchObject({
      name: MANAGED_ACTION_NAME,
      type: 'UPLOAD_CLICKS',
      category: 'PURCHASE',
      status: 'ENABLED',
      // Secondary from birth, and then read back rather than trusted.
      primaryForGoal: false,
      countingType: 'MANY_PER_CLICK',
    })
  })

  it('refuses to claim an action Google would not name', async () => {
    // Google took the create and answered with something unreadable. The action
    // may well exist; saying it does on that basis is the claim this module
    // refuses to make.
    adsRequest.mockResolvedValue({ results: [] })
    stubGoogle({ list: [], reads: [[]] })
    await expect(ensureConversionAction({ customerId: CUSTOMER, current: null })).rejects.toThrow(/again/)
  })

  it('refuses when the read-back finds nothing', async () => {
    stubGoogle({ list: [], reads: [[]] })
    await expect(ensureConversionAction({ customerId: CUSTOMER, current: null })).rejects.toThrow(/would not tell us/)
  })

  it('turns a primary tracker secondary, then reads it back', async () => {
    stubGoogle({
      list: [row({ resourceName: OURS, primaryForGoal: true })],
      // Before the update, then after it.
      reads: [[row({ resourceName: OURS, primaryForGoal: true })], [row({ resourceName: OURS, primaryForGoal: false })]],
    })
    const outcome = await ensureConversionAction({ customerId: CUSTOMER, current: OURS })
    expect(outcome.status).toBe('ready')
    expect(outcome.status === 'ready' && outcome.madeSecondary).toBe(true)

    const body = adsRequest.mock.calls[0]?.[1]?.body as {
      operations: Array<{ update: Record<string, unknown>; updateMask: string }>
    }
    expect(body.operations[0]?.update).toMatchObject({ resourceName: OURS, primaryForGoal: false })
    // ONE field in the mask. Naming more would have Google clear everything
    // else on the action back to its default.
    expect(body.operations[0]?.updateMask).toBe('primary_for_goal')
  })

  it('refuses when Google still says primary after the update', async () => {
    stubGoogle({
      list: [row({ resourceName: OURS, primaryForGoal: true })],
      reads: [[row({ resourceName: OURS, primaryForGoal: true })], [row({ resourceName: OURS, primaryForGoal: true })]],
    })
    const outcome = await ensureConversionAction({ customerId: CUSTOMER, current: OURS })
    expect(outcome.status).toBe('unusable')
    expect(outcome.status === 'unusable' && outcome.reason).toContain('PRIMARY')
  })

  it('refuses when Google will not say either way, rather than reading silence as secondary', async () => {
    stubGoogle({
      list: [row({ resourceName: OURS })],
      reads: [[row({ resourceName: OURS })], [row({ resourceName: OURS })]],
    })
    const outcome = await ensureConversionAction({ customerId: CUSTOMER, current: OURS })
    expect(outcome.status).toBe('unusable')
    expect(outcome.status === 'unusable' && outcome.reason).toContain('did not say')
  })

  it('reports a paused tracker as switched off, without creating a second one', async () => {
    // The whole reason the list query no longer filters on ENABLED: hidden, the
    // setup found neither the recorded one nor one by name, created a duplicate
    // and handed the owner Google's DUPLICATE_NAME refusal.
    stubGoogle({
      list: [row({ resourceName: OURS, status: 'REMOVED', primaryForGoal: false })],
      reads: [[row({ resourceName: OURS, status: 'REMOVED', primaryForGoal: false })]],
    })
    const outcome = await ensureConversionAction({ customerId: CUSTOMER, current: OURS })
    expect(outcome.status).toBe('unusable')
    expect(outcome.status === 'unusable' && outcome.reason).toContain('switched off')
    expect(adsRequest).not.toHaveBeenCalled()
  })

  it('reports the wrong kind of tracker without writing to it first', async () => {
    stubGoogle({
      list: [row({ resourceName: OURS, type: 'WEBPAGE', primaryForGoal: true })],
      reads: [[row({ resourceName: OURS, type: 'WEBPAGE', primaryForGoal: true })]],
    })
    const outcome = await ensureConversionAction({ customerId: CUSTOMER, current: OURS })
    expect(outcome.status).toBe('unusable')
    expect(outcome.status === 'unusable' && outcome.reason).toContain('Import from clicks')
    // Turning a tracker secondary that we are about to call unusable would be a
    // write to somebody's advertising account for nothing.
    expect(adsRequest).not.toHaveBeenCalled()
  })
})
