import { describe, it, expect } from 'vitest'
import {
  fetchUriForDisplay,
  hasWords,
  isOurFeedUrl,
  parseItemLevelIssues,
  productResourceSegment,
  parseFileUpload,
  parseInt64,
  parseItemIssues,
  parseReportingStatus,
  parseTimestamp,
} from '@/modules/google-shopping-for-shop/lib/health/parse'

// The shapes below are copied from Google's own published sample responses
// (developers.google.com/merchant/api, read 2026-09-22), not invented: the
// whole point of this file is that we parse what Google actually sends.

describe('item issues from product_view', () => {
  it('reads Google\'s own sample response', () => {
    const issues = parseItemIssues([
      {
        type: { code: 'invalid_string_value', canonicalAttribute: 'n:product_code' },
        severity: {
          severityPerReportingContext: [
            { reportingContext: 'SHOPPING_ADS', disapprovedCountries: ['US'] },
            { reportingContext: 'FREE_LISTINGS', disapprovedCountries: ['US'] },
          ],
          aggregatedSeverity: 'DISAPPROVED',
        },
        resolution: 'MERCHANT_ACTION',
      },
      {
        type: { code: 'apparel_missing_brand', canonicalAttribute: 'n:brand' },
        severity: {
          severityPerReportingContext: [{ reportingContext: 'SHOPPING_ADS', disapprovedCountries: ['US'] }],
          aggregatedSeverity: 'DEMOTED',
        },
        resolution: 'MERCHANT_ACTION',
      },
    ])
    expect(issues).toHaveLength(2)
    expect(issues[0]).toEqual({
      code: 'invalid_string_value',
      attribute: 'n:product_code',
      severity: 'disapproved',
      resolution: 'merchant_action',
      contexts: [
        { context: 'SHOPPING_ADS', disapprovedCountries: ['US'], demotedCountries: [] },
        { context: 'FREE_LISTINGS', disapprovedCountries: ['US'], demotedCountries: [] },
      ],
    })
    expect(issues[1]?.severity).toBe('demoted')
  })

  it('treats a missing itemIssues field as no issues, not as a crash', () => {
    expect(parseItemIssues(undefined)).toEqual([])
    expect(parseItemIssues(null)).toEqual([])
    expect(parseItemIssues({})).toEqual([])
  })

  it('keeps Google\'s "?" code and drops an issue with no code at all', () => {
    const issues = parseItemIssues([
      { type: { code: '?' }, severity: { aggregatedSeverity: 'PENDING' } },
      { severity: { aggregatedSeverity: 'DISAPPROVED' } },
      { type: {}, severity: { aggregatedSeverity: 'DISAPPROVED' } },
    ])
    expect(issues.map((issue) => issue.code)).toEqual(['?'])
  })

  it('merges two sightings of the same code and field, keeping the worse one', () => {
    // The table is keyed on (item, code, attribute): two rows with the same
    // key in one batch is an error Postgres refuses outright.
    const issues = parseItemIssues([
      {
        type: { code: 'image_link_broken', canonicalAttribute: 'n:image_link' },
        severity: { aggregatedSeverity: 'DEMOTED', severityPerReportingContext: [{ reportingContext: 'FREE_LISTINGS' }] },
      },
      {
        type: { code: 'image_link_broken', canonicalAttribute: 'n:image_link' },
        severity: { aggregatedSeverity: 'DISAPPROVED', severityPerReportingContext: [{ reportingContext: 'SHOPPING_ADS' }] },
      },
    ])
    expect(issues).toHaveLength(1)
    expect(issues[0]?.severity).toBe('disapproved')
    expect(issues[0]?.contexts.map((context) => context.context)).toEqual(['FREE_LISTINGS', 'SHOPPING_ADS'])
  })

  it('does not merge the same code against different fields', () => {
    const issues = parseItemIssues([
      { type: { code: 'missing_value', canonicalAttribute: 'n:brand' }, severity: { aggregatedSeverity: 'DEMOTED' } },
      { type: { code: 'missing_value', canonicalAttribute: 'n:gtin' }, severity: { aggregatedSeverity: 'DEMOTED' } },
    ])
    expect(issues).toHaveLength(2)
  })

  it('calls a severity it has never seen unknown rather than guessing', () => {
    const issues = parseItemIssues([{ type: { code: 'x' }, severity: { aggregatedSeverity: 'SOMETHING_NEW' } }])
    expect(issues[0]?.severity).toBe('unknown')
    expect(issues[0]?.resolution).toBe('unknown')
  })

  it('upper-cases, de-duplicates and sorts country codes', () => {
    const issues = parseItemIssues([{
      type: { code: 'x' },
      severity: {
        aggregatedSeverity: 'DISAPPROVED',
        severityPerReportingContext: [{ reportingContext: 'SHOPPING_ADS', disapprovedCountries: ['gb', 'GB', 'fr'] }],
      },
    }])
    expect(issues[0]?.contexts[0]?.disapprovedCountries).toEqual(['FR', 'GB'])
  })
})

describe('reporting context status', () => {
  it('maps Google\'s four values and shrugs at anything else', () => {
    expect(parseReportingStatus('ELIGIBLE')).toBe('eligible')
    expect(parseReportingStatus('ELIGIBLE_LIMITED')).toBe('limited')
    expect(parseReportingStatus('PENDING')).toBe('pending')
    expect(parseReportingStatus('NOT_ELIGIBLE_OR_DISAPPROVED')).toBe('not-eligible')
    expect(parseReportingStatus('AGGREGATED_REPORTING_CONTEXT_STATUS_UNSPECIFIED')).toBe('unknown')
    expect(parseReportingStatus(undefined)).toBe('unknown')
  })
})

describe('int64 and timestamps', () => {
  it('reads Google\'s decimal strings, and tells nothing from zero', () => {
    expect(parseInt64('4211')).toBe(4211)
    expect(parseInt64(0)).toBe(0)
    // Absent is not zero: a fetch that reported no count is not a fetch that
    // found none, and the screen says "not said" for one and "0" for the other.
    expect(parseInt64(undefined)).toBeNull()
    expect(parseInt64('')).toBeNull()
    expect(parseInt64('lots')).toBeNull()
    expect(parseInt64('9007199254740993')).toBeNull()
  })

  it('reads an RFC 3339 timestamp and refuses a broken one', () => {
    expect(parseTimestamp('2026-09-21T04:12:00Z')?.toISOString()).toBe('2026-09-21T04:12:00.000Z')
    expect(parseTimestamp('the other day')).toBeNull()
    expect(parseTimestamp(undefined)).toBeNull()
  })
})

describe('the last file upload', () => {
  it('reads a successful fetch', () => {
    const parsed = parseFileUpload({
      name: 'accounts/123/dataSources/456/fileUploads/latest',
      processingState: 'SUCCEEDED',
      itemsTotal: '4211',
      itemsCreated: '12',
      itemsUpdated: '4199',
      uploadTime: '2026-09-21T04:12:00Z',
    })
    expect(parsed.state).toBe('succeeded')
    expect(parsed.itemsTotal).toBe(4211)
    expect(parsed.issues).toEqual([])
    expect(parsed.uploadedAt?.toISOString()).toBe('2026-09-21T04:12:00.000Z')
  })

  it('puts errors above warnings and the biggest first', () => {
    const parsed = parseFileUpload({
      processingState: 'FAILED',
      issues: [
        { title: 'Small warning', code: 'a', count: '2', severity: 'WARNING' },
        { title: 'Big warning', code: 'b', count: '900', severity: 'WARNING' },
        { title: 'An error', code: 'c', count: '1', severity: 'ERROR', documentationUri: 'https://example.test/help' },
      ],
    })
    expect(parsed.state).toBe('failed')
    expect(parsed.issues.map((issue) => issue.title)).toEqual(['An error', 'Big warning', 'Small warning'])
    expect(parsed.issues[0]?.documentationUri).toBe('https://example.test/help')
    expect(parsed.issues[1]?.documentationUri).toBeNull()
  })

  it('survives an empty answer without claiming everything is fine', () => {
    const parsed = parseFileUpload(null)
    expect(parsed.state).toBe('unknown')
    expect(parsed.itemsTotal).toBeNull()
    expect(parsed.uploadedAt).toBeNull()
  })

  it('names an issue Google did not title', () => {
    const parsed = parseFileUpload({ processingState: 'SUCCEEDED', issues: [{ code: 'validation/invalid_value', severity: 'WARNING' }] })
    expect(parsed.issues[0]?.title).toBe('validation/invalid_value')
    const unnamed = parseFileUpload({ processingState: 'SUCCEEDED', issues: [{ severity: 'WARNING' }] })
    expect(unnamed.issues[0]?.title).toBe('Something Google did not name')
  })
})

describe('matching a Google fetch URL to our feed', () => {
  const ours = 'https://shop.example/google-shopping/feed.xml?key=abc123'

  it('matches although the secret key has been regenerated', () => {
    // Otherwise pressing "new feed address" would make Google's data source
    // stop being ours, and the feed check would report "not found" for ever.
    expect(isOurFeedUrl('https://shop.example/google-shopping/feed.xml?key=WHOLLY-DIFFERENT', ours)).toBe(true)
  })

  it('ignores a trailing slash and the case of the host', () => {
    expect(isOurFeedUrl('https://SHOP.example/google-shopping/feed.xml/?key=abc123', ours)).toBe(true)
  })

  it('does not claim another site, another path, or the review feed', () => {
    expect(isOurFeedUrl('https://other.example/google-shopping/feed.xml?key=abc123', ours)).toBe(false)
    expect(isOurFeedUrl('https://shop.example/some-other-feed.xml?key=abc123', ours)).toBe(false)
    // Same path, one parameter apart - and a different feed entirely.
    expect(isOurFeedUrl('https://shop.example/google-shopping/feed.xml?key=abc123&content=reviews', ours)).toBe(false)
  })

  it('refuses nonsense rather than throwing', () => {
    expect(isOurFeedUrl('not a url', ours)).toBe(false)
    expect(isOurFeedUrl(ours, 'not a url')).toBe(false)
  })
})

describe('the fetch URL we are allowed to store and show', () => {
  // The Health tab is gated shop.products; the feed address needs shop.manage.
  // The key must not cross that line, through the page or the API response.
  it('drops the query string, key and all', () => {
    expect(fetchUriForDisplay('https://shop.example/google-shopping/feed.xml?key=SECRET-TOKEN'))
      .toBe('https://shop.example/google-shopping/feed.xml')
    expect(fetchUriForDisplay('https://shop.example/feed.xml?key=a&content=reviews#frag'))
      .toBe('https://shop.example/feed.xml')
  })

  it('leaves an address with nothing to hide alone', () => {
    expect(fetchUriForDisplay('https://shop.example/google-shopping/feed.xml'))
      .toBe('https://shop.example/google-shopping/feed.xml')
  })

  it('answers nothing for anything it cannot take apart', () => {
    // Never falls back to the raw string: a URL we cannot parse is a URL we
    // cannot promise has no key in it.
    expect(fetchUriForDisplay('sftp shop.example ?key=SECRET')).toBe('')
    expect(fetchUriForDisplay('')).toBe('')
    expect(fetchUriForDisplay(null)).toBe('')
    expect(fetchUriForDisplay(undefined)).toBe('')
  })

  it('keeps an sftp address usable, without its credentials', () => {
    expect(fetchUriForDisplay('sftp://user:pw@files.example/out/feed.xml?key=SECRET'))
      .toBe('sftp://files.example/out/feed.xml')
  })
})

describe('Google\'s own words about one item (accounts.products)', () => {
  // Field names taken from Google's products_v1 reference, read 2026-09-22:
  // ProductStatus.itemLevelIssues[] -> code, description, detail,
  // documentation, attribute, reportingContext, resolution, severity,
  // applicableCountries.
  const sample = {
    name: 'accounts/123/products/en~GB~sku123',
    productStatus: {
      itemLevelIssues: [
        {
          code: 'image_link_broken',
          description: 'Invalid image [image link]',
          detail: 'Ensure the image is accessible and uses an accepted format',
          documentation: 'https://support.google.com/merchants/answer/6098289',
          attribute: 'imageLink',
          reportingContext: 'SHOPPING_ADS',
          resolution: 'MERCHANT_ACTION',
          severity: 'DISAPPROVED',
          applicableCountries: ['GB'],
        },
        {
          code: 'missing_gtin',
          description: 'Missing GTIN',
          attribute: 'gtin',
          reportingContext: 'FREE_LISTINGS',
          resolution: 'MERCHANT_ACTION',
          severity: 'DEMOTED',
          applicableCountries: ['gb', 'GB', 'fr'],
        },
      ],
    },
  }

  it('reads every field Google documents', () => {
    const issues = parseItemLevelIssues(sample)
    expect(issues).toHaveLength(2)
    expect(issues[0]).toEqual({
      code: 'image_link_broken',
      attribute: 'imageLink',
      description: 'Invalid image [image link]',
      detail: 'Ensure the image is accessible and uses an accepted format',
      documentationUrl: 'https://support.google.com/merchants/answer/6098289',
      severity: 'disapproved',
      resolution: 'merchant_action',
      reportingContext: 'SHOPPING_ADS',
      applicableCountries: ['GB'],
    })
    // Same tidying as everywhere else: upper-cased, de-duplicated, sorted.
    expect(issues[1]?.applicableCountries).toEqual(['FR', 'GB'])
    expect(issues[1]?.detail).toBe('')
    expect(issues[1]?.documentationUrl).toBeNull()
  })

  it('maps the per-issue severity, which is NOT the report\'s', () => {
    // ItemLevelIssue.severity is its own enum: NOT_IMPACTED / DEMOTED /
    // DISAPPROVED. It has no PENDING, and NOT_IMPACTED has no counterpart of
    // ours - so it becomes 'unknown' rather than being promoted to something
    // that sounds worse than Google meant.
    const parsed = (severity: string) => parseItemLevelIssues({ productStatus: { itemLevelIssues: [{ code: 'x', severity }] } })[0]?.severity
    expect(parsed('DISAPPROVED')).toBe('disapproved')
    expect(parsed('DEMOTED')).toBe('demoted')
    expect(parsed('NOT_IMPACTED')).toBe('unknown')
    expect(parsed('SEVERITY_UNSPECIFIED')).toBe('unknown')
    expect(parsed('SOMETHING_NEW')).toBe('unknown')
  })

  it('survives an empty or missing answer without inventing anything', () => {
    expect(parseItemLevelIssues(null)).toEqual([])
    expect(parseItemLevelIssues(undefined)).toEqual([])
    expect(parseItemLevelIssues({})).toEqual([])
    expect(parseItemLevelIssues({ productStatus: {} })).toEqual([])
    expect(parseItemLevelIssues({ productStatus: { itemLevelIssues: [] } })).toEqual([])
  })

  it('drops an issue with no code, which there is nothing to match against', () => {
    const issues = parseItemLevelIssues({ productStatus: { itemLevelIssues: [{ description: 'Something' }, { code: 'real' }] } })
    expect(issues.map((issue) => issue.code)).toEqual(['real'])
  })

  it('knows an explanation with no words in it from a real one', () => {
    // The screen must say "Google had nothing to add" rather than draw an
    // empty box, so this is the test that decides which.
    const bare = parseItemLevelIssues({ productStatus: { itemLevelIssues: [{ code: 'x', severity: 'DISAPPROVED' }] } })[0]
    expect(bare && hasWords(bare)).toBe(false)
    const real = parseItemLevelIssues(sample)[0]
    expect(real && hasWords(real)).toBe(true)
    const linkOnly = parseItemLevelIssues({ productStatus: { itemLevelIssues: [{ code: 'x', documentation: 'https://e.test' }] } })[0]
    expect(linkOnly && hasWords(linkOnly)).toBe(true)
  })
})

describe('naming one product to Google', () => {
  // products_v1 takes contentLanguage~feedLabel~offerId - THREE parts, no
  // channel. The reports API's product_view.id carries a fourth, and so did
  // v1beta's product name; passing either straight through asks for a product
  // that does not exist.
  it('base64url-encodes the three-part name, unpadded', () => {
    const segment = productResourceSegment({ contentLanguage: 'en', feedLabel: 'GB', offerId: 'sku123' })
    expect(segment).toBe('ZW5-R0J-c2t1MTIz')
    // Round-tripped rather than just eyeballed: this is the string Google
    // parses back into the product it looks up.
    expect(Buffer.from(segment ?? '', 'base64url').toString()).toBe('en~GB~sku123')
    expect(segment).not.toContain('=')
  })

  it('survives an offer id with the characters that break the plain form', () => {
    // Google REQUIRES the encoded form for ids carrying / % or ~, and a shop
    // whose SKUs have a slash in them is not unusual.
    // This exact pair is Google's OWN worked example in the products_v1
    // reference: the product id en~US~sku/123 encodes to ZW5-VVN-c2t1LzEyMw.
    const segment = productResourceSegment({ contentLanguage: 'en', feedLabel: 'US', offerId: 'sku/123' })
    expect(segment).toBe('ZW5-VVN-c2t1LzEyMw')
    expect(segment).not.toContain('/')
    expect(segment).not.toContain('~')
  })

  it('refuses to invent a name when the feed label is not set', () => {
    // Guessing one would ask Google about a product that does not exist and
    // report the 404 as though the item had gone. The screen says what to
    // fill in instead.
    expect(productResourceSegment({ contentLanguage: 'en', feedLabel: null, offerId: 'sku' })).toBeNull()
    expect(productResourceSegment({ contentLanguage: 'en', feedLabel: '  ', offerId: 'sku' })).toBeNull()
    expect(productResourceSegment({ contentLanguage: 'en', feedLabel: 'GB', offerId: '' })).toBeNull()
    expect(productResourceSegment({ contentLanguage: '', feedLabel: 'GB', offerId: 'sku' })).toBeNull()
  })
})
