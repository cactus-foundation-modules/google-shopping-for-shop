import { describe, it, expect } from 'vitest'
import { shouldAskForConversions, withConversionFallback } from '@/modules/google-shopping-for-shop/lib/performance/import'
import { GoogleApiError, GoogleNetworkError } from '@/modules/google-shopping-for-shop/lib/google/errors'

const NOW = new Date('2026-09-23T10:00:00.000Z')

// The rules that stop one bad afternoon becoming a permanent claim about an
// owner's Merchant Center account. Worth their own file: the first contact
// with a real account is also the first chance the conversion query gets, so a
// latch with no way out would be wrong precisely when it mattered most.
describe('shouldAskForConversions', () => {
  it('asks when nobody has ever found out', () => {
    expect(shouldAskForConversions({ available: null, checkedAt: null, manual: false, now: NOW })).toBe(true)
  })

  it('asks when Google said yes last time', () => {
    expect(shouldAskForConversions({ available: true, checkedAt: NOW, manual: false, now: NOW })).toBe(true)
  })

  it('believes a fresh refusal on an ordinary daily run', () => {
    const yesterday = new Date(NOW.getTime() - 86_400_000)
    expect(shouldAskForConversions({ available: false, checkedAt: yesterday, manual: false, now: NOW })).toBe(false)
  })

  it('asks again anyway when a person pressed Fetch now', () => {
    const yesterday = new Date(NOW.getTime() - 86_400_000)
    expect(shouldAskForConversions({ available: false, checkedAt: yesterday, manual: true, now: NOW })).toBe(true)
  })

  it('asks again once the refusal has gone stale', () => {
    const thirtyDays = new Date(NOW.getTime() - 30 * 86_400_000)
    const twentyNine = new Date(NOW.getTime() - 29 * 86_400_000)
    expect(shouldAskForConversions({ available: false, checkedAt: thirtyDays, manual: false, now: NOW })).toBe(true)
    expect(shouldAskForConversions({ available: false, checkedAt: twentyNine, manual: false, now: NOW })).toBe(false)
  })

  it('asks when a refusal carries no date, which is a refusal nobody can date', () => {
    expect(shouldAskForConversions({ available: false, checkedAt: null, manual: false, now: NOW })).toBe(true)
  })
})

// The fallback is decided by BEHAVIOUR, not by reading Google's error text for
// the word "conversion" - which would make the whole thing hostage to how
// Google words a sentence. These cases are the proof.
describe('withConversionFallback', () => {
  it('does not ask twice when the first attempt works', async () => {
    const asked: boolean[] = []
    const outcome = await withConversionFallback(async (conversions) => {
      asked.push(conversions)
      return 'rows'
    }, true)
    expect(outcome).toEqual({ result: 'rows', conversionsRefused: false })
    expect(asked).toEqual([true])
  })

  it('proves the conversion fields were the cause by asking again without them', async () => {
    // Note the message: it never mentions conversions. Under the old
    // substring test this would have been thrown instead.
    const asked: boolean[] = []
    const outcome = await withConversionFallback(async (conversions) => {
      asked.push(conversions)
      if (conversions) throw new GoogleApiError('Field is not selectable for this account.', 400)
      return 'rows'
    }, true)
    expect(outcome).toEqual({ result: 'rows', conversionsRefused: true })
    expect(asked).toEqual([true, false])
  })

  it('does not offer the retry once a page has already been accepted', async () => {
    // A complaint about WHICH FIELDS were selected arrives on page one, since
    // the query is identical every page. A 400 on page three is far more
    // likely a spent page token or a passing fault, and retrying there and
    // succeeding - because the fault cleared - would record a conversions
    // refusal for something entirely unrelated.
    let pages = 0
    const asked: boolean[] = []
    await expect(withConversionFallback(
      async (conversions) => {
        asked.push(conversions)
        pages += 2
        throw new GoogleApiError('Invalid page token', 400)
      },
      true,
      () => pages === 0,
    )).rejects.toThrow('Invalid page token')
    // Asked once, never retried.
    expect(asked).toEqual([true])
  })

  it('still offers the retry when the 400 arrived before any page', async () => {
    const pages = 0
    const outcome = await withConversionFallback(
      async (conversions) => {
        if (conversions) throw new GoogleApiError('Nope', 400)
        return 'rows'
      },
      true,
      () => pages === 0,
    )
    expect(outcome).toEqual({ result: 'rows', conversionsRefused: true })
  })

  it('throws the ORIGINAL error when the shorter query fails too', async () => {
    // The 400 was about something else, so the second complaint describes a
    // query nobody asked for. The first one is the useful sentence.
    const first = new GoogleApiError("Invalid date '2026-13-01'", 400)
    const second = new GoogleApiError('Some other thing entirely', 400)
    await expect(withConversionFallback(async (conversions) => {
      throw conversions ? first : second
    }, true)).rejects.toBe(first)
  })

  it('never retries when conversions were not being asked for in the first place', async () => {
    const asked: boolean[] = []
    await expect(withConversionFallback(async (conversions) => {
      asked.push(conversions)
      throw new GoogleApiError('Nope', 400)
    }, false)).rejects.toThrow('Nope')
    expect(asked).toEqual([false])
  })

  it('only a 400 is worth a second try - fewer fields fix none of the others', async () => {
    for (const status of [403, 404, 429, 500, 503]) {
      const asked: boolean[] = []
      await expect(withConversionFallback(async (conversions) => {
        asked.push(conversions)
        throw new GoogleApiError('No', status)
      }, true)).rejects.toThrow('No')
      expect(asked).toEqual([true])
    }
  })

  it('passes a non-Google failure straight through', async () => {
    const network = new GoogleNetworkError('Could not reach Google')
    await expect(withConversionFallback(async () => { throw network }, true)).rejects.toBe(network)
    const plain = new Error('something else')
    await expect(withConversionFallback(async () => { throw plain }, true)).rejects.toBe(plain)
  })
})
