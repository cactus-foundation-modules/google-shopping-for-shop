import { createSign } from 'crypto'
import { readFileSync } from 'fs'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'

type ServiceAccount = {
  client_email: string
  private_key: string
  token_uri?: string
}

type Money = {
  amountMicros?: string
  currencyCode?: string
}

type ProductViewResult = {
  productView?: {
    id?: string
    offerId?: string
    title?: string
  }
}

type PriceCompetitivenessResult = {
  priceCompetitivenessProductView?: {
    id?: string
    offerId?: string
    title?: string
    benchmarkPrice?: Money
  }
}

type ReportResponse<T> = {
  results?: T[]
  nextPageToken?: string
}

export type MatchRefreshResult = {
  checkedAt: Date
  products: number
  matched: number
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function parseCredentials(raw: string): ServiceAccount | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceAccount>
    if (typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') return null
    return { client_email: parsed.client_email, private_key: parsed.private_key, token_uri: parsed.token_uri }
  } catch {
    return null
  }
}

function credentialsFromEnv(): ServiceAccount | null {
  const inline = process.env.GOOGLE_SHOPPING_SERVICE_ACCOUNT_JSON ?? process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (inline) return parseCredentials(inline)

  const file = process.env.GOOGLE_SHOPPING_SERVICE_ACCOUNT_FILE ?? process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (!file) return null
  try {
    return parseCredentials(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function canRefreshMerchantMatchStatus(): boolean {
  return credentialsFromEnv() !== null
}

async function accessToken(account: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const tokenUri = account.token_uri ?? 'https://oauth2.googleapis.com/token'
  const unsigned = `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64Url(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/content',
    aud: tokenUri,
    exp: now + 3600,
    iat: now,
  }))}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key)
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${unsigned}.${base64Url(signature)}`,
  })
  const response = await fetch(tokenUri, { method: 'POST', body })
  const json = await response.json() as { access_token?: string; error_description?: string }
  if (!response.ok || !json.access_token) throw new Error(json.error_description ?? 'Merchant API authentication failed')
  return json.access_token
}

async function reportSearch<T>(merchantId: string, token: string, query: string): Promise<T[]> {
  const rows: T[] = []
  let pageToken: string | undefined
  do {
    const response = await fetch(`https://merchantapi.googleapis.com/reports/v1/accounts/${merchantId}/reports:search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, pageSize: 1000, pageToken }),
    })
    const json = await response.json() as ReportResponse<T> & { error?: { message?: string } }
    if (!response.ok) throw new Error(json.error?.message ?? 'Merchant report failed')
    rows.push(...(json.results ?? []))
    pageToken = json.nextPageToken
  } while (pageToken)
  return rows
}

function micros(value: string | undefined): bigint | null {
  if (!value || !/^-?\d+$/.test(value)) return null
  return BigInt(value)
}

export async function refreshMerchantMatchStatus(): Promise<MatchRefreshResult> {
  const [settings, credentials] = await Promise.all([getGsfSettings(), Promise.resolve(credentialsFromEnv())])
  if (!settings.merchantId) throw new Error('Merchant Center account number is not set')
  if (!credentials) throw new Error('Merchant API credentials are not configured')

  const token = await accessToken(credentials)
  const [productRows, competitivenessRows] = await Promise.all([
    reportSearch<ProductViewResult>(
      settings.merchantId,
      token,
      'SELECT product_view.id, product_view.offer_id, product_view.title FROM product_view',
    ),
    reportSearch<PriceCompetitivenessResult>(
      settings.merchantId,
      token,
      'SELECT price_competitiveness_product_view.report_country_code, price_competitiveness_product_view.id, price_competitiveness_product_view.offer_id, price_competitiveness_product_view.title, price_competitiveness_product_view.benchmark_price FROM price_competitiveness_product_view',
    ),
  ])

  const benchmarkByOffer = new Map<string, { title: string | null; amount: bigint | null; currency: string | null }>()
  for (const row of competitivenessRows) {
    const view = row.priceCompetitivenessProductView
    const offerId = view?.offerId?.trim()
    if (!offerId) continue
    benchmarkByOffer.set(offerId, {
      title: view?.title?.trim() || null,
      amount: micros(view?.benchmarkPrice?.amountMicros),
      currency: view?.benchmarkPrice?.currencyCode?.trim() || null,
    })
  }

  const checkedAt = new Date()
  const values: Prisma.Sql[] = []
  for (const row of productRows) {
    const view = row.productView
    const offerId = view?.offerId?.trim()
    if (!offerId) continue
    const benchmark = benchmarkByOffer.get(offerId)
    // Casts because a VALUES list inside a CTE has no target column to borrow
    // its types from.
    values.push(Prisma.sql`(
      ${offerId}::text,
      ${benchmark !== undefined}::boolean,
      ${benchmark?.title ?? view?.title?.trim() ?? null}::text,
      ${benchmark?.amount ?? null}::bigint,
      ${benchmark?.currency ?? null}::text,
      ${checkedAt}::timestamp(3)
    )`)
  }

  // One statement per batch: the history insert reads the snapshot as it stood
  // before the upsert (data-modifying CTEs share one snapshot), so it logs an
  // item exactly when its match state or the title Google holds has changed.
  // Benchmark prices drift daily and are carried along, never a trigger.
  for (let i = 0; i < values.length; i += 500) {
    await prisma.$executeRaw`
      WITH "incoming" ("item_id", "matched", "merchant_title", "benchmark_amount_micros", "benchmark_currency", "checked_at") AS (
        VALUES ${Prisma.join(values.slice(i, i + 500))}
      ),
      "logged" AS (
        INSERT INTO "gsf_item_match_history"
          ("item_id", "matched", "merchant_title", "benchmark_amount_micros", "benchmark_currency", "recorded_at")
        SELECT n."item_id", n."matched", n."merchant_title", n."benchmark_amount_micros", n."benchmark_currency", n."checked_at"
        FROM "incoming" n
        LEFT JOIN "gsf_item_match_status" s ON s."item_id" = n."item_id"
        WHERE s."item_id" IS NULL
           OR s."matched" IS DISTINCT FROM n."matched"
           OR s."merchant_title" IS DISTINCT FROM n."merchant_title"
      )
      INSERT INTO "gsf_item_match_status"
        ("item_id", "matched", "merchant_title", "benchmark_amount_micros", "benchmark_currency", "checked_at")
      SELECT "item_id", "matched", "merchant_title", "benchmark_amount_micros", "benchmark_currency", "checked_at"
      FROM "incoming"
      ON CONFLICT ("item_id") DO UPDATE SET
        "matched" = EXCLUDED."matched",
        "merchant_title" = EXCLUDED."merchant_title",
        "benchmark_amount_micros" = EXCLUDED."benchmark_amount_micros",
        "benchmark_currency" = EXCLUDED."benchmark_currency",
        "checked_at" = EXCLUDED."checked_at"
    `
  }

  return { checkedAt, products: values.length, matched: benchmarkByOffer.size }
}
