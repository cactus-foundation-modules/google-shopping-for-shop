// What the Reports tab shows about the money.
//
// One panel, beside the two that are already there, and deliberately a third
// thing rather than a column added to either of them:
//
//   Google's figures (stage 4)  Merchant Center's count of free and paid
//                               clicks. No money in it at all.
//   This site's figures (5)     landings and attributed sales that this site
//                               saw for itself.
//   This panel                  what Google Ads charged, and what that came to
//                               per sale this site can point at.
//
// NO PROFIT AND NO MARGIN. That was the owner's decision on the plan and it is
// not a gap to be filled in later: the module knows what a product sold for and
// has no business guessing what it cost to buy, and a "profit" figure built on
// a guess is worse than no figure.
//
// The one honest wrinkle, said on screen rather than buried here: the spend is
// dated in the GOOGLE ADS ACCOUNT'S timezone, which Google chooses, and the
// sales are dated in this site's own. Over a range of any length the difference
// is one evening at each end. Over "today" it can be most of the figure, which
// is why the panel says which is which rather than presenting one number.
import { calendarDateIn, instantAtWallClock } from '@/lib/config/timezone'
import { getSiteTimezone } from '@/lib/config/timezone.server'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { hasGoogleAdsCredentials } from '@/modules/google-shopping-for-shop/lib/google-ads/credentials'
import {
  readAdsRun,
  readAdsSpendByItem,
  readAdsSpendExtent,
  readAdsSpendTotals,
  readAdsSpendTrend,
  readAttributedPaidSales,
  type AdsSpendDay,
  type AdsSpendItem,
  type AdsSpendTotals,
} from '@/modules/google-shopping-for-shop/lib/google-ads/store'
import { costPerSale } from '@/modules/google-shopping-for-shop/lib/google-ads/types'
import { addDays } from '@/modules/google-shopping-for-shop/lib/performance/days'
import { resolveRange, type ResolvedRange } from '@/modules/google-shopping-for-shop/lib/performance/range'

/** Items in the per-product table. One page, no paging: this is the "where is
 *  the money going" list, and past the top few dozen it stops answering that. */
export const ADS_ITEM_LIMIT = 25

export type AdsReport = {
  range: ResolvedRange
  /** This site's today, in its own timezone. */
  today: string
  /** The Google Ads account's timezone, as Google reported it. Null where it
   *  has never been asked, in which case the screen says the dates may not
   *  line up rather than implying they do. */
  accountTimeZone: string | null
  spend: AdsSpendTotals
  /** What the SPEND is denominated in, as Google reported it. Null where Google
   *  has never been asked or never said - in which case the screen says the
   *  currency is not known rather than putting a pound sign on somebody's
   *  euros. Deliberately NOT defaulted to the shop's own. */
  spendCurrency: string | null
  trend: AdsSpendDay[]
  items: { rows: AdsSpendItem[]; total: number; shown: number }
  /** This site's OWN attributed sales from paid clicks over the same range.
   *  Not Google Ads' conversion count - see the note in store.ts. The currency
   *  is the SHOP'S, which is a different question from what the ads are billed
   *  in and is always known. */
  attributed: { orders: number; revenue: number; currency: string }
  /** Spend divided by those sales. Null where there were none, because a cost
   *  per sale with no sales is not zero. */
  costPerSale: number | null
  state: {
    checkedAt: string | null
    failedAt: string | null
    lastError: string | null
    importedThrough: string | null
    heldFrom: string | null
    heldTo: string | null
    rowsHeld: number
  }
  settings: {
    adsEnabled: boolean
    spendImportEnabled: boolean
    uploadEnabled: boolean
    backfillDays: number
    retentionDays: number
  }
  /** Whether a fetch could even be attempted, and what is missing if not. */
  can: { fetch: boolean; credentials: boolean; enabled: boolean }
}

export type AdsReportQuery = { range: string; from?: string; to?: string }

export async function readAdsReport(query: AdsReportQuery, now: Date = new Date()): Promise<AdsReport> {
  const [settings, timezone, shop] = await Promise.all([getGsfSettings(), getSiteTimezone(), getShopConfigCached()])
  const today = calendarDateIn(now, timezone)
  const extent = await readAdsSpendExtent()

  const range = resolveRange({
    today,
    range: query.range,
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
    ...(extent.from ? { earliest: extent.from } : {}),
  })

  // The site's own reading of the same dates, as two instants, so the sales
  // count uses the shop's day rather than the server's. Half-open: a sale at
  // 23:59:59.999 on the last day is inside it.
  const start = instantAtWallClock(range.from, '00:00', timezone)
  const end = instantAtWallClock(addDays(range.to, 1), '00:00', timezone)

  const [spend, trend, items, attributed, run] = await Promise.all([
    readAdsSpendTotals(range.from, range.to),
    readAdsSpendTrend(range.from, range.to),
    readAdsSpendByItem({ from: range.from, to: range.to, limit: ADS_ITEM_LIMIT, offset: 0 }),
    readAttributedPaidSales(start, end),
    readAdsRun(),
  ])

  // Two currencies, kept apart because they are two different things: the
  // sales are in the shop's own, the spend is in whatever the Google Ads
  // account bills in. Usually identical, and a shop advertising in euros is
  // not.
  //
  // The SPEND one is allowed to be null. Everything else in this stage refuses
  // to guess, and putting a pound sign in front of a figure Google has not said
  // the currency of would be the one place it did - on the two numbers most
  // likely to be read as money and acted on.
  const spendCurrency = spend.currency ?? settings.adsCurrency

  return {
    range,
    today,
    accountTimeZone: settings.adsTimeZone,
    spend,
    trend,
    items: { rows: items.rows, total: items.total, shown: items.rows.length },
    attributed: { ...attributed, currency: shop.currency },
    spendCurrency,
    costPerSale: costPerSale(spend.cost, attributed.orders),
    state: {
      checkedAt: run.spendCheckedAt?.toISOString() ?? null,
      failedAt: run.spendFailedAt?.toISOString() ?? null,
      lastError: run.spendLastError,
      importedThrough: run.spendImportedThrough,
      heldFrom: extent.from,
      heldTo: extent.to,
      rowsHeld: extent.rows,
    },
    settings: {
      adsEnabled: settings.adsEnabled,
      spendImportEnabled: settings.adsSpendImportEnabled,
      uploadEnabled: settings.adsConversionUploadEnabled,
      backfillDays: settings.adsSpendBackfillDays,
      retentionDays: settings.adsSpendRetentionDays,
    },
    can: {
      fetch: settings.adsEnabled && hasGoogleAdsCredentials(),
      credentials: hasGoogleAdsCredentials(),
      enabled: settings.adsEnabled,
    },
  }
}
