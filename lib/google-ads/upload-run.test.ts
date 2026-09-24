import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GsfSettings } from '@/modules/google-shopping-for-shop/lib/types'

// The guard ladder in runConversionUpload IS the safeguard against a shop's ad
// sales being counted twice, and verifyConversionAction is the question it
// turns on. Everything Google-facing and everything database-facing is stubbed
// so the decisions can be put under a microscope.

const getGsfSettings = vi.hoisted(() => vi.fn())
const recordAdsConversionAction = vi.hoisted(() => vi.fn())
vi.mock('@/modules/google-shopping-for-shop/lib/settings', () => ({ getGsfSettings, recordAdsConversionAction }))

const readConversionAction = vi.hoisted(() => vi.fn())
vi.mock('@/modules/google-shopping-for-shop/lib/google-ads/conversion-action', () => ({ readConversionAction }))

const adsRequest = vi.hoisted(() => vi.fn())
vi.mock('@/modules/google-shopping-for-shop/lib/google-ads/client', () => ({ adsRequest }))

const store = vi.hoisted(() => ({
  claimAdsRun: vi.fn(),
  countUploadableOrders: vi.fn(),
  readUploadTotals: vi.fn(),
  readUploadableOrders: vi.fn(),
  recordUploadOutcome: vi.fn(),
  releaseAdsRun: vi.fn(),
  abandonAdsRun: vi.fn(),
}))
vi.mock('@/modules/google-shopping-for-shop/lib/google-ads/store', () => store)

const setAdsUploadAlert = vi.hoisted(() => vi.fn())
const isAlertUp = vi.hoisted(() => vi.fn())
vi.mock('@/modules/google-shopping-for-shop/lib/health/alerts', () => ({
  setAdsUploadAlert,
  isAlertUp,
  ALERT_KEYS: { adsUpload: 'google-shopping:ads-upload' },
}))

const recordChange = vi.hoisted(() => vi.fn())
vi.mock('@/modules/google-shopping-for-shop/lib/change-log', () => ({ recordChange }))

const { ACTION_TRUST_WINDOW_MS, runConversionUpload, verifyConversionAction } =
  await import('@/modules/google-shopping-for-shop/lib/google-ads/upload')

const ACTION = 'customers/1234567890/conversionActions/555'

function settings(patch: Partial<GsfSettings> = {}): GsfSettings {
  return {
    adsEnabled: true,
    adsConversionUploadEnabled: true,
    adsConversionAction: ACTION,
    adsConversionActionName: 'Website sales',
    adsConversionActionPrimary: false,
    adsConversionActionCheckedAt: new Date(),
    ...patch,
  } as unknown as GsfSettings
}

function connected() {
  vi.stubEnv('GOOGLE_ADS_CLIENT_ID', 'client-1')
  vi.stubEnv('GOOGLE_ADS_CLIENT_SECRET', 'secret-1')
  vi.stubEnv('GOOGLE_ADS_REFRESH_TOKEN', 'refresh-1')
  vi.stubEnv('GOOGLE_ADS_CUSTOMER_ID', '1234567890')
}

/** Google still says secondary. */
function stillSecondary() {
  readConversionAction.mockResolvedValue({
    resourceName: ACTION, id: '555', name: 'Website sales', type: 'UPLOAD_CLICKS',
    status: 'ENABLED', category: 'PURCHASE', primaryForGoal: false,
  })
}

beforeEach(() => {
  for (const fn of [getGsfSettings, recordAdsConversionAction, readConversionAction, adsRequest, setAdsUploadAlert, isAlertUp, recordChange]) {
    fn.mockReset()
  }
  for (const fn of Object.values(store)) fn.mockReset()
  isAlertUp.mockResolvedValue(false)
  setAdsUploadAlert.mockResolvedValue(false)
  recordAdsConversionAction.mockResolvedValue(undefined)
  recordChange.mockResolvedValue(undefined)
  store.countUploadableOrders.mockResolvedValue(1)
  store.claimAdsRun.mockResolvedValue(true)
  store.readUploadableOrders.mockResolvedValue([])
  store.readUploadTotals.mockResolvedValue({ uploaded: 0, refused: 0, skipped: 0 })
  store.recordUploadOutcome.mockResolvedValue(undefined)
  store.releaseAdsRun.mockResolvedValue(undefined)
  store.abandonAdsRun.mockResolvedValue(undefined)
  connected()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('verifyConversionAction', () => {
  const stored = { primary: false, checkedAt: new Date() }

  it('asks Google every time and records what it was told', async () => {
    stillSecondary()
    const answer = await verifyConversionAction({ customerId: '1234567890', resourceName: ACTION, stored })
    expect(answer.status).toBe('secondary')
    expect(readConversionAction).toHaveBeenCalledWith('1234567890', ACTION, {})
    expect(recordAdsConversionAction).toHaveBeenCalledWith(expect.objectContaining({ resourceName: ACTION, primary: false }))
  })

  it('catches a tracker that has been made PRIMARY since it was set up', async () => {
    // The hole this function exists to close: the stored answer says secondary
    // because that is what it was on the day it was made, and somebody changed
    // it in the Google Ads screens a week later.
    readConversionAction.mockResolvedValue({
      resourceName: ACTION, id: '555', name: 'Website sales', type: 'UPLOAD_CLICKS',
      status: 'ENABLED', category: 'PURCHASE', primaryForGoal: true,
    })
    const answer = await verifyConversionAction({ customerId: '1234567890', resourceName: ACTION, stored })
    expect(answer.status).toBe('action-is-primary')
    // And the new answer is written down, so the panel agrees with the refusal.
    expect(recordAdsConversionAction).toHaveBeenCalledWith(expect.objectContaining({ primary: true }))
  })

  it('reads a missing field as not known rather than as secondary', async () => {
    readConversionAction.mockResolvedValue({
      resourceName: ACTION, id: '555', name: null, type: 'UPLOAD_CLICKS',
      status: 'ENABLED', category: null, primaryForGoal: null,
    })
    expect((await verifyConversionAction({ customerId: '1234567890', resourceName: ACTION, stored })).status)
      .toBe('action-unchecked')
  })

  it('forgets a tracker Google no longer has', async () => {
    readConversionAction.mockResolvedValue(null)
    const answer = await verifyConversionAction({ customerId: '1234567890', resourceName: ACTION, stored })
    expect(answer.status).toBe('action-missing')
    expect(recordAdsConversionAction).toHaveBeenCalledWith(expect.objectContaining({ resourceName: null, primary: null }))
  })

  it('leans on a recent answer when Google cannot be asked at all', async () => {
    // A rate limit must not stop a shop's reporting dead.
    readConversionAction.mockRejectedValue(new Error('rate limited'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const answer = await verifyConversionAction({
      customerId: '1234567890',
      resourceName: ACTION,
      stored: { primary: false, checkedAt: new Date(Date.now() - 60_000) },
    })
    expect(answer.status).toBe('secondary')
    // Nothing new was learned, so nothing is written down.
    expect(recordAdsConversionAction).not.toHaveBeenCalled()
  })

  it('stops sending once that answer is too old to mean anything', async () => {
    readConversionAction.mockRejectedValue(new Error('still rate limited'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const answer = await verifyConversionAction({
      customerId: '1234567890',
      resourceName: ACTION,
      stored: { primary: false, checkedAt: new Date(Date.now() - ACTION_TRUST_WINDOW_MS - 1) },
    })
    expect(answer.status).toBe('action-stale')
  })

  it('never lets the fallback rescue a stored primary, however fresh', async () => {
    readConversionAction.mockRejectedValue(new Error('rate limited'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const primary of [true, null]) {
      const answer = await verifyConversionAction({
        customerId: '1234567890',
        resourceName: ACTION,
        stored: { primary, checkedAt: new Date() },
      })
      expect(answer.status).toBe(primary === true ? 'action-is-primary' : 'action-unchecked')
    }
  })

  it('treats a stored answer with no date at all as stale', async () => {
    readConversionAction.mockRejectedValue(new Error('rate limited'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await verifyConversionAction({
      customerId: '1234567890', resourceName: ACTION, stored: { primary: false, checkedAt: null },
    })).status).toBe('action-stale')
  })
})

describe('runConversionUpload: the ways out', () => {
  it('sends nothing and clears the notice when Google Ads is switched off', async () => {
    getGsfSettings.mockResolvedValue(settings({ adsEnabled: false }))
    const outcome = await runConversionUpload()
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'off' })
    // Cleared, not left up: an alert about something that is no longer
    // happening is worse than no alert.
    expect(setAdsUploadAlert).toHaveBeenCalledWith({ failed: false })
    expect(store.claimAdsRun).not.toHaveBeenCalled()
  })

  it('does the same when only the sending is switched off', async () => {
    getGsfSettings.mockResolvedValue(settings({ adsConversionUploadEnabled: false }))
    expect(await runConversionUpload()).toMatchObject({ status: 'skipped', reason: 'upload-off' })
    expect(setAdsUploadAlert).toHaveBeenCalledWith({ failed: false })
  })

  it('raises a notice when it is switched on and cannot run', async () => {
    getGsfSettings.mockResolvedValue(settings())
    vi.stubEnv('GOOGLE_ADS_REFRESH_TOKEN', '')
    expect(await runConversionUpload()).toMatchObject({ status: 'skipped', reason: 'no-credentials' })
    expect(setAdsUploadAlert).toHaveBeenCalledWith(expect.objectContaining({ failed: true }))
  })

  it('refuses when no tracker has been set up', async () => {
    getGsfSettings.mockResolvedValue(settings({ adsConversionAction: null }))
    expect(await runConversionUpload()).toMatchObject({ status: 'skipped', reason: 'no-conversion-action' })
    expect(readConversionAction).not.toHaveBeenCalled()
  })

  it('spends no quota at all on a shop with nothing to send', async () => {
    getGsfSettings.mockResolvedValue(settings())
    store.countUploadableOrders.mockResolvedValue(0)
    expect(await runConversionUpload()).toMatchObject({ status: 'skipped', reason: 'nothing-to-do' })
    // No question put to Google: a shop sending nothing cannot double-count
    // anything, and an hourly question on every quiet install is a bill nobody
    // agreed to.
    expect(readConversionAction).not.toHaveBeenCalled()
    expect(setAdsUploadAlert).toHaveBeenCalledWith({ failed: false })
  })

  it('REFUSES when Google now says the tracker is primary, without taking the slot', async () => {
    getGsfSettings.mockResolvedValue(settings())
    readConversionAction.mockResolvedValue({
      resourceName: ACTION, id: '555', name: 'Website sales', type: 'UPLOAD_CLICKS',
      status: 'ENABLED', category: 'PURCHASE', primaryForGoal: true,
    })
    const outcome = await runConversionUpload()
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'action-is-primary' })
    expect(outcome.status === 'skipped' && outcome.message).toContain('counted twice')
    expect(store.claimAdsRun).not.toHaveBeenCalled()
    expect(adsRequest).not.toHaveBeenCalled()
    expect(setAdsUploadAlert).toHaveBeenCalledWith(expect.objectContaining({ failed: true }))
  })

  it('refuses when Google will not say whether it is primary', async () => {
    getGsfSettings.mockResolvedValue(settings())
    readConversionAction.mockResolvedValue({
      resourceName: ACTION, id: '555', name: null, type: 'UPLOAD_CLICKS',
      status: 'ENABLED', category: null, primaryForGoal: null,
    })
    expect(await runConversionUpload()).toMatchObject({ status: 'skipped', reason: 'action-unchecked' })
    expect(adsRequest).not.toHaveBeenCalled()
  })

  it('refuses when the tracker has been deleted at Google', async () => {
    getGsfSettings.mockResolvedValue(settings())
    readConversionAction.mockResolvedValue(null)
    expect(await runConversionUpload()).toMatchObject({ status: 'skipped', reason: 'action-missing' })
    expect(adsRequest).not.toHaveBeenCalled()
  })

  it('refuses when Google cannot be asked and the last answer has gone stale', async () => {
    getGsfSettings.mockResolvedValue(settings({ adsConversionActionCheckedAt: new Date(Date.now() - ACTION_TRUST_WINDOW_MS - 1) }))
    readConversionAction.mockRejectedValue(new Error('rate limited'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await runConversionUpload()).toMatchObject({ status: 'skipped', reason: 'action-stale' })
    expect(adsRequest).not.toHaveBeenCalled()
  })

  it('stands aside when another run already holds the slot', async () => {
    getGsfSettings.mockResolvedValue(settings())
    stillSecondary()
    store.claimAdsRun.mockResolvedValue(false)
    expect(await runConversionUpload()).toMatchObject({ status: 'skipped', reason: 'already-running' })
    // Whatever that run finds is its news to report, so the notice is left
    // exactly as it was.
    expect(setAdsUploadAlert).not.toHaveBeenCalled()
  })
})

describe('runConversionUpload: a run that goes ahead', () => {
  const ORDER = {
    orderId: 'ord_1',
    orderNumber: 'DW000123',
    clickEventId: 'clk_1',
    clickId: 'gclid-1',
    clickIdKind: 'gclid',
    landedAt: new Date('2026-09-20T09:00:00Z'),
    confirmedAt: new Date('2026-09-20T11:32:45Z'),
    value: '412.50',
    currency: 'GBP',
    attempts: 0,
  }

  it('verifies first, then sends, and records what Google said', async () => {
    getGsfSettings.mockResolvedValue(settings())
    stillSecondary()
    store.readUploadableOrders.mockResolvedValueOnce([ORDER]).mockResolvedValue([])
    store.countUploadableOrders.mockResolvedValueOnce(1).mockResolvedValue(0)
    adsRequest.mockResolvedValue({ results: [{ gclid: 'gclid-1', conversionAction: ACTION }] })

    const outcome = await runConversionUpload()
    expect(outcome.status).toBe('ran')
    expect(outcome.status === 'ran' && outcome.summary).toMatchObject({ status: 'ok', uploaded: 1, failed: 0, skipped: 0 })
    expect(readConversionAction).toHaveBeenCalledOnce()

    const [path, init] = adsRequest.mock.calls[0] ?? []
    expect(path).toBe('customers/1234567890:uploadClickConversions')
    const body = init?.body as { conversions: Array<Record<string, unknown>>; partialFailure: boolean }
    // Google's own reference: "This should always be set to true."
    expect(body.partialFailure).toBe(true)
    expect(body.conversions[0]).toMatchObject({ conversionAction: ACTION, orderId: 'ord_1', gclid: 'gclid-1' })
    expect(store.recordUploadOutcome).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'ord_1', status: 'uploaded' }))
    expect(store.releaseAdsRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok', uploaded: 1 }))
  })

  it('leaves out a sale it will not build, and never offers it to Google', async () => {
    getGsfSettings.mockResolvedValue(settings())
    stillSecondary()
    // Paid before the visit it is credited to, which Google would refuse and
    // which nothing here is willing to nudge forward.
    store.readUploadableOrders
      .mockResolvedValueOnce([{ ...ORDER, confirmedAt: new Date('2026-09-20T08:00:00Z') }])
      .mockResolvedValue([])
    store.countUploadableOrders.mockResolvedValueOnce(1).mockResolvedValue(0)

    const outcome = await runConversionUpload()
    expect(outcome.status === 'ran' && outcome.summary).toMatchObject({ uploaded: 0, skipped: 1 })
    expect(adsRequest).not.toHaveBeenCalled()
    expect(store.recordUploadOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }))
  })

  it('gives the slot back without overwriting the last real run when nothing happened', async () => {
    getGsfSettings.mockResolvedValue(settings())
    stillSecondary()
    // Another run got there between the count and the claim.
    store.readUploadableOrders.mockResolvedValue([])
    const outcome = await runConversionUpload()
    expect(outcome.status).toBe('ran')
    expect(store.abandonAdsRun).toHaveBeenCalledOnce()
    expect(store.releaseAdsRun).not.toHaveBeenCalled()
  })

  it('raises the notice from the TABLE, not from this run’s own figures', async () => {
    getGsfSettings.mockResolvedValue(settings())
    stillSecondary()
    store.readUploadableOrders.mockResolvedValueOnce([ORDER]).mockResolvedValue([])
    store.countUploadableOrders.mockResolvedValueOnce(1).mockResolvedValue(0)
    adsRequest.mockResolvedValue({ results: [{ gclid: 'gclid-1' }] })
    // A clean run, but yesterday's refusals are still sitting there.
    store.readUploadTotals.mockResolvedValue({ uploaded: 40, refused: 12, skipped: 0 })

    await runConversionUpload()
    expect(setAdsUploadAlert).toHaveBeenLastCalledWith(expect.objectContaining({ failed: true, items: 12 }))
  })

  it('stamps a failure and hands the slot back when the run dies', async () => {
    getGsfSettings.mockResolvedValue(settings())
    stillSecondary()
    store.readUploadableOrders.mockRejectedValue(new Error('the database went away'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const outcome = await runConversionUpload()
    expect(outcome.status === 'ran' && outcome.summary.status).toBe('failed')
    // The stamp records a FAILURE rather than being left alone, so no screen
    // can read the run before this one as though it were this one.
    expect(store.releaseAdsRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
    expect(setAdsUploadAlert).toHaveBeenLastCalledWith(expect.objectContaining({ failed: true }))
  })
})
