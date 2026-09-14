import { describe, expect, it } from 'vitest'
import { buildTitleTemplateContext, normaliseTitleToken, renderTitleTemplate } from '@/modules/google-shopping-for-shop/lib/title-templates'

describe('Google Shopping title templates', () => {
  it('normalises token names the way an owner will type them', () => {
    expect(normaliseTitleToken('Frame Colour')).toBe('frame_colour')
    expect(normaliseTitleToken(' parent-title ')).toBe('parent_title')
  })

  it('renders built-in and option-name tokens into a Google-only title', () => {
    const context = buildTitleTemplateContext({
      originalTitle: 'ISO Stacking Visitor Meeting and Conference Chair - Blue / Chrome',
      parentTitle: 'ISO Stacking Visitor Meeting and Conference Chair',
      sku: 'BR000068',
      options: [
        { name: 'Upholstery Colour', value: 'Blue' },
        { name: 'Frame Colour', value: 'Chrome' },
      ],
    })

    const rendered = renderTitleTemplate(
      'ISO Stacking Chair <upholstery_colour> Fabric <frame_colour> Frame <sku>',
      context,
      context.original_title ?? '',
    )

    expect(rendered.title).toBe('ISO Stacking Chair Blue Fabric Chrome Frame BR000068')
    expect(rendered.unknownTokens).toEqual([])
  })

  it('falls back to the original title when a template renders blank', () => {
    const rendered = renderTitleTemplate('<not_a_token>', {}, 'Original Product Title')
    expect(rendered.title).toBe('Original Product Title')
    expect(rendered.unknownTokens).toEqual(['<not_a_token>'])
  })
})
