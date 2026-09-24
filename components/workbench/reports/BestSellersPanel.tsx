'use client'

// What Google says is selling, and whether this shop sells it.
//
// The honest version of that second half is more complicated than it sounds,
// and the screen says so. GOOGLE'S BEST SELLERS REPORT CARRIES NO OFFER IDS -
// it ranks product clusters, which are a grouping across every retailer, so
// there is nothing in it to join to the feed on. Two things answer instead:
// Google's own "is this in your product data source" flag, and a match of its
// example barcodes against the shop's own. Each row says which of them
// answered, and a row neither could answer reads "not known" rather than being
// rounded down to a no.
import { formatDateTime } from '@/modules/google-shopping-for-shop/components/workbench/format'
import {
  CHANGE_LABELS,
  DEMAND_LABELS,
  GRANULARITY_LABELS,
  VERDICT_LABELS,
  type CatalogueVerdict,
} from '@/modules/google-shopping-for-shop/lib/best-sellers/types'
import type { PerformanceReport } from '@/modules/google-shopping-for-shop/lib/performance/report'
import type { BestSellerRowView } from '@/modules/google-shopping-for-shop/lib/best-sellers/store'

const VERDICT_TONE: Record<CatalogueVerdict, string> = {
  matched: 'badge-success',
  google: 'badge-info',
  no: 'badge-warning',
  unknown: 'badge-default',
}

function movement(row: BestSellerRowView): string | null {
  if (row.previousRank === null) return 'new to the list'
  const change = row.previousRank - row.rank
  if (change === 0) return 'no change'
  return change > 0 ? `up ${change}` : `down ${-change}`
}

function SellerRow({ row }: { row: BestSellerRowView }) {
  const name = row.kind === 'brand' ? row.brand ?? 'Unnamed brand' : row.title ?? row.brand ?? 'Unnamed product'
  return (
    <li className="gsr-seller">
      <span className="gsr-seller-rank">#{row.rank}</span>
      <span className="gsr-seller-name">
        {name}
        {row.kind === 'cluster' && row.brand && <span className="gsr-seller-meta"> · {row.brand}</span>}
        {row.categoryPath && <span className="gsr-seller-meta"> · {row.categoryPath}</span>}
      </span>
      <span className={`badge ${VERDICT_TONE[row.verdict]}`}>{VERDICT_LABELS[row.verdict]}</span>
      <span className="gsr-seller-meta">
        Demand {DEMAND_LABELS[row.relativeDemand].toLowerCase()} · {CHANGE_LABELS[row.demandChange].toLowerCase()}
        {movement(row) && <> · {movement(row)}</>}
      </span>
    </li>
  )
}

export function BestSellersPanel({ bestSellers }: { bestSellers: PerformanceReport['bestSellers'] }) {
  if (!bestSellers.enabled) {
    return (
      <section className="gsr-panel" aria-label="Best sellers">
        <h3 className="gsr-panel-title">What is selling</h3>
        <p className="gsr-panel-note">
          Google can also tell you what is selling best in your categories, whether or not you stock it. It is switched off
          because it is a separate daily request and not every Merchant Center account has the report. Turn it on at the bottom
          of this page.
        </p>
      </section>
    )
  }

  const nothing = bestSellers.clusters.length === 0 && bestSellers.brands.length === 0

  return (
    <section className="gsr-panel" aria-label="Best sellers">
      <h3 className="gsr-panel-title">What is selling</h3>
      <p className="gsr-panel-note">
        Google&apos;s own ranking for the categories you trade in, {GRANULARITY_LABELS[bestSellers.granularity].toLowerCase()}.
        Google ranks products as it groups them across every shop, so there is no item number to match on: &ldquo;you sell
        this&rdquo; means one of its example barcodes is in your catalogue, and &ldquo;Google says you list this&rdquo; means
        Google found it in your feed but we could not match a barcode.
      </p>

      {nothing ? (
        <div className="gsr-empty">
          {/* Three different empty states, and telling them apart is the whole
              point. Rankings held under another setting is BY FAR the most
              likely of the three - an owner changes weekly to monthly and
              every row goes out of view at once - and calling that "Google has
              nothing for you" would have them switch the feature off while
              their rankings sit in the table one setting away. */}
          {bestSellers.heldElsewhere > 0 ? (
            <>
              <strong>Nothing under these settings yet</strong>
              You have rankings saved under different settings - another timeframe, country or category. They are kept, not
              thrown away, and putting the old setting back shows them again. Otherwise the first{' '}
              {GRANULARITY_LABELS[bestSellers.granularity].toLowerCase()} one arrives on the next daily check, or press
              &ldquo;Fetch now&rdquo; at the top to ask straight away.
            </>
          ) : bestSellers.checkedAt ? (
            <>
              <strong>Nothing brought in yet</strong>
              Google was asked but gave no rankings for these categories. Not every account has this report, and a category
              Google does not rank returns nothing at all.
            </>
          ) : (
            <>
              <strong>Nothing brought in yet</strong>
              Press &ldquo;Fetch now&rdquo; at the top, or wait for the daily check.
            </>
          )}
        </div>
      ) : (
        <>
          {bestSellers.truncated > 0 && (
            <p className="gsr-panel-note">
              Showing the top {bestSellers.perCategory} in each category
              {bestSellers.perCategoryCapped && <> - the most this screen draws, whatever you set</>}. Google gave{' '}
              {bestSellers.truncated} more, which are held but not drawn here.
            </p>
          )}
          {bestSellers.reportDate && (
            <p className="gsw-small gsw-muted">
              Ranking for the period starting <strong>{bestSellers.reportDate}</strong>
              {bestSellers.checkedAt && <> · fetched {formatDateTime(bestSellers.checkedAt)}</>}
            </p>
          )}
          {bestSellers.clusters.length > 0 && (
            <>
              <h4 className="gsr-panel-title">Products</h4>
              <ul className="gsr-sellers">
                {bestSellers.clusters.map((row) => (
                  <SellerRow key={`${row.categoryId}-${row.reportDate}-${row.rank}`} row={row} />
                ))}
              </ul>
            </>
          )}
          {bestSellers.brands.length > 0 && (
            <>
              <h4 className="gsr-panel-title">Brands</h4>
              <ul className="gsr-sellers">
                {bestSellers.brands.map((row) => (
                  <SellerRow key={`${row.categoryId}-${row.reportDate}-${row.rank}`} row={row} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  )
}
