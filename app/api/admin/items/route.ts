// GET/PATCH /api/m/google-shopping-for-shop/admin/items
// Product workbench for Google Shopping feed-only titles and match snapshots.
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { getSiteUrlOrNull } from '@/lib/config/env'
import { requireShopUser } from '@/modules/shop/lib/access'
import { collectFeedItems } from '@/modules/google-shopping-for-shop/lib/feed-data'
import { canRefreshMerchantMatchStatus } from '@/modules/google-shopping-for-shop/lib/merchant-reports'
import { buildTitleTemplateContext, getTitleTemplatesForItems, renderTitleTemplate, upsertTitleTemplates } from '@/modules/google-shopping-for-shop/lib/title-templates'
import type { FeedItem, FeedOptionPair } from '@/modules/google-shopping-for-shop/lib/feed-xml'

type ProductRow = {
  id: string
  name: string
  slug: string
  sku: string | null
}

type StatusRow = {
  item_id: string
  matched: boolean
  merchant_title: string | null
  benchmark_amount_micros: string | null
  benchmark_currency: string | null
  checked_at: Date
}

type OptionRow = {
  item_id: string
  name: string
  value: string
}

const PatchBody = z.object({
  updates: z.array(z.object({
    itemId: z.string().min(1),
    titleTemplate: z.string().max(500).nullable(),
  })).min(1).max(500),
})

function clamp(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function searchable(...values: Array<string | null | undefined>): string {
  return values.map((v) => v?.toLowerCase() ?? '').join('\n')
}

function variantLabel(originalTitle: string, parentTitle: string): string {
  const prefix = `${parentTitle} - `
  return originalTitle.startsWith(prefix) ? originalTitle.slice(prefix.length) : ''
}

async function productRows(ids: string[]): Promise<Map<string, ProductRow>> {
  const unique = [...new Set(ids)].filter(Boolean)
  const map = new Map<string, ProductRow>()
  if (unique.length === 0) return map
  const rows = await prisma.$queryRaw<ProductRow[]>`
    SELECT "id", "name", "slug", "sku"
    FROM "shp_products"
    WHERE "id" IN (${Prisma.join(unique)})
  `
  for (const row of rows) map.set(row.id, row)
  return map
}

async function statusRows(ids: string[]): Promise<Map<string, StatusRow>> {
  const unique = [...new Set(ids)].filter(Boolean)
  const map = new Map<string, StatusRow>()
  if (unique.length === 0) return map
  const rows = await prisma.$queryRaw<StatusRow[]>`
    SELECT "item_id", "matched", "merchant_title", "benchmark_amount_micros"::text AS "benchmark_amount_micros",
           "benchmark_currency", "checked_at"
    FROM "gsf_item_match_status"
    WHERE "item_id" IN (${Prisma.join(unique)})
  `
  for (const row of rows) map.set(row.item_id, row)
  return map
}

async function optionsByItem(ids: string[]): Promise<Map<string, FeedOptionPair[]>> {
  const unique = [...new Set(ids)].filter(Boolean)
  const map = new Map<string, FeedOptionPair[]>()
  if (unique.length === 0) return map
  const rows = await prisma.$queryRaw<OptionRow[]>`
    SELECT v."child_product_id" AS "item_id", o."name", ov."label" AS "value"
    FROM "svr_variants" v
    JOIN "svr_variant_values" vv ON vv."variant_id" = v."id"
    JOIN "svr_option_values" ov ON ov."id" = vv."option_value_id"
    JOIN "svr_options" o ON o."id" = ov."option_id"
    WHERE v."child_product_id" IN (${Prisma.join(unique)})
    ORDER BY v."child_product_id", o."position" ASC, ov."position" ASC
  `
  for (const row of rows) {
    const options = map.get(row.item_id) ?? []
    options.push({ name: row.name, value: row.value })
    map.set(row.item_id, options)
  }
  return map
}

function matchState(status: StatusRow | undefined): 'matched' | 'unmatched' | 'unknown' {
  if (!status) return 'unknown'
  return status.matched ? 'matched' : 'unmatched'
}

function itemView(
  item: FeedItem,
  rows: Map<string, ProductRow>,
  options: Map<string, FeedOptionPair[]>,
  templates: Map<string, string>,
  statuses: Map<string, StatusRow>,
) {
  const product = rows.get(item.id)
  const parent = item.itemGroupId ? rows.get(item.itemGroupId) : product
  const originalTitle = product?.name ?? item.title
  const parentTitle = parent?.name ?? originalTitle
  const itemOptions = options.get(item.id) ?? []
  const context = buildTitleTemplateContext({
    originalTitle,
    parentTitle,
    variantLabel: variantLabel(originalTitle, parentTitle),
    sku: product?.sku,
    mpn: item.mpn,
    gtin: item.gtin,
    brand: item.brand,
    options: itemOptions,
  })
  const titleTemplate = templates.get(item.id) ?? null
  const rendered = renderTitleTemplate(titleTemplate, context, originalTitle)
  const status = statuses.get(item.id)
  return {
    id: item.id,
    itemGroupId: item.itemGroupId ?? null,
    parentTitle,
    originalTitle,
    renderedTitle: rendered.title,
    titleTemplate,
    unknownTokens: rendered.unknownTokens,
    availableTokens: Object.entries(context).map(([token, value]) => ({ token, value })),
    sku: product?.sku ?? '',
    mpn: item.mpn ?? '',
    gtin: item.gtin ?? '',
    brand: item.brand ?? '',
    productType: item.productType ?? '',
    googleProductCategory: item.googleProductCategory ?? '',
    price: `${item.salePrice ?? item.price} ${item.currency}`,
    imageUrl: item.imageLinks[0] ?? '',
    url: item.link,
    matched: matchState(status),
    merchantTitle: status?.merchant_title ?? '',
    benchmarkAmountMicros: status?.benchmark_amount_micros ?? '',
    benchmarkCurrency: status?.benchmark_currency ?? '',
    checkedAt: status?.checked_at.toISOString() ?? null,
  }
}

export async function GET(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const siteUrl = getSiteUrlOrNull()
  if (!siteUrl) return NextResponse.json({ error: 'Site URL is not configured' }, { status: 500 })

  const params = new URL(request.url).searchParams
  const page = clamp(params.get('page'), 1, 1, 10_000)
  const perPage = clamp(params.get('perPage'), 50, 10, 200)
  const q = params.get('q')?.trim().toLowerCase() ?? ''
  const match = params.get('match') ?? 'all'
  const override = params.get('override') ?? 'all'

  const { items } = await collectFeedItems(siteUrl)
  const ids = items.map((item) => item.id)
  const groupIds = items.map((item) => item.itemGroupId).filter((id): id is string => typeof id === 'string')
  const [rows, statuses, templates, options] = await Promise.all([
    productRows([...ids, ...groupIds]),
    statusRows(ids),
    getTitleTemplatesForItems(ids),
    optionsByItem(ids),
  ])
  const views = items.map((item) => itemView(item, rows, options, templates, statuses))
  const summary = {
    total: views.length,
    matched: views.filter((item) => item.matched === 'matched').length,
    unmatched: views.filter((item) => item.matched === 'unmatched').length,
    unknown: views.filter((item) => item.matched === 'unknown').length,
    overridden: views.filter((item) => item.titleTemplate !== null).length,
    lastCheckedAt: views.map((item) => item.checkedAt).filter((v): v is string => v !== null).sort().at(-1) ?? null,
    canRefresh: canRefreshMerchantMatchStatus(),
  }
  const filtered = views.filter((item) => {
    if (match !== 'all' && item.matched !== match) return false
    if (override === 'overridden' && item.titleTemplate === null) return false
    if (override === 'plain' && item.titleTemplate !== null) return false
    if (!q) return true
    return searchable(item.originalTitle, item.renderedTitle, item.parentTitle, item.sku, item.mpn, item.gtin, item.brand).includes(q)
  })
  const start = (page - 1) * perPage
  return NextResponse.json({
    items: filtered.slice(start, start + perPage),
    page,
    perPage,
    total: filtered.length,
    summary,
  })
}

export async function PATCH(request: NextRequest) {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error
  const parsed = PatchBody.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid title updates' }, { status: 400 })
  await upsertTitleTemplates(parsed.data.updates)
  return NextResponse.json({ ok: true })
}
