import { createHmac } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { resetKeyringState, setKeyringState } from '@/lib/crypto/keyring'

vi.mock('@/lib/auth/rate-limit', () => ({ getClientIp: async () => '203.0.113.9' }))

import { visitorKeys } from '@/modules/google-shopping-for-shop/lib/click-tracking/visitor'

// Visitor keys are derived from the site's stable salt, so a change of encryption
// key (core's lib/crypto/keyring.ts) neither re-keys them nor splits a visitor.

const OLD = '1a'.repeat(32)
const NEW = '2b'.repeat(32)
const saved = process.env.ENCRYPTION_KEY
const now = new Date('2026-10-30T12:00:00Z')
const request = { headers: new Headers({ 'user-agent': 'test-agent' }) } as unknown as NextRequest

beforeEach(() => {
  resetKeyringState()
  process.env.ENCRYPTION_KEY = OLD
})
afterEach(() => {
  resetKeyringState()
  if (saved === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = saved
})

describe('visitor keys and the encryption key', () => {
  it('are exactly what they were before the salt existed', async () => {
    const keys = await visitorKeys(request, now)
    const expected = createHmac('sha256', OLD)
      .update(`gsf-rate:${['203.0.113.9', '2026-10-30'].join('\u0000')}`)
      .digest('base64url')
      .slice(0, 32)
    expect(keys?.rateKey).toBe(expected)
  })

  it('do not change when the key does', async () => {
    const before = await visitorKeys(request, now)
    process.env.ENCRYPTION_KEY = NEW
    setKeyringState({ previous: [OLD], derivationSalt: OLD })
    expect(await visitorKeys(request, now)).toEqual(before)
  })

  it('refuse to derive anything on a site with no key and no salt', async () => {
    delete process.env.ENCRYPTION_KEY
    expect(await visitorKeys(request, now)).toBeNull()
  })
})
