// 看板服务测试 —— 逐条对照 Python tests/test_republish_service.py（SQLite 改用内存快照）。
import { describe, expect, it } from 'vitest'
import { createRepublishStore } from './republishStore.js'
import { RepublishError, formatIso } from './republish.js'

const pad = (n) => String(n).padStart(2, '0')

function localDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function makeItem(itemId, now, { ageDays = 10, exposure = '1000', views = '0', inquiry = '0', payments = '0' } = {}) {
  const created = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ageDays)
  return {
    itemId,
    title: `item ${itemId}`,
    price: '100.00',
    stock: '1',
    sales: '-',
    createTime: `${localDate(created)} 12:00:00`,
    exposure,
    viewCount: views,
    inquiry,
    payCount: payments,
  }
}

function cachePayload(now, items, { complete = true, hoursAgo = 1 } = {}) {
  return {
    fetched_at: new Date(now.getTime() - hoursAgo * 3_600_000).toISOString(),
    range: '7',
    complete,
    vitality: items,
  }
}

function memoryBackend(initial = null) {
  let payload = initial ? JSON.parse(JSON.stringify(initial)) : null
  let revision = initial ? 1 : 0
  return {
    readState: async () => ({
      payload: payload ? JSON.parse(JSON.stringify(payload)) : null,
      revision,
      exists: payload !== null,
    }),
    writeState: async (next, expected) => {
      if (expected !== revision) {
        const error = new Error('conflict')
        error.code = 'CLOUD_REVISION_CONFLICT'
        throw error
      }
      payload = JSON.parse(JSON.stringify(next))
      revision += 1
      return { payload, revision }
    },
    get payload() {
      return payload
    },
    get revision() {
      return revision
    },
  }
}

function conflictingBackend(failures) {
  const inner = memoryBackend()
  let remaining = failures
  return {
    readState: inner.readState,
    writeState: async (next, expected) => {
      if (remaining > 0) {
        remaining -= 1
        const error = new Error('conflict')
        error.code = 'CLOUD_REVISION_CONFLICT'
        throw error
      }
      return inner.writeState(next, expected)
    },
    get payload() {
      return inner.payload
    },
    get revision() {
      return inner.revision
    },
  }
}

function setup(now, items, { initial = null, cacheOptions = {} } = {}) {
  const backend = memoryBackend(initial)
  let vitality = cachePayload(now, items, cacheOptions)
  const store = createRepublishStore({
    readState: backend.readState,
    writeState: backend.writeState,
    readVitality: async () => vitality,
  })
  return {
    backend,
    store,
    setVitality: (next, opts = {}, at = now) => {
      vitality = cachePayload(at, next, opts)
    },
  }
}

function pool(backend) {
  return backend.payload?.pool || {}
}

function logs(backend) {
  return backend.payload?.logs || []
}

const NOW = new Date(2026, 10, 23, 12) // 2026-11-23 12:00 本地（周一）

describe('getDashboard', () => {
  it('syncs capacity, keeps top3 equal to queue head and preserves terminal states', async () => {
    const items = [
      ...Array.from({ length: 17 }, (_, n) => makeItem(`candidate-${pad(n)}`, NOW)),
      makeItem('protected-pay', NOW, { payments: '1' }),
      makeItem('cancelled', NOW, { ageDays: 15, exposure: '500', views: '5' }),
      makeItem('archived', NOW, { ageDays: 15, exposure: '500', views: '5' }),
    ]
    const initial = {
      pool: {
        cancelled: { itemId: 'cancelled', lineageId: 'cancelled', title: 'c', status: 'CANCELED', republishRound: 0 },
        archived: { itemId: 'archived', lineageId: 'archived', title: 'a', status: 'ARCHIVED', republishRound: 0 },
      },
      logs: [],
      nextLogId: 1,
    }
    const { store, backend } = setup(NOW, items, { initial })

    const first = await store.getDashboard(NOW)
    const second = await store.getDashboard(NOW)

    expect(first.data_status.available).toBe(true)
    expect(first.queue).toHaveLength(15)
    expect(first.capacity_waitlist).toHaveLength(2)
    expect(first.top_action_queue.map((row) => row.itemId)).toEqual(first.queue.slice(0, 3).map((row) => row.itemId))
    expect(first.top_action_queue[0].advice).toContain('建议更换首图')
    expect(first.top_action_queue[0].stock).toBe('1')
    expect(first.top_action_queue[0].sales).toBe('-')
    expect(first.top_action_queue[0].createTime.startsWith('2026-11-13')).toBe(true)
    expect(first.top_action_queue[0].listingAgeDays).toBe(10)
    expect(first.protected.find((row) => row.itemId === 'protected-pay').protectionReason).toBe(
      'PAYMENT_PROTECTION',
    )
    expect(second.queue).toHaveLength(15)
    expect(pool(backend).cancelled.status).toBe('CANCELED')
    expect(pool(backend).archived.status).toBe('ARCHIVED')
    expect(Object.values(pool(backend)).filter((row) => row.status === 'QUEUING')).toHaveLength(15)
  })

  it('protects and re-enters without losing lineage round', async () => {
    const items = [makeItem('reentry-item', NOW, { ageDays: 15, exposure: '500', views: '5' })]
    const initial = {
      pool: {
        'reentry-item': {
          itemId: 'reentry-item',
          lineageId: 'original-lineage',
          title: 'reentry item',
          status: 'PROTECTED',
          republishRound: 1,
          protectionReason: 'INQUIRY_PROTECTION',
        },
      },
      logs: [],
      nextLogId: 1,
    }
    const { store, backend } = setup(NOW, items, { initial })

    const dashboard = await store.getDashboard(NOW)

    const row = dashboard.queue.find((item) => item.itemId === 'reentry-item')
    expect(row.republishRound).toBe(1)
    expect(row.inPoolAt).toBeTruthy()
    expect(pool(backend)['reentry-item']).toMatchObject({
      status: 'QUEUING',
      lineageId: 'original-lineage',
      republishRound: 1,
    })
    expect(logs(backend).filter((entry) => entry.action === 'REENTRY' && entry.itemId === 'reentry-item')).toHaveLength(1)
  })

  it('queues by exposure layer and removes healthy items', async () => {
    const items = [
      makeItem('high-exp-low-ctr', NOW, { ageDays: 10, exposure: '1500', views: '5' }),
      makeItem('reborn', NOW, { ageDays: 20, exposure: '500', views: '2' }),
      makeItem('activate-high', NOW, { ageDays: 30, exposure: '80', views: '4' }),
      makeItem('activate-low', NOW, { ageDays: 30, exposure: '20', views: '1' }),
      makeItem('healthy', NOW, { ageDays: 20, exposure: '500', views: '50' }),
    ]
    const initial = {
      pool: {
        healthy: {
          itemId: 'healthy',
          lineageId: 'healthy',
          title: 'healthy item',
          status: 'QUEUING',
          republishRound: 0,
          queueKind: 'reborn',
        },
      },
      logs: [],
      nextLogId: 1,
    }
    const { store, backend } = setup(NOW, items, { initial })

    const dashboard = await store.getDashboard(NOW)

    expect(dashboard.queue.map((row) => row.itemId)).toEqual([
      'high-exp-low-ctr',
      'reborn',
      'activate-low',
      'activate-high',
    ])
    expect(dashboard.healthy_count).toBe(1)
    expect(dashboard.queue.some((row) => row.itemId === 'healthy')).toBe(false)
    expect(pool(backend).healthy).toMatchObject({ status: 'PROTECTED', protectionReason: 'HEALTHY' })
    expect(dashboard.protected.find((row) => row.itemId === 'healthy')?.protectionReason).toBe('HEALTHY')
  })

  it('rebalances the queue to the top exposure layers', async () => {
    const initialItems = Array.from({ length: 15 }, (_, n) =>
      makeItem(`item-${pad(n + 2)}`, NOW, { ageDays: 30, exposure: String(n + 2), views: '0' }),
    )
    const { store, backend, setVitality } = setup(NOW, initialItems)
    await store.getDashboard(NOW)

    setVitality(
      [makeItem('item-01', NOW, { ageDays: 30, exposure: '1', views: '0' }), ...initialItems],
      {},
      NOW,
    )
    const dashboard = await store.getDashboard(NOW)

    expect(dashboard.queue).toHaveLength(15)
    expect(dashboard.queue[0].itemId).toBe('item-01')
    expect(dashboard.queue.map((row) => row.itemId)).not.toContain('item-16')
    expect(pool(backend)['item-16']).toMatchObject({
      status: 'PROTECTED',
      protectionReason: 'CAPACITY_WAITLIST',
    })
    expect(dashboard.capacity_waitlist.map((row) => row.itemId)).toEqual(['item-16'])
  })

  it('does not count offlined items toward the 15-item queue capacity', async () => {
    const items = [
      ...Array.from({ length: 17 }, (_, n) => makeItem(`candidate-${pad(n)}`, NOW)),
      ...Array.from({ length: 2 }, (_, n) => makeItem(`offlined-${n}`, NOW)),
    ]
    const offlinedAt = formatIso(new Date(NOW.getTime() - 25 * 3_600_000))
    const initial = {
      pool: Object.fromEntries(
        Array.from({ length: 2 }, (_, n) => {
          const itemId = `offlined-${n}`
          return [
            itemId,
            {
              itemId,
              lineageId: itemId,
              title: itemId,
              status: 'OFFLINED',
              republishRound: 0,
              offlinedAt,
            },
          ]
        }),
      ),
      logs: [],
      nextLogId: 1,
    }
    const { store, backend } = setup(NOW, items, { initial })

    const dashboard = await store.getDashboard(NOW)

    expect(dashboard.queue).toHaveLength(15)
    expect(dashboard.queue.map((row) => row.itemId)).not.toContain('offlined-0')
    expect(dashboard.offlined.map((row) => row.itemId).sort()).toEqual(['offlined-0', 'offlined-1'])
    expect(dashboard.capacity_waitlist).toHaveLength(2)
    expect(dashboard.pool_statuses['offlined-0']).toBe('OFFLINED')
    expect(pool(backend)['offlined-0'].status).toBe('OFFLINED')
  })

  it('manually offlines any item and keeps the queue full', async () => {
    const items = Array.from({ length: 15 }, (_, n) => makeItem(`candidate-${pad(n)}`, NOW))
    const { store, backend } = setup(NOW, items)
    const before = await store.getDashboard(NOW)
    expect(before.queue).toHaveLength(15)

    const item = {
      itemId: 'manual-item',
      title: 'Manual item',
      price: '99.00',
      createTime: '2026-11-01 00:00:00',
      exposure: '50',
      viewCount: '1',
    }
    const row = await store.manualOffline(item, { offlinedAt: '2026-11-23T00:00:00+08:00' }, NOW)

    expect(row.status).toBe('OFFLINED')
    expect(new Date(row.offlinedAt).getTime()).toBe(new Date('2026-11-23T00:00:00+08:00').getTime())
    const after = await store.getDashboard(NOW)
    expect(after.offlined.map((entry) => entry.itemId)).toContain('manual-item')
    expect(after.queue).toHaveLength(15)
    expect(logs(backend).some((entry) => entry.itemId === 'manual-item' && entry.action === 'OFFLINE')).toBe(true)
  })

  it('removes an offlined item from the holding area', async () => {
    const { store, backend } = setup(NOW, [])
    await store.manualOffline(
      { itemId: 'holding-item', title: 'Holding item', price: '88.00' },
      { offlinedAt: '2026-11-23T00:00:00+08:00' },
      NOW,
    )

    const removed = await store.removeOffline('holding-item', NOW)
    const dashboard = await store.getDashboard(NOW)

    expect(removed.status).toBe('CANCELED')
    expect(dashboard.offlined.map((row) => row.itemId)).not.toContain('holding-item')
    expect(pool(backend)['holding-item'].protectionReason).toBe('USER_REMOVED_OFFLINE')
    expect(logs(backend).some((entry) => entry.itemId === 'holding-item' && entry.action === 'OFFLINE_REMOVE')).toBe(
      true,
    )
  })

  it('does not insert candidates from stale or incomplete caches', async () => {
    const items = [makeItem('stale-item', NOW, { ageDays: 15, exposure: '500', views: '0' })]
    const stale = setup(NOW, items, { cacheOptions: { hoursAgo: 37 } })
    const staleDashboard = await stale.store.getDashboard(NOW)
    expect(staleDashboard.data_status.available).toBe(false)
    expect(pool(stale.backend)).toEqual({})

    const partial = setup(NOW, items, { cacheOptions: { complete: false } })
    const partialDashboard = await partial.store.getDashboard(NOW)
    expect(partialDashboard.data_status.available).toBe(false)
    expect(partialDashboard.queue).toEqual([])
    expect(pool(partial.backend)).toEqual({})
  })

  it('surfaces records without itemId without crashing', async () => {
    const missing = makeItem('unused', NOW, { ageDays: 15, exposure: '500', views: '0' })
    delete missing.itemId
    const { store } = setup(NOW, [missing])
    const dashboard = await store.getDashboard(NOW)
    expect(dashboard.data_status.available).toBe(true)
    expect(dashboard.protected).toHaveLength(1)
    expect(dashboard.protected[0].diagnosticKey).toBe('missing-id-0')
    expect(dashboard.protected[0].itemId).toBe('')
  })

  it.each([
    ['payment', 'PAYMENT_PROTECTION'],
    ['inquiry', 'INQUIRY_PROTECTION'],
    ['missing', 'METRICS_INCOMPLETE'],
  ])('keeps 24h cooldown for OFFLINED when new cache flags %s', async (change, reason) => {
    const item = makeItem('offlined-stable', NOW, { ageDays: 10, exposure: '500', views: '5' })
    if (change === 'payment') item.payCount = '1'
    else if (change === 'inquiry') item.inquiry = '1'
    else {
      item.exposure = ''
      item.viewCount = '—'
    }
    const offlinedAt = formatIso(new Date(NOW.getTime() - 23 * 3_600_000))
    const initial = {
      pool: {
        'offlined-stable': {
          itemId: 'offlined-stable',
          lineageId: 'offlined-stable',
          title: 'Already offlined',
          status: 'OFFLINED',
          republishRound: 0,
          offlinedAt,
        },
      },
      logs: [],
      nextLogId: 1,
    }
    const { store } = setup(NOW, [item], { initial })

    const dashboard = await store.getDashboard(NOW)
    const row = dashboard.offlined.find((entry) => entry.itemId === 'offlined-stable')
    expect(row.status).toBe('OFFLINED')
    expect(row.offlinedAt).toBe(offlinedAt)
    expect(row.protectionReason).toBe(reason)
  })

  it('protects missing queued ids but keeps offlined timer', async () => {
    const offlinedAt = formatIso(new Date(NOW.getTime() - 23 * 3_600_000))
    const initial = {
      pool: {
        'missing-queue': {
          itemId: 'missing-queue',
          lineageId: 'missing-queue',
          title: 'q',
          priorityLevel: 'P1',
          inPoolAt: formatIso(NOW),
          status: 'QUEUING',
          republishRound: 0,
        },
        'missing-offline': {
          itemId: 'missing-offline',
          lineageId: 'missing-offline',
          title: 'o',
          priorityLevel: 'P1',
          inPoolAt: formatIso(NOW),
          status: 'OFFLINED',
          republishRound: 0,
          offlinedAt,
        },
      },
      logs: [],
      nextLogId: 1,
    }
    const { store } = setup(NOW, [], { initial })

    const dashboard = await store.getDashboard(NOW)
    expect(dashboard.queue.map((row) => row.itemId)).not.toContain('missing-queue')
    expect(dashboard.protected.find((row) => row.itemId === 'missing-queue').protectionReason).toBe(
      'ITEM_NOT_IN_CACHE',
    )
    expect(dashboard.offlined.map((row) => row.itemId)).toEqual(['missing-offline'])
  })

  it('marks sunday-recovered queue without removing it', async () => {
    const sunday = new Date(2026, 10, 29, 12) // 2026-11-29 周日
    const item = makeItem('recovered', sunday, { ageDays: 15, exposure: '200', views: '3' })
    const initial = {
      pool: {
        recovered: {
          itemId: 'recovered',
          lineageId: 'recovered',
          title: 'Recovered listing',
          priorityLevel: 'P2',
          exposure7d: 200,
          views7d: 2,
          ctr7d: 1,
          inquiryCount: 0,
          orderCount: 0,
          inPoolAt: '2026-11-22T12:00:00+00:00',
          status: 'QUEUING',
          republishRound: 0,
        },
      },
      logs: [],
      nextLogId: 1,
    }
    const { store } = setup(sunday, [item], { initial })

    const dashboard = await store.getDashboard(sunday)
    const row = dashboard.queue.find((entry) => entry.itemId === 'recovered')
    expect(row.status).toBe('QUEUING')
    expect(row.recovered).toBe(true)
    expect(row.ctr7d).toBeCloseTo(1.5, 6)
  })
})

describe('startOptimization / retest', () => {
  it('requires age and CTR band eligibility', async () => {
    for (const [itemId, views, accepted] of [
      ['retest-080', '4', true],
      ['retest-149', '7', true],
      ['retest-079', '3.95', false],
      ['retest-150', '7.5', false],
    ]) {
      const { store } = setup(NOW, [makeItem(itemId, NOW, { exposure: '500', views })])
      await store.getDashboard(NOW)
      if (accepted) {
        const result = await store.startOptimization(itemId, NOW)
        expect(result.status).toBe('RETESTING')
        const dashboard = await store.getDashboard(NOW)
        expect(dashboard.optimization_candidates.map((row) => row.itemId)).not.toContain(itemId)
        expect(dashboard.retesting.map((row) => row.itemId)).toContain(itemId)
      } else {
        await expect(store.startOptimization(itemId, NOW)).rejects.toBeInstanceOf(RepublishError)
      }
    }

    const age14 = setup(NOW, [makeItem('retest-age14', NOW, { exposure: '500', views: '5', ageDays: 14 })])
    await age14.store.getDashboard(NOW)
    await expect(age14.store.startOptimization('retest-age14', NOW)).rejects.toBeInstanceOf(RepublishError)
  })

  it('requires 72h and current CTR for retest outcome', async () => {
    const { store, backend, setVitality } = setup(NOW, [
      makeItem('retest-fail', NOW, { exposure: '500', views: '4' }),
    ])
    await store.getDashboard(NOW)
    await store.startOptimization('retest-fail', NOW)

    const before72 = new Date(NOW.getTime() + 71 * 3_600_000 + 59 * 60_000 + 59_000)
    setVitality([makeItem('retest-fail', before72, { exposure: '500', views: '7' })], {}, before72)
    const early = await store.getDashboard(before72)
    expect(early.retesting.map((row) => row.itemId)).toEqual(['retest-fail'])
    expect(early.queue).toEqual([])

    const at72 = new Date(NOW.getTime() + 72 * 3_600_000)
    setVitality([makeItem('retest-fail', at72, { exposure: '500', views: '7' })], {}, at72)
    const completed = await store.getDashboard(at72)
    const row = completed.queue.find((entry) => entry.itemId === 'retest-fail')
    expect(row.priority).toBe('P2')
    expect(row.status).toBe('QUEUING')

    const offline = await store.confirmOffline('retest-fail', { offlineConfirmed: true, materialsPrepared: true }, at72)
    expect(offline.status).toBe('OFFLINED')
    expect(logs(backend).filter((entry) => entry.itemId === 'retest-fail' && entry.action === 'RETEST_FAIL')).toHaveLength(1)
  })

  it('passes retest when CTR recovers at 72h', async () => {
    const { store, backend, setVitality } = setup(NOW, [
      makeItem('retest-pass', NOW, { exposure: '500', views: '4' }),
    ])
    await store.getDashboard(NOW)
    await store.startOptimization('retest-pass', NOW)

    const at72 = new Date(NOW.getTime() + 72 * 3_600_000)
    setVitality([makeItem('retest-pass', at72, { exposure: '200', views: '3' })], {}, at72)
    const dashboard = await store.getDashboard(at72)

    expect(dashboard.queue).toEqual([])
    expect(dashboard.protected.find((row) => row.itemId === 'retest-pass').protectionReason).toBe(
      'RETEST_PASSED',
    )
    expect(logs(backend).filter((entry) => entry.itemId === 'retest-pass').at(-1).action).toBe('RETEST_PASS')
  })
})

describe('daily quota', () => {
  it('enforces the total limit of three and resets at local midnight', async () => {
    const { store, backend } = setup(NOW, [])
    for (let minute = 0; minute < 3; minute += 1) {
      await store.recordNewListing(new Date(NOW.getTime() + minute * 60_000))
    }
    await expect(store.recordNewListing(new Date(NOW.getTime() + 3 * 60_000))).rejects.toBeInstanceOf(
      RepublishError,
    )
    const dashboard = await store.getDashboard(new Date(NOW.getTime() + 3 * 60_000))
    expect(dashboard.quota).toEqual({
      new_listings_today: 3,
      reposts_today: 0,
      remaining_suggested: 0,
      locked: true,
    })

    const midnight = new Date(2026, 10, 23, 0, 0, 1)
    const yesterday = new Date(2026, 10, 22, 23, 59, 59)
    const fresh = setup(NOW, [])
    await fresh.store.recordNewListing(yesterday)
    const nextDay = await fresh.store.getDashboard(midnight)
    expect(nextDay.quota.new_listings_today).toBe(0)
    expect(nextDay.quota.reposts_today).toBe(0)
    expect(nextDay.quota.remaining_suggested).toBe(3)
    expect(nextDay.quota.locked).toBe(false)
  })
})

describe('offline / repost', () => {
  it('requires both checklist items and waits 24h before repost with lineage', async () => {
    const { store, backend } = setup(NOW, [makeItem('old-id', NOW)])
    await store.getDashboard(NOW)

    await expect(
      store.confirmOffline('old-id', { offlineConfirmed: true, materialsPrepared: false }, NOW),
    ).rejects.toBeInstanceOf(RepublishError)
    expect(pool(backend)['old-id'].status).toBe('QUEUING')
    expect(logs(backend).filter((entry) => entry.action === 'OFFLINE')).toHaveLength(0)

    const offline = await store.confirmOffline(
      'old-id',
      { offlineConfirmed: true, materialsPrepared: true },
      NOW,
    )
    expect(offline.status).toBe('OFFLINED')
    expect(offline.repostAvailableAt).toBe(formatIso(new Date(NOW.getTime() + 24 * 3_600_000)))

    const tooEarly = new Date(NOW.getTime() + 24 * 3_600_000 - 1000)
    await expect(store.confirmRepost('old-id', 'new-id-too-early', tooEarly)).rejects.toBeInstanceOf(
      RepublishError,
    )
    const available = new Date(NOW.getTime() + 24 * 3_600_000)
    await expect(store.confirmRepost('old-id', 'old-id', available)).rejects.toBeInstanceOf(RepublishError)

    const result = await store.confirmRepost('old-id', 'new-id', available)
    expect(result.itemId).toBe('new-id')
    expect(result.lineageId).toBe('old-id')
    expect(result.republishRound).toBe(1)
    expect(result.metricsMissing).toBe(true)
    expect(pool(backend)['old-id']).toMatchObject({ status: 'REPOSTED', republishRound: 1 })
    expect(pool(backend)['new-id']).toMatchObject({ status: 'PROTECTED', lineageId: 'old-id', republishRound: 1 })
    expect(logs(backend).find((entry) => entry.action === 'REPOST' && entry.itemId === 'old-id').relatedItemId).toBe(
      'new-id',
    )
  })

  it('limits reposts to two per day and archives the second lineage round', async () => {
    const offlinedAt = formatIso(new Date(NOW.getTime() - 24 * 3_600_000))
    const initial = {
      pool: Object.fromEntries(
        ['offlined-0', 'offlined-1', 'offlined-2'].map((itemId) => [
          itemId,
          { itemId, lineageId: itemId, title: itemId, status: 'OFFLINED', republishRound: 0, offlinedAt },
        ]),
      ),
      logs: [],
      nextLogId: 1,
    }
    const { store, backend } = setup(NOW, [], { initial })

    await store.confirmRepost('offlined-0', 'new-0', NOW)
    await store.confirmRepost('offlined-1', 'new-1', new Date(NOW.getTime() + 60_000))
    await expect(
      store.confirmRepost('offlined-2', 'new-2', new Date(NOW.getTime() + 120_000)),
    ).rejects.toBeInstanceOf(RepublishError)

    const secondDay = new Date(NOW.getTime() + 86_400_000)
    backend.payload.pool['round-one-item'] = {
      itemId: 'round-one-item',
      lineageId: 'root-round-one',
      title: 'round one',
      status: 'OFFLINED',
      republishRound: 1,
      offlinedAt: formatIso(new Date(secondDay.getTime() - 24 * 3_600_000)),
    }
    await store.confirmRepost('round-one-item', 'round-two-new-id', secondDay)
    expect(pool(backend)['round-two-new-id']).toMatchObject({ status: 'ARCHIVED', republishRound: 2 })
    const todayReposts = logs(backend).filter(
      (entry) => entry.action === 'REPOST' && entry.createdAt.slice(0, 10) === localDate(NOW),
    )
    expect(todayReposts).toHaveLength(2)
  })

  it('rejects a new id already present in the current cache', async () => {
    const initial = {
      pool: {
        'old-id': {
          itemId: 'old-id',
          lineageId: 'old-id',
          title: 'Old listing',
          status: 'OFFLINED',
          republishRound: 0,
          offlinedAt: formatIso(new Date(NOW.getTime() - 24 * 3_600_000)),
        },
      },
      logs: [],
      nextLogId: 1,
    }
    const { store, backend } = setup(
      NOW,
      [makeItem('new-id', NOW, { ageDays: 15, exposure: '500', views: '0' })],
      { initial },
    )

    await expect(store.confirmRepost('old-id', 'new-id', NOW)).rejects.toMatchObject({ code: 'ITEM_ID_EXISTS' })
    expect(pool(backend)['old-id'].status).toBe('OFFLINED')
    expect(logs(backend).filter((entry) => entry.action === 'REPOST')).toHaveLength(0)
  })
})

describe('cancelItem', () => {
  it('requires sunday and persists history', async () => {    const sunday = new Date(2026, 10, 29, 12)
    const monday = new Date(2026, 10, 30, 12)
    const initial = {
      pool: {
        recovered: {
          itemId: 'recovered',
          lineageId: 'recovered',
          title: 'Recovered',
          priorityLevel: 'P2',
          exposure7d: 200,
          views7d: 2,
          ctr7d: 1,
          inquiryCount: 0,
          orderCount: 0,
          inPoolAt: '2026-11-22T12:00:00+00:00',
          status: 'QUEUING',
          republishRound: 0,
        },
      },
      logs: [],
      nextLogId: 1,
    }
    const { store, backend } = setup(sunday, [makeItem('recovered', sunday, { ageDays: 15, exposure: '200', views: '3' })], {
      initial,
    })

    await expect(store.cancelItem('recovered', monday)).rejects.toBeInstanceOf(RepublishError)
    const result = await store.cancelItem('recovered', sunday)
    expect(result.status).toBe('CANCELED')
    expect(logs(backend).filter((entry) => entry.itemId === 'recovered').at(-1).action).toBe('CANCEL')
  })
})

describe('optimistic lock', () => {
  it('retries revision conflicts and persists exactly once', async () => {
    const backend = conflictingBackend(2)
    const vitality = cachePayload(NOW, [makeItem('conflict-item', NOW)])
    const store = createRepublishStore({
      readState: backend.readState,
      writeState: backend.writeState,
      readVitality: async () => vitality,
    })

    const dashboard = await store.getDashboard(NOW)

    expect(dashboard.queue.map((row) => row.itemId)).toContain('conflict-item')
    expect(backend.revision).toBe(1)
    expect(backend.payload.pool['conflict-item'].status).toBe('QUEUING')
  })

  it('throws after exhausting retries without writing', async () => {
    const backend = conflictingBackend(3)
    const vitality = cachePayload(NOW, [makeItem('exhausted-item', NOW)])
    const store = createRepublishStore({
      readState: backend.readState,
      writeState: backend.writeState,
      readVitality: async () => vitality,
    })

    await expect(store.getDashboard(NOW)).rejects.toMatchObject({ code: 'CLOUD_REVISION_CONFLICT' })
    expect(backend.payload).toBeNull()
  })

  it('does not write the cloud when a read-only dashboard load changes nothing', async () => {
    const backend = memoryBackend()
    const vitality = cachePayload(NOW, [makeItem('stable-item', NOW)])
    const store = createRepublishStore({
      readState: backend.readState,
      writeState: backend.writeState,
      readVitality: async () => vitality,
    })

    await store.getDashboard(NOW)
    const revisionAfterFirst = backend.revision
    // 不同时间重复加载：内容未变，不应产生新写入
    await store.getDashboard(new Date(NOW.getTime() + 60_000))

    expect(backend.revision).toBe(revisionAfterFirst)
  })
})

describe('additional boundary cases', () => {
  it('allows canceling a RETESTING item after sunday recovery', async () => {
    const sunday = new Date(2026, 10, 29, 12)
    const { store, setVitality } = setup(sunday, [
      makeItem('retest-recovered', sunday, { ageDays: 10, exposure: '500', views: '4' }),
    ])
    await store.getDashboard(sunday)
    await store.startOptimization('retest-recovered', sunday)
    setVitality(
      [makeItem('retest-recovered', sunday, { ageDays: 10, exposure: '200', views: '3' })],
      {},
      sunday,
    )

    const dashboard = await store.getDashboard(sunday)
    const item = dashboard.retesting.find((row) => row.itemId === 'retest-recovered')
    expect(item.recovered).toBe(true)

    const result = await store.cancelItem('retest-recovered', sunday)
    expect(result.status).toBe('CANCELED')
  })

  it('rejects a new id that already exists in the pool', async () => {
    const initial = {
      pool: {
        'old-id': {
          itemId: 'old-id',
          lineageId: 'old-id',
          title: 'old',
          status: 'OFFLINED',
          republishRound: 0,
          offlinedAt: formatIso(new Date(NOW.getTime() - 24 * 3_600_000)),
        },
        'new-id': {
          itemId: 'new-id',
          lineageId: 'new-id',
          title: 'existing',
          status: 'CANCELED',
          republishRound: 0,
        },
      },
      logs: [],
      nextLogId: 1,
    }
    const { store } = setup(NOW, [], { initial })

    await expect(store.confirmRepost('old-id', 'new-id', NOW)).rejects.toMatchObject({
      code: 'ITEM_ID_EXISTS',
    })
  })

  it('rejects repost when lineage already reached two rounds', async () => {
    const initial = {
      pool: {
        'old-id': {
          itemId: 'old-id',
          lineageId: 'root',
          title: 'old',
          status: 'OFFLINED',
          republishRound: 2,
          offlinedAt: formatIso(new Date(NOW.getTime() - 24 * 3_600_000)),
        },
      },
      logs: [],
      nextLogId: 1,
    }
    const { store } = setup(NOW, [], { initial })

    await expect(store.confirmRepost('old-id', 'new-id', NOW)).rejects.toMatchObject({
      code: 'ROUND_LIMIT',
    })
  })
})
