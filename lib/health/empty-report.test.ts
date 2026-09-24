import { describe, it, expect, vi, beforeEach } from 'vitest'

// The guard that stops an EMPTY report wiping the ledger.
//
// Google answers 200 with no rows at all while an account is reprocessing
// after a feed change. Carrying on from there would close every open issue,
// blank the Health tab, clear the spike alert and reset the baseline - and
// tomorrow the same issues would come back dated today. This is the one path
// that must touch nothing, so it is tested on its own, with Google and the
// database both stubbed out.

const searchReport = vi.fn()
const writeItemIssues = vi.fn()
const syncDisapprovalAlert = vi.fn()
const readSpikeBaseline = vi.fn()
const recordIssueCheck = vi.fn()

vi.mock('@/modules/google-shopping-for-shop/lib/google/client', () => ({
  searchReport: (...args: unknown[]) => searchReport(...args),
}))
vi.mock('@/modules/google-shopping-for-shop/lib/google/credentials', () => ({
  hasGoogleCredentials: () => true,
}))
vi.mock('@/modules/google-shopping-for-shop/lib/settings', () => ({
  getGsfSettings: async () => ({
    merchantId: '123456789',
    lastDisapprovedCount: 40,
    disapprovalAlertThreshold: 25,
  }),
  recordIssueCheck: (...args: unknown[]) => recordIssueCheck(...args),
}))
vi.mock('@/modules/google-shopping-for-shop/lib/health/item-issues', () => ({
  writeItemIssues: (...args: unknown[]) => writeItemIssues(...args),
}))
vi.mock('@/modules/google-shopping-for-shop/lib/health/alerts', () => ({
  syncDisapprovalAlert: (...args: unknown[]) => syncDisapprovalAlert(...args),
  readSpikeBaseline: (...args: unknown[]) => readSpikeBaseline(...args),
}))
// Imported for the upsert path only, which an empty report never reaches.
vi.mock('@/lib/db/prisma', () => ({ prisma: { $executeRaw: vi.fn() } }))

const { refreshMerchantMatchStatus } = await import('@/modules/google-shopping-for-shop/lib/merchant-reports')

describe('a report with no rows in it', () => {
  beforeEach(() => {
    searchReport.mockReset()
    writeItemIssues.mockReset()
    syncDisapprovalAlert.mockReset()
    readSpikeBaseline.mockReset()
    recordIssueCheck.mockReset()
  })

  it('closes nothing, alerts nothing and records nothing', async () => {
    searchReport.mockResolvedValue([])

    const result = await refreshMerchantMatchStatus()

    expect(writeItemIssues).not.toHaveBeenCalled()
    expect(syncDisapprovalAlert).not.toHaveBeenCalled()
    // The baseline the next run compares against must not move either, or a
    // reprocessing account resets it to zero and the recovery back to normal
    // reads as a fresh spike.
    expect(recordIssueCheck).not.toHaveBeenCalled()
    expect(result.issuesSkipped).toBe(true)
    // Null, not zero. Zero would read as "nothing is wrong".
    expect(result.issues).toBeNull()
    expect(result.disapprovedItems).toBeNull()
    expect(result.spikeAlerted).toBe(false)
  })

  it('also does nothing when every row Google sent is unusable', async () => {
    // Rows with no offer id cannot be filed against anything, so a report made
    // entirely of them is as empty as one with no rows.
    searchReport.mockResolvedValue([{ productView: { id: 'en~GB~' } }, { productView: {} }, {}])

    const result = await refreshMerchantMatchStatus()

    expect(writeItemIssues).not.toHaveBeenCalled()
    expect(result.issuesSkipped).toBe(true)
  })

  it('does the work as normal once Google sends a real row', async () => {
    searchReport.mockResolvedValue([{ productView: { id: 'en~GB~a', offerId: 'a', title: 'A chair', itemIssues: [] } }])
    writeItemIssues.mockResolvedValue({ open: 0, disapprovedItems: 0, resolved: 3 })
    readSpikeBaseline.mockResolvedValue(null)
    syncDisapprovalAlert.mockResolvedValue(false)

    const result = await refreshMerchantMatchStatus()

    expect(writeItemIssues).toHaveBeenCalledOnce()
    expect(recordIssueCheck).toHaveBeenCalledOnce()
    expect(result.issuesSkipped).toBe(false)
    expect(result.issues).toBe(0)
  })
})
