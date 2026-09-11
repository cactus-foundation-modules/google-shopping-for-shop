import { describe, it, expect } from 'vitest'
import { variationImageLinks, variantImageKeySet } from '@/modules/google-shopping-for-shop/lib/variation-images'

const OAK = 'https://cdn/desk-oak.webp'
const BLACK = 'https://cdn/desk-black.webp'
const WALNUT = 'https://cdn/desk-walnut.webp'
const ROOM = 'https://cdn/desk-room.webp'
const DIMENSIONS = 'https://cdn/desk-dimensions.webp'

const allVariants = [{ imageUrls: [OAK] }, { imageUrls: [BLACK] }, { imageUrls: [WALNUT] }]

describe('variationImageLinks', () => {
  it('sends the variation its own pictures alone while the setting is off', () => {
    expect(variationImageLinks({
      ownImages: [BLACK],
      parentImages: [OAK, ROOM],
      allVariantImages: variantImageKeySet(allVariants),
      includeParentImages: false,
    })).toEqual([BLACK])
  })

  it('falls back to the listing while the setting is off and the variation has no pictures', () => {
    expect(variationImageLinks({
      ownImages: [],
      parentImages: [OAK, ROOM],
      allVariantImages: variantImageKeySet(allVariants),
      includeParentImages: false,
    })).toEqual([OAK, ROOM])
  })

  it('puts the listing pictures behind the variation, other variations left out', () => {
    expect(variationImageLinks({
      ownImages: [BLACK],
      // A gallery led by the oak photograph, as plenty of listings are.
      parentImages: [OAK, ROOM, DIMENSIONS],
      allVariantImages: variantImageKeySet(allVariants),
      includeParentImages: true,
    })).toEqual([BLACK, ROOM, DIMENSIONS])
  })

  it('keeps a listing picture that is this variation\'s own, and only once', () => {
    expect(variationImageLinks({
      ownImages: [OAK],
      parentImages: [OAK, ROOM],
      allVariantImages: variantImageKeySet(allVariants),
      includeParentImages: true,
    })).toEqual([OAK, ROOM])
  })

  it('matches the same file across a cache-busting parameter', () => {
    expect(variationImageLinks({
      ownImages: [BLACK],
      parentImages: [`${OAK}?v=2`, ROOM],
      allVariantImages: variantImageKeySet(allVariants),
      includeParentImages: true,
    })).toEqual([BLACK, ROOM])
  })

  it('never leaves an item with no picture at all', () => {
    // Every one of the listing's pictures is a sibling's and this variation
    // brought none: better the old behaviour than an item Google refuses.
    expect(variationImageLinks({
      ownImages: [],
      parentImages: [OAK, WALNUT],
      allVariantImages: variantImageKeySet(allVariants),
      includeParentImages: true,
    })).toEqual([OAK, WALNUT])
  })

  it('keeps a variation with no pictures of its own on the shared ones', () => {
    expect(variationImageLinks({
      ownImages: [],
      parentImages: [OAK, ROOM],
      allVariantImages: variantImageKeySet(allVariants),
      includeParentImages: true,
    })).toEqual([ROOM])
  })
})
