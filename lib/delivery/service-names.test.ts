import { describe, it, expect } from 'vitest'
import { assignServiceNames, type ServiceNameRequest } from '@/modules/google-shopping-for-shop/lib/delivery/service-names'
import { MAX_SERVICE_NAME_LENGTH } from '@/modules/google-shopping-for-shop/lib/delivery/merchant-types'

function request(label: string, extra: Partial<ServiceNameRequest> = {}): ServiceNameRequest {
  return {
    key: `${label}\u0000${extra.handlingDays ?? 1}:${extra.transitDays ?? 5}`,
    label,
    handlingDays: 1,
    transitDays: 5,
    plain: true,
    ...extra,
  }
}

describe('assignServiceNames', () => {
  it('gives the plain-named speed the service name unchanged', () => {
    expect(assignServiceNames([request('Flat-Pack')])).toEqual(['Flat-Pack'])
  })

  it('names the other speeds by the time they take, from the numbers', () => {
    const names = assignServiceNames([
      request('Flat-Pack', { transitDays: 5, plain: true }),
      request('Flat-Pack', { transitDays: 14, plain: false }),
    ])
    expect(names).toEqual(['Flat-Pack', 'Flat-Pack - 14 days'])
  })

  it('says day rather than days for one', () => {
    const names = assignServiceNames([
      request('Next Day', { transitDays: 5, plain: true }),
      request('Next Day', { transitDays: 1, plain: false }),
    ])
    expect(names[1]).toBe('Next Day - 1 day')
  })

  // Two speeds that take the same time on the road and differ only in how long
  // they take to get out of the door. The transit figure alone cannot tell them
  // apart, so the sending time joins it rather than one of them losing out.
  it('adds the sending time where two speeds share a transit time', () => {
    const names = assignServiceNames([
      request('Installation', { handlingDays: 1, transitDays: 5, plain: true }),
      request('Installation', { handlingDays: 1, transitDays: 10, plain: false }),
      request('Installation', { handlingDays: 14, transitDays: 10, plain: false }),
    ])
    expect(names[0]).toBe('Installation')
    expect(names[1]).toBe('Installation - 10 days')
    expect(names[2]).toBe('Installation - 10 days, 14 to send')
    expect(new Set(names).size).toBe(3)
  })

  // Google's limit is 50 on a service NAME. The shop's longest is 34, so it is
  // the suffix that takes one over, not the name the owner typed.
  it('keeps every name inside Google\'s 50 characters', () => {
    const label = 'Made To Order and Delivered on Wooden Pallets'
    expect(label.length).toBeLessThan(MAX_SERVICE_NAME_LENGTH)
    expect(`${label} - 14 days`.length).toBeGreaterThan(MAX_SERVICE_NAME_LENGTH)

    const names = assignServiceNames([
      request(label, { transitDays: 5, plain: true }),
      request(label, { transitDays: 14, plain: false }),
    ])
    for (const name of names) {
      expect(name).not.toBeNull()
      expect((name ?? '').length).toBeLessThanOrEqual(MAX_SERVICE_NAME_LENGTH)
    }
    expect(names[0]).toBe(label)
    expect(names[1]).not.toBe(label)
  })

  // The failure this guards: two long names that begin the same way are the
  // same name once they have been cut to fit, and Merchant Center identifies a
  // service by its name alone.
  it('keeps two names that shorten to the same thing distinct', () => {
    const north = 'Made To Order and Delivered on Wooden Pallets Throughout the Northern Counties'
    const south = 'Made To Order and Delivered on Wooden Pallets Throughout the Southern Counties'
    expect(north.slice(0, MAX_SERVICE_NAME_LENGTH)).toBe(south.slice(0, MAX_SERVICE_NAME_LENGTH))

    const names = assignServiceNames([request(north), request(south)])
    expect(names[0]).not.toBe(names[1])
    for (const name of names) expect((name ?? '').length).toBeLessThanOrEqual(MAX_SERVICE_NAME_LENGTH)
  })

  it('gives the same answers twice in a row', () => {
    const requests = [
      request('Flat-Pack', { transitDays: 5, plain: true }),
      request('Flat-Pack', { transitDays: 14, plain: false }),
      request('Made To Order and Delivered on Wooden Pallets Throughout the Northern Counties'),
      request('Made To Order and Delivered on Wooden Pallets Throughout the Southern Counties'),
    ]
    expect(assignServiceNames(requests)).toEqual(assignServiceNames(requests))
  })

  // The last resort. Every candidate is taken and there is nothing left to
  // tell them apart by, so the answer is a refusal rather than a duplicate -
  // two services under one name is a state Merchant Center cannot represent
  // and this site could never unpick afterwards.
  it('refuses rather than repeat a name it cannot make unique', () => {
    const identical = Array.from({ length: 5 }, () => request('Standard'))
    const names = assignServiceNames(identical)
    expect(names.filter((name) => name !== null)).toHaveLength(4)
    expect(names[4]).toBeNull()
    const used = names.filter((name): name is string => name !== null)
    expect(new Set(used).size).toBe(used.length)
  })

  // Answers come back by POSITION. Keyed by anything two requests could share -
  // and two services with the same name share everything - and both would have
  // been handed the same answer.
  it('answers every request, even where two of them are identical', () => {
    const names = assignServiceNames([request('Standard'), request('Standard')])
    expect(names).toHaveLength(2)
    expect(names[0]).not.toBe(names[1])
  })
})
