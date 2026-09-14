import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { FeedOptionPair } from '@/modules/google-shopping-for-shop/lib/feed-xml'

export type TitleTemplateContextInput = {
  originalTitle: string
  parentTitle: string
  variantLabel?: string | null
  sku?: string | null
  mpn?: string | null
  gtin?: string | null
  brand?: string | null
  options?: FeedOptionPair[]
}

export type RenderedTitleTemplate = {
  title: string
  usedTokens: string[]
  unknownTokens: string[]
}

const TOKEN_RE = /<([A-Za-z0-9 _-]+)>/g

export function normaliseTitleToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function cleanTitle(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.)])/g, '$1')
    .replace(/([(])\s+/g, '$1')
    .replace(/\s+([/-])\s+/g, ' $1 ')
    .replace(/\s+,\s+/g, ', ')
    .trim()
}

function put(map: Record<string, string>, key: string, value: string | null | undefined) {
  const k = normaliseTitleToken(key)
  const v = value?.trim()
  if (k && v && map[k] === undefined) map[k] = v
}

export function buildTitleTemplateContext(input: TitleTemplateContextInput): Record<string, string> {
  const ctx: Record<string, string> = {}
  put(ctx, 'original_title', input.originalTitle)
  put(ctx, 'title', input.originalTitle)
  put(ctx, 'parent_title', input.parentTitle)
  put(ctx, 'parent_product_title', input.parentTitle)
  put(ctx, 'variant_label', input.variantLabel)
  put(ctx, 'options', input.options?.map((o) => o.value.trim()).filter(Boolean).join(' / '))
  put(ctx, 'sku', input.sku)
  put(ctx, 'mpn', input.mpn)
  put(ctx, 'gtin', input.gtin)
  put(ctx, 'brand', input.brand)

  for (const option of input.options ?? []) {
    put(ctx, option.name, option.value)
    const name = option.name.toLowerCase()
    if (/colou?r|fabric|upholstery/.test(name)) {
      put(ctx, 'colour', option.value)
      put(ctx, 'color', option.value)
    } else if (/\b(width|height|depth|length|size|seat)\b/.test(name)) {
      put(ctx, normaliseTitleToken(option.name).includes('seat') ? 'seats' : 'size', option.value)
    } else if (/material|finish|frame|wood|top/.test(name)) {
      put(ctx, 'material', option.value)
    } else if (/pattern|grain/.test(name)) {
      put(ctx, 'pattern', option.value)
    }
  }

  return ctx
}

export function renderTitleTemplate(template: string | null | undefined, context: Record<string, string>, fallback: string): RenderedTitleTemplate {
  const trimmed = template?.trim()
  if (!trimmed) return { title: cleanTitle(fallback), usedTokens: [], unknownTokens: [] }

  const used = new Set<string>()
  const unknown = new Set<string>()
  const rendered = trimmed.replace(TOKEN_RE, (match, raw: string) => {
    const key = normaliseTitleToken(raw)
    if (!key) return ''
    used.add(key)
    const value = context[key]
    if (value === undefined) {
      unknown.add(match)
      return ''
    }
    return value
  })
  const title = cleanTitle(rendered) || cleanTitle(fallback)
  return { title, usedTokens: [...used], unknownTokens: [...unknown] }
}

export async function getTitleTemplatesForItems(itemIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(itemIds)].filter(Boolean)
  const map = new Map<string, string>()
  if (ids.length === 0) return map
  const rows = await prisma.$queryRaw<Array<{ item_id: string; title_template: string }>>`
    SELECT "item_id", "title_template"
    FROM "gsf_title_templates"
    WHERE "item_id" IN (${Prisma.join(ids)})
  `
  for (const row of rows) map.set(row.item_id, row.title_template)
  return map
}

export async function upsertTitleTemplates(updates: Array<{ itemId: string; titleTemplate: string | null }>): Promise<void> {
  const unique = new Map<string, string | null>()
  for (const update of updates) unique.set(update.itemId, update.titleTemplate?.trim() || null)
  if (unique.size === 0) return

  const deletes = [...unique.entries()].filter(([, title]) => title == null).map(([id]) => id)
  if (deletes.length > 0) {
    await prisma.$executeRaw`
      DELETE FROM "gsf_title_templates"
      WHERE "item_id" IN (${Prisma.join(deletes)})
    `
  }

  const writes = [...unique.entries()].filter((entry): entry is [string, string] => entry[1] != null)
  if (writes.length === 0) return
  const values = writes.map(([id, title]) => Prisma.sql`(${id}, ${title})`)
  await prisma.$executeRaw`
    INSERT INTO "gsf_title_templates" ("item_id", "title_template")
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("item_id") DO UPDATE SET
      "title_template" = EXCLUDED."title_template",
      "updated_at" = CURRENT_TIMESTAMP
  `
}
