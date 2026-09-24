import { describe, it, expect } from 'vitest'
import { assignDeliveryLabels } from '@/modules/google-shopping-for-shop/lib/delivery/labels'
import type { DeliveryScope } from '@/modules/google-shopping-for-shop/lib/delivery/catalogue'

function scope(id: string, kind: DeliveryScope['kind'], label: string, ref: string | null = id): DeliveryScope {
  return { id, kind, ref, label }
}

describe('assignDeliveryLabels', () => {
  it('uses the group\'s own name where nothing else wants it', () => {
    const { byScopeId, qualified } = assignDeliveryLabels([
      scope('range:a', 'RANGE', 'Orion'),
      scope('category:b', 'CATEGORY', 'Office chairs'),
      scope('supplier:Furdeco', 'SUPPLIER', 'Furdeco'),
    ])
    expect(byScopeId.get('range:a')).toBe('Orion')
    expect(byScopeId.get('category:b')).toBe('Office chairs')
    expect(byScopeId.get('supplier:Furdeco')).toBe('Furdeco')
    expect(qualified).toEqual([])
  })

  // The failure this guards against is silent and expensive: two groups under
  // one label means Google cannot tell them apart, and the second group's
  // products quietly take the first group's delivery price.
  it('qualifies a name that is already taken, and says which', () => {
    const { byScopeId, qualified } = assignDeliveryLabels([
      scope('range:a', 'RANGE', 'Orion'),
      scope('category:b', 'CATEGORY', 'Orion'),
    ])
    expect(byScopeId.get('range:a')).toBe('Orion')
    expect(byScopeId.get('category:b')).toBe('Orion (category)')
    expect(qualified).toEqual([{ scopeId: 'category:b', wanted: 'Orion', used: 'Orion (category)' }])
  })

  it('falls back to a fingerprint when even the qualified name is taken', () => {
    const { byScopeId } = assignDeliveryLabels([
      scope('category:one', 'CATEGORY', 'Desks'),
      scope('category:two', 'CATEGORY', 'Desks'),
      scope('category:three', 'CATEGORY', 'Desks'),
    ])
    const labels = [...byScopeId.values()]
    expect(labels).toHaveLength(3)
    expect(new Set(labels).size).toBe(3)
    expect(labels[0]).toBe('Desks')
    expect(labels[1]).toBe('Desks (category)')
    expect(labels[2]).toMatch(/^Desks \(category [a-z0-9]{1,6}\)$/)
  })

  it('is stable: the same scopes in the same order give the same labels', () => {
    const scopes = [scope('category:one', 'CATEGORY', 'Desks'), scope('category:two', 'CATEGORY', 'Desks')]
    expect([...assignDeliveryLabels(scopes).byScopeId]).toEqual([...assignDeliveryLabels(scopes).byScopeId])
  })

  it('keeps every label inside Google\'s hundred characters', () => {
    const long = 'Executive height adjustable sit stand desking for the open plan office in oak veneer and white'
    const { byScopeId } = assignDeliveryLabels([
      scope('range:a', 'RANGE', `${long} one`),
      scope('range:b', 'RANGE', `${long} two`),
    ])
    for (const label of byScopeId.values()) expect(label.length).toBeLessThanOrEqual(100)
    // Two names differing only in their tail must NOT collapse into one - the
    // fingerprint fitShippingLabel appends is what keeps them apart.
    expect(new Set(byScopeId.values()).size).toBe(2)
  })

  it('gives no label at all to a group with no name, rather than inventing one', () => {
    const { byScopeId } = assignDeliveryLabels([scope('category:blank', 'CATEGORY', '   ')])
    expect(byScopeId.size).toBe(0)
  })

  it('normalises whitespace, so a stray double space cannot make two groups', () => {
    const { byScopeId } = assignDeliveryLabels([
      scope('range:a', 'RANGE', 'Orion  Plus '),
      scope('range:b', 'RANGE', 'Orion Plus'),
    ])
    expect(byScopeId.get('range:a')).toBe('Orion Plus')
    expect(byScopeId.get('range:b')).toBe('Orion Plus (range)')
  })
})
