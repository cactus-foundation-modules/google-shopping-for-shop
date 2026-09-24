import { describe, it, expect } from 'vitest'
import { PRODUCT_PATH_PATTERN, beaconScript } from '@/modules/google-shopping-for-shop/lib/click-tracking/beacon-script'

describe('beaconScript', () => {
  const script = beaconScript('ROOT')

  it('cannot break out of the script tag it is written into', () => {
    // It goes onto the page through dangerouslySetInnerHTML, so a closing tag
    // anywhere in it would end the script and spill the rest into the document.
    expect(script.toLowerCase()).not.toContain('</script')
    expect(script).not.toContain('<!--')
  })

  it('is the same string every time, so a shared cached page is safe to serve', () => {
    expect(beaconScript('ROOT')).toBe(script)
  })

  it('carries the shop own product path shape, and speaks up on nothing else', () => {
    // Asserted against the exported constant rather than against a copy of the
    // pattern typed out here: a literal would let the two drift, and the way it
    // would drift is the beacon quietly going silent on every product page.
    expect(script).toContain(PRODUCT_PATH_PATTERN.ROOT)
    expect(beaconScript('SHOP')).toContain(PRODUCT_PATH_PATTERN.SHOP)
    // And the two really are different, so the assertion above cannot pass by
    // both being the same string.
    expect(PRODUCT_PATH_PATTERN.ROOT).not.toBe(PRODUCT_PATH_PATTERN.SHOP)
    expect(script).not.toContain(PRODUCT_PATH_PATTERN.SHOP)
  })

  it('tests the address BEFORE truncating it', () => {
    // Google appends its parameters at the end, so truncating first would cut
    // off the very thing being looked for on exactly the listings with the
    // longest option queries.
    const tagTest = script.indexOf('utm_campaign=shopping')
    const truncate = script.indexOf('q.slice(0,1000)')
    expect(truncate).toBeGreaterThan(-1)
    expect(tagTest).toBeLessThan(truncate)
  })

  it('posts to this module own public routes and nowhere else', () => {
    expect(script).toContain('/api/m/google-shopping-for-shop/public')
    expect(script).toContain("'/landing'")
    expect(script).toContain("'/conversion'")
    expect(script).not.toMatch(/https?:\/\//)
  })

  it('reports only the address, never a product id', () => {
    expect(script).toContain('window.location.pathname')
    expect(script).not.toContain('productId')
  })

  it('never touches a cookie', () => {
    expect(script).not.toContain('document.cookie')
  })

  it('listens for the conversion event and replays what was announced first', () => {
    expect(script).toContain("'cactus:conversion'")
    expect(script).toContain('__cactusConversions')
  })

  it('waits for load rather than blocking the paint', () => {
    expect(script).toContain("addEventListener('load'")
    expect(script).toContain('setTimeout')
  })

  it('says so when consent is withdrawn, rather than waiting for a return visit', () => {
    // Core deletes nothing of ours and a withdrawing visitor may never come
    // back from Google, so this event is the only reliable moment there is.
    expect(script).toContain("'cactus:consent-change'")
    expect(script).toContain("'/forget'")
    // A change that still grants marketing is not a withdrawal.
    expect(script).toContain('d.marketing===true')
  })

  it('swallows its own failures', () => {
    expect(script.startsWith('(function(){try{')).toBe(true)
    expect(script.endsWith('}catch(e){}})();')).toBe(true)
  })
})
