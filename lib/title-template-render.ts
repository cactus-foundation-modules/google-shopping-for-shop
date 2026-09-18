// Feed-only title templates: the pure half. Builds the token context an item's
// template is filled from and renders a template against it.
//
// Kept apart from lib/title-templates.ts (the database half) so the admin
// workbench can render a live preview in the browser with the very same code
// the feed runs - a preview that disagrees with the feed is worse than none.
// Nothing here may import a server-only module.
import type { FeedOptionPair } from '@/modules/google-shopping-for-shop/lib/feed-xml'

/** Google reads the first 150 characters of a title and drops the rest. */
export const GOOGLE_TITLE_MAX = 150

/** Roughly what a Shopping result shows before it trails off. Advice, not a rule. */
export const GOOGLE_TITLE_VISIBLE = 70

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

/** Token name (normalised, no angle brackets) to the value it renders as. */
export type TitleTemplateContext = Record<string, string>

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

function put(map: TitleTemplateContext, key: string, value: string | null | undefined) {
  const k = normaliseTitleToken(key)
  const v = value?.trim()
  if (k && v && map[k] === undefined) map[k] = v
}

export function buildTitleTemplateContext(input: TitleTemplateContextInput): TitleTemplateContext {
  const ctx: TitleTemplateContext = {}
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

export function renderTitleTemplate(template: string | null | undefined, context: TitleTemplateContext, fallback: string): RenderedTitleTemplate {
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
