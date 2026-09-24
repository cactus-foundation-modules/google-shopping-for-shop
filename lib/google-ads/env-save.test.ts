import { describe, it, expect } from 'vitest'
import {
  ADS_ENV_FIELDS,
  adsEnvVarsToSave,
  describeAdsEnvSave,
  describeAdsEnvSaveFailure,
} from '@/modules/google-shopping-for-shop/lib/google-ads/env-save'

describe('adsEnvVarsToSave', () => {
  it('sends only the boxes that were filled in', () => {
    expect(adsEnvVarsToSave({ GOOGLE_ADS_CLIENT_ID: 'abc.apps.googleusercontent.com' })).toEqual([
      { key: 'GOOGLE_ADS_CLIENT_ID', value: 'abc.apps.googleusercontent.com' },
    ])
  })

  it('treats a blank, a space and an untouched box the same: leave that setting alone', () => {
    expect(adsEnvVarsToSave({
      GOOGLE_ADS_CLIENT_ID: '',
      GOOGLE_ADS_CLIENT_SECRET: '   ',
      GOOGLE_ADS_REFRESH_TOKEN: '\n\t',
    })).toEqual([])
  })

  it('trims what it does send - a pasted credential carries a trailing newline more often than not', () => {
    expect(adsEnvVarsToSave({ GOOGLE_ADS_REFRESH_TOKEN: '  1//token-value\n' })).toEqual([
      { key: 'GOOGLE_ADS_REFRESH_TOKEN', value: '1//token-value' },
    ])
  })

  it('keeps the order the screen shows, whatever order the boxes were typed in', () => {
    const entries = adsEnvVarsToSave({
      GOOGLE_ADS_CUSTOMER_ID: '123-456-7890',
      GOOGLE_ADS_CLIENT_ID: 'id',
      GOOGLE_ADS_CLIENT_SECRET: 'secret',
    })
    expect(entries.map((entry) => entry.key)).toEqual([
      'GOOGLE_ADS_CLIENT_ID',
      'GOOGLE_ADS_CLIENT_SECRET',
      'GOOGLE_ADS_CUSTOMER_ID',
    ])
  })

  it('offers no box for the retired developer token', () => {
    expect(ADS_ENV_FIELDS).not.toContain('GOOGLE_ADS_DEVELOPER_TOKEN')
  })

  it('never invents a key core does not manage', () => {
    // Anything not on the list is ignored outright rather than posted and
    // refused: the four core accepts are the four this module declares.
    const entries = adsEnvVarsToSave({ DATABASE_URL: 'postgres://nope' } as Record<string, string>)
    expect(entries).toEqual([])
  })
})

describe('describeAdsEnvSave', () => {
  it('counts what was written and always says a rebuild is still needed', () => {
    const text = describeAdsEnvSave(3, [])
    expect(text).toContain('3 details were saved.')
    expect(text).toMatch(/next deployment/i)
    expect(text).toMatch(/notice has been raised/i)
  })

  it('says "one detail" rather than "1 details"', () => {
    expect(describeAdsEnvSave(1, [])).toContain('One detail was saved.')
  })

  it('names anything the site would not take, by its screen name', () => {
    const text = describeAdsEnvSave(2, ['GOOGLE_ADS_REFRESH_TOKEN'])
    expect(text).toContain('Google Ads permission token')
    expect(text).toContain('was not saved')
    expect(text).toMatch(/module needs updating/i)
  })

  it('joins several refused ones into one readable sentence', () => {
    const text = describeAdsEnvSave(1, ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET'])
    expect(text).toContain('Google Ads sign-in ID and Google Ads sign-in secret')
    expect(text).toContain('were not saved')
  })
})

describe('describeAdsEnvSaveFailure', () => {
  it('turns every refusal into its own sentence, and never repeats one', () => {
    const sentences = [
      describeAdsEnvSaveFailure(401, 'Not authenticated'),
      describeAdsEnvSaveFailure(403, 'Forbidden'),
      describeAdsEnvSaveFailure(
        503,
        'Environment variables are managed via .env.local in local-development mode. Edit the file and restart the dev server.',
      ),
      describeAdsEnvSaveFailure(503, 'VERCEL_API_TOKEN and VERCEL_PROJECT_ID are required'),
      describeAdsEnvSaveFailure(400, 'These settings are not managed by this site: GOOGLE_ADS_CLIENT_ID.'),
      describeAdsEnvSaveFailure(502, 'Failed to write env vars: 500 from Vercel'),
    ]
    expect(new Set(sentences).size).toBe(sentences.length)
  })

  it('tells someone who is signed out to sign back in', () => {
    expect(describeAdsEnvSaveFailure(401, 'Not authenticated')).toMatch(/sign in again/i)
  })

  it('tells someone without the permission to ask an administrator', () => {
    expect(describeAdsEnvSaveFailure(403, 'Forbidden')).toMatch(/only an administrator/i)
  })

  it('sends a local site to its own file rather than to a hosting dashboard', () => {
    const text = describeAdsEnvSaveFailure(
      503,
      'Environment variables are managed via .env.local in local-development mode. Edit the file and restart the dev server.',
    )
    expect(text).toContain('.env.local')
    expect(text).toMatch(/restart the development server/i)
    expect(text).not.toMatch(/hosting dashboard/i)
  })

  it('sends a site with no hosting connection to the hosting dashboard, and names no token', () => {
    const text = describeAdsEnvSaveFailure(503, 'VERCEL_API_TOKEN and VERCEL_PROJECT_ID are required')
    expect(text).toMatch(/hosting dashboard/i)
    expect(text).not.toContain('VERCEL_API_TOKEN')
    expect(text).not.toContain('.env.local')
  })

  it('does not leave a half-saved impression when the write itself failed', () => {
    expect(describeAdsEnvSaveFailure(502, 'Failed to write env vars: boom')).toMatch(/nothing was saved/i)
  })

  it('falls back to whatever the site said when the status is one nobody planned for', () => {
    expect(describeAdsEnvSaveFailure(418, 'The site is a teapot.')).toBe('The site is a teapot.')
    expect(describeAdsEnvSaveFailure(418, '   ')).toMatch(/could not be saved/i)
  })
})
