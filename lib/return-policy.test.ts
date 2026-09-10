import { describe, it, expect } from 'vitest'
import { returnPolicyLabelFor } from '@/modules/google-shopping-for-shop/lib/return-policy'
import { NON_RETURNABLE_DEFAULT_NOTE } from '@/modules/shop/lib/returnable'

const BESPOKE = 'Upholstered to order in the fabric you choose, so we cannot take it back.'
const PAINTED = 'Made to order and painted in the colour you choose, so we cannot take it back.'

describe('returnPolicyLabelFor', () => {
  it('leaves a returnable item unlabelled', () => {
    expect(returnPolicyLabelFor({ returnable: null, nonReturnableNote: null }, { returnable: null, nonReturnableNote: null })).toBeUndefined()
    expect(returnPolicyLabelFor({ returnable: null, nonReturnableNote: null }, { returnable: true, nonReturnableNote: null })).toBeUndefined()
  })

  it('gives a variation its listing\'s note', () => {
    const label = returnPolicyLabelFor(
      { returnable: null, nonReturnableNote: null },
      { returnable: false, nonReturnableNote: BESPOKE },
    )
    expect(label).toBe(BESPOKE)
  })

  it('lets a variation carry its own answer and wording', () => {
    const label = returnPolicyLabelFor(
      { returnable: false, nonReturnableNote: PAINTED },
      { returnable: null, nonReturnableNote: null },
    )
    expect(label).toBe(PAINTED)
  })

  it('lets one returnable variation out of a bespoke listing', () => {
    const label = returnPolicyLabelFor(
      { returnable: true, nonReturnableNote: null },
      { returnable: false, nonReturnableNote: BESPOKE },
    )
    expect(label).toBeUndefined()
  })

  it('falls back to the shop\'s stock sentence rather than no label', () => {
    const label = returnPolicyLabelFor(
      { returnable: null, nonReturnableNote: null },
      { returnable: false, nonReturnableNote: null },
    )
    expect(label).toBe(NON_RETURNABLE_DEFAULT_NOTE)
  })

  it('a bespoke variation with no wording of its own takes the listing\'s', () => {
    const label = returnPolicyLabelFor(
      { returnable: false, nonReturnableNote: null },
      { returnable: false, nonReturnableNote: BESPOKE },
    )
    expect(label).toBe(BESPOKE)
  })

  it('keeps an over-long note inside Google\'s 100 characters', () => {
    const long = `${'Made to order in the size, shape, finish, fabric and edge detail you choose'.repeat(2)}, so we cannot take it back.`
    const label = returnPolicyLabelFor(
      { returnable: null, nonReturnableNote: null },
      { returnable: false, nonReturnableNote: long },
    )
    expect(label).toBeDefined()
    expect(label!.length).toBeLessThanOrEqual(100)
  })

  it('a standalone product answers for itself', () => {
    expect(returnPolicyLabelFor({ returnable: false, nonReturnableNote: PAINTED }, undefined)).toBe(PAINTED)
    expect(returnPolicyLabelFor({ returnable: null, nonReturnableNote: null }, undefined)).toBeUndefined()
  })
})
