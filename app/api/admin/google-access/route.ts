// POST /api/m/google-shopping-for-shop/admin/google-access
//
// Asks Google what the saved service-account key is actually allowed to do, and
// answers in English. POST rather than GET because it makes three calls out to
// Google: it runs when the owner presses the button, not every time the
// settings tab is opened.
//
// Nothing here returns or logs a credential. The service-account email in the
// answer is an address the owner has to hand to Merchant Center anyway.
import { NextResponse } from 'next/server'
import { requireShopUser } from '@/modules/shop/lib/access'
import { checkGoogleAccess } from '@/modules/google-shopping-for-shop/lib/google/access-check'
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'

export async function POST() {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error
  try {
    const settings = await getGsfSettings()
    const report = await checkGoogleAccess(settings.merchantId)
    return NextResponse.json({ access: report }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    // Every expected failure is already a probe result; reaching here means
    // something unrelated broke, so say so without quoting internals at a site
    // owner.
    console.error('[google-shopping] access check failed:', error)
    return NextResponse.json({ error: 'Could not check your Google access just now. Try again in a minute.' }, { status: 500 })
  }
}
