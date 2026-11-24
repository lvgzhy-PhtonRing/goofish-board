import { describe, expect, it } from 'vitest'
import { buildVitalityStatus } from './vitalityStatus.js'

const item = (itemId) => ({ itemId, title: `item ${itemId}`, price: '10.00' })

function shopStatus(ids, complete = true) {
  return { payload: { complete, items: ids.map((itemId) => ({ itemId, title: `cdp ${itemId}` })) } }
}

describe('buildVitalityStatus', () => {
  it('marks on-sale, sold, offline and missing items', () => {
    const items = ['a', 'b', 'c', 'd'].map(item)
    const result = buildVitalityStatus(
      items,
      shopStatus(['a', 'b']),
      [
        { item_id: 'a', type: 'offline', occurred_at: '2026-11-22T00:00:00+08:00', data: { source: 'user' } },
        { item_id: 'c', type: 'sold', occurred_at: '2026-11-22T00:00:00+08:00', data: { source: 'ysp' } },
        { item_id: 'd', type: 'offline', occurred_at: '2026-11-23T00:00:00+08:00', data: { source: 'user' } },
      ],
    )

    expect(result.cdpAvailable).toBe(true)
    expect(result.cdpCount).toBe(2)
    expect(result.missingCount).toBe(2)
    expect(result.statusById.get('a').key).toBe('onsale')
    expect(result.statusById.get('c').key).toBe('sold')
    expect(result.statusById.get('c').label).toBe('售出')
    expect(result.statusById.get('d').key).toBe('offline')
    expect(result.statusById.get('d').event.data.source).toBe('user')
  })

  it('prefers a sold event over an offline event', () => {
    const result = buildVitalityStatus(
      [item('x')],
      shopStatus([]),
      [
        { item_id: 'x', type: 'offline', occurred_at: '2026-11-23T00:00:00+08:00', data: {} },
        { item_id: 'x', type: 'sold', occurred_at: '2026-11-22T00:00:00+08:00', data: {} },
      ],
    )

    expect(result.statusById.get('x').key).toBe('sold')
  })

  it('counts CDP items that are not in the vitality payload', () => {
    const result = buildVitalityStatus(
      [item('a')],
      shopStatus(['a', 'new-1', 'new-2']),
      [],
    )

    expect(result.cdpCount).toBe(3)
    expect(result.newCdpCount).toBe(2)
    expect(result.missingCount).toBe(0)
  })

  it('does not mark every item as missing when no complete snapshot exists', () => {
    const result = buildVitalityStatus([item('a'), item('b')], null, [])

    expect(result.cdpAvailable).toBe(false)
    expect(result.missingCount).toBe(0)
    expect(result.statusById.get('a').key).toBe('unknown')
    expect(result.statusById.get('b').key).toBe('unknown')
  })
})
