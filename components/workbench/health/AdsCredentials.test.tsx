import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AdsCredentials } from '@/modules/google-shopping-for-shop/components/workbench/health/AdsPanel'
import type { AdsView } from '@/modules/google-shopping-for-shop/lib/google-ads/view'

// The Google Ads panel sits behind `shop.products`, and the environment route
// it saves to is admin-only. So the boxes have to be withheld from everyone
// else: a form that always 403s is a worse answer than no form at all, and a
// credential box in front of somebody who cannot use it is an invitation to
// paste a secret into a screen that will only refuse it.

function viewWith(over: Partial<AdsView> = {}): AdsView {
  return {
    enabled: false,
    uploadEnabled: false,
    spendImportEnabled: false,
    spendBackfillDays: 30,
    spendRetentionDays: 400,
    env: {
      GOOGLE_ADS_CLIENT_ID: false,
      GOOGLE_ADS_CLIENT_SECRET: false,
      GOOGLE_ADS_REFRESH_TOKEN: false,
      GOOGLE_ADS_CUSTOMER_ID: false,
      GOOGLE_ADS_LOGIN_CUSTOMER_ID: false,
      GOOGLE_ADS_DEVELOPER_TOKEN: false,
    },
    missing: ['GOOGLE_ADS_CLIENT_ID'],
    connected: false,
    isAdmin: true,
    conversionAction: { resourceName: null, name: null, primary: null, checkedAt: null, managedName: 'Website sales' },
    account: { currency: null, timeZone: null, checkedAt: null },
    uploads: { waiting: 0, uploaded: 0, refused: 0, skipped: 0, maxAttempts: 5, recent: [], problems: [] },
    lastRun: {
      startedAt: null, finishedAt: null, status: null, uploaded: 0, failed: 0, skipped: 0,
      lastError: null, running: false, stalled: false,
    },
    spend: {
      checkedAt: null, failedAt: null, lastError: null, importedThrough: null,
      heldFrom: null, heldTo: null, rowsHeld: 0,
    },
    ...over,
  }
}

describe('AdsCredentials', () => {
  it('gives an administrator a box for each detail, and a Save button', () => {
    const html = renderToStaticMarkup(<AdsCredentials view={viewWith()} />)
    expect(html.match(/<input/g) ?? []).toHaveLength(5)
    expect(html).toContain('Save these details')
  })

  it('withholds every box from somebody who is not an administrator', () => {
    const html = renderToStaticMarkup(<AdsCredentials view={viewWith({ isAdmin: false })} />)
    expect(html).not.toContain('<input')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('Save these details')
    expect(html).toContain('entered by an administrator')
  })

  it('still explains where the details come from when it will not take them', () => {
    const html = renderToStaticMarkup(<AdsCredentials view={viewWith({ isAdmin: false })} />)
    expect(html).toContain('Credentials')
    expect(html).toContain('ten-digit')
  })

  it('never puts a saved value in the page - it says so in words instead', () => {
    const html = renderToStaticMarkup(<AdsCredentials view={viewWith({
      env: {
        GOOGLE_ADS_CLIENT_ID: true,
        GOOGLE_ADS_CLIENT_SECRET: true,
        GOOGLE_ADS_REFRESH_TOKEN: true,
        GOOGLE_ADS_CUSTOMER_ID: true,
        GOOGLE_ADS_LOGIN_CUSTOMER_ID: false,
        GOOGLE_ADS_DEVELOPER_TOKEN: false,
      },
    })} />)
    expect(html).toContain('Already set')
    expect(html).toContain('Leave empty to keep what is saved')
    // Every box renders empty, whatever is stored on the hosting account.
    expect(html).not.toMatch(/<input[^>]*value="[^"]+"/)
  })

  it('hides the values as they are typed, and keeps the browser from filling them in', () => {
    const html = renderToStaticMarkup(<AdsCredentials view={viewWith()} />)
    expect(html.match(/type="password"/g) ?? []).toHaveLength(5)
    // React's server renderer prints the attribute in its JSX spelling; the
    // browser's parser lowercases it on the way in.
    expect(html.match(/autocomplete="off"/gi) ?? []).toHaveLength(5)
  })

  it('is tucked away once the details are all there', () => {
    const html = renderToStaticMarkup(<AdsCredentials view={viewWith({ connected: true, missing: [] })} />)
    expect(html).toContain('How to connect Google Ads')
    expect(html).not.toContain('<input')
  })
})
