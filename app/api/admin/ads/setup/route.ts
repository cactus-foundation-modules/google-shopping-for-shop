// POST /api/m/google-shopping-for-shop/admin/ads/setup
//
// Two jobs behind one button each, both of which ring Google - so both are a
// POST on a press and neither is on a timer or a page load.
//
//   { job: 'check' }    asks Google what this connection can do, and changes
//                       nothing at all.
//   { job: 'connect' }  finds or makes the conversion action this site's sales
//                       are reported against, and makes sure Google has it
//                       marked SECONDARY. This one writes to the account.
//
// `shop.manage` on both: the first reads somebody's advertising account and the
// second writes to it.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { isAdmin } from '@/lib/permissions/check'
import { getGsfSettings, recordAdsConversionAction } from '@/modules/google-shopping-for-shop/lib/settings'
import { googleAdsCredentialsFromEnv } from '@/modules/google-shopping-for-shop/lib/google-ads/credentials'
import { checkGoogleAdsAccess } from '@/modules/google-shopping-for-shop/lib/google-ads/access-check'
import { ensureConversionAction, readConversionAction } from '@/modules/google-shopping-for-shop/lib/google-ads/conversion-action'
import { readAdsView } from '@/modules/google-shopping-for-shop/lib/google-ads/view'
import { recordChange } from '@/modules/google-shopping-for-shop/lib/change-log'
import { changedBy } from '@/modules/google-shopping-for-shop/lib/workbench-actor'

const Body = z.object({ job: z.enum(['check', 'connect']) })

export async function POST(request: NextRequest) {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Nothing to do.' }, { status: 400 })

  const settings = await getGsfSettings()

  if (parsed.data.job === 'check') {
    try {
      const access = await checkGoogleAdsAccess({ conversionAction: settings.adsConversionAction })

      // A check that asked Google about the tracker RECORDS what it was told.
      // Without this, pressing the button could show "Google says it is
      // primary" on screen while the stored answer - the one the send reads -
      // stayed at whatever it was on the day it was set up. The send re-reads
      // for itself too, so this is belt and braces rather than the safeguard;
      // it is here so the panel and the sending can never disagree.
      //
      // Its own try: a settings write that fails must not lose the answer the
      // owner is waiting to see.
      const credentials = googleAdsCredentialsFromEnv()
      if (credentials && settings.adsConversionAction) {
        try {
          const action = await readConversionAction(credentials.customerId, settings.adsConversionAction)
          await recordAdsConversionAction({
            resourceName: action?.resourceName ?? null,
            name: action?.name ?? null,
            primary: action?.primaryForGoal ?? null,
            checkedAt: new Date(),
          })
        } catch (error) {
          console.error('[google-shopping] could not refresh the Google Ads tracker state:', error)
        }
      }

      return NextResponse.json({ access }, { headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
      // Every expected failure is already a probe result; reaching here means
      // something unrelated broke, so say so without quoting internals at a
      // site owner.
      console.error('[google-shopping] Google Ads access check failed:', error)
      return NextResponse.json({ error: 'Could not check your Google Ads connection just now. Try again in a minute.' }, { status: 500 })
    }
  }

  const credentials = googleAdsCredentialsFromEnv()
  if (!credentials) {
    return NextResponse.json(
      { error: 'Google Ads is not connected yet. The Google Ads panel on the Health tab lists exactly which details are still needed, and takes them.' },
      { status: 400 },
    )
  }

  try {
    const outcome = await ensureConversionAction({
      customerId: credentials.customerId,
      current: settings.adsConversionAction,
    })

    // Recorded whichever way it went, because `primary` is what the upload
    // reads before it sends anything - and an unusable action recorded as
    // unusable is what stops it.
    await recordAdsConversionAction({
      resourceName: outcome.action.resourceName,
      name: outcome.action.name,
      primary: outcome.action.primaryForGoal,
      checkedAt: new Date(),
    })

    if (outcome.status === 'ready') {
      await recordChange({
        area: 'google-ads',
        action: 'link',
        summary: outcome.created
          ? `Made a sales tracker at Google Ads called "${outcome.action.name ?? 'Website sales'}", set to secondary.`
          : `Connected the Google Ads sales tracker "${outcome.action.name ?? 'Website sales'}"${outcome.madeSecondary ? ', and set it to secondary.' : '.'}`,
        before: null,
        after: { resourceName: outcome.action.resourceName, created: outcome.created, madeSecondary: outcome.madeSecondary },
        createdBy: changedBy(gate.user),
      }).catch((error) => console.error('[google-shopping] could not record the Google Ads setup:', error))
    }

    const ads = await readAdsView({ isAdmin: isAdmin(gate.user) })
    return NextResponse.json({ outcome, ads }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[google-shopping] Google Ads setup failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not set up the Google Ads sales tracker.' },
      { status: 502 },
    )
  }
}
