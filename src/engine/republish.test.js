// 规则引擎测试 —— 逐条对照 Python tests/test_republish_service.py。
import { describe, expect, it } from 'vitest'
import {
  ADVICE_HIGH_EXPOSURE_LOW_CTR,
  ADVICE_MID_EXPOSURE_CTR,
  apiRow,
  diagnoseItems,
  formatIso,
  listingAgeDays,
  parseNumber,
  parseVitalityCache,
} from './republish.js'

const NOW = new Date(2026, 10, 23, 12) // 本地 2026-11-23 12:00（周一）

function item(itemId, { ageDays, exposure, views, inquiry = '0', payments = '0' }) {
  const created = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - ageDays)
  const date = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}-${String(created.getDate()).padStart(2, '0')}`
  return {
    itemId,
    title: `item ${itemId}`,
    price: '100.00',
    stock: '1',
    sales: '-',
    createTime: `${date} 12:00:00`,
    exposure,
    viewCount: views,
    inquiry,
    payCount: payments,
  }
}

function cache(fetchedAt, { range = '7', complete = true, vitality = [] } = {}) {
  return { fetched_at: fetchedAt, range, complete, vitality }
}

describe('parseNumber / listingAgeDays', () => {
  it('treats blanks, placeholders, negatives and non-finite values as unknown', () => {
    expect(parseNumber('')).toBeNull()
    expect(parseNumber('—')).toBeNull()
    expect(parseNumber('-')).toBeNull()
    expect(parseNumber('N/A')).toBeNull()
    expect(parseNumber('暂无')).toBeNull()
    expect(parseNumber('-1')).toBeNull()
    expect(parseNumber('Infinity')).toBeNull()
    expect(parseNumber('1,234')).toBe(1234)
    expect(parseNumber('464.0')).toBe(464)
  })

  it('computes listing age by local date difference and rejects future/invalid', () => {
    const now = new Date('2026-11-23T12:00:00')
    expect(listingAgeDays('2026-11-13 00:00:00', now)).toBe(10)
    expect(listingAgeDays('2026-11-24 00:00:00', now)).toBeNull()
    expect(listingAgeDays('not-a-date', now)).toBeNull()
    expect(listingAgeDays('', now)).toBeNull()
  })
})

describe('parseVitalityCache', () => {
  it('rejects unusable caches', () => {
    expect(parseVitalityCache(null, NOW).available).toBe(false)
    expect(parseVitalityCache('{not-json', NOW).available).toBe(false)
    expect(parseVitalityCache(cache('not-a-timestamp'), NOW)).toMatchObject({
      available: false,
      reason: 'TIMESTAMP_INVALID',
    })
    expect(parseVitalityCache(cache(new Date(NOW.getTime() + 3_600_000).toISOString()), NOW)).toMatchObject({
      available: false,
      reason: 'TIMESTAMP_IN_FUTURE',
    })
    expect(parseVitalityCache(cache(new Date(NOW.getTime() - 37 * 3_600_000).toISOString()), NOW)).toMatchObject({
      available: false,
      reason: 'CACHE_STALE',
    })
    expect(
      parseVitalityCache(cache(new Date(NOW.getTime() - 3_600_000).toISOString(), { range: '1' }), NOW),
    ).toMatchObject({
      available: false,
      reason: 'RANGE_NOT_7D',
    })
    expect(
      parseVitalityCache(cache(new Date(NOW.getTime() - 3_600_000).toISOString(), { complete: false }), NOW),
    ).toMatchObject({
      available: false,
      reason: 'CACHE_INCOMPLETE',
    })
  })

  it('accepts a legacy timestamp without timezone as browser-local time', () => {
    const now = new Date()
    const oneHourAgo = new Date(now.getTime() - 3_600_000)
    const legacy = `${oneHourAgo.getFullYear()}-${String(oneHourAgo.getMonth() + 1).padStart(2, '0')}-${String(oneHourAgo.getDate()).padStart(2, '0')} ${String(oneHourAgo.getHours()).padStart(2, '0')}:${String(oneHourAgo.getMinutes()).padStart(2, '0')}:${String(oneHourAgo.getSeconds()).padStart(2, '0')}`
    const result = parseVitalityCache(cache(legacy), now)
    expect(result.available).toBe(true)
    expect(result.ageHours).toBeCloseTo(1, 1)
  })
})

describe('diagnoseItems', () => {
  it('applies vetoes, priority boundaries and score rules', () => {
    const items = [
      item('p1-day-7', { ageDays: 7, exposure: '100', views: '0' }),
      item('p1-day-13', { ageDays: 13, exposure: '100', views: '0' }),
      item('p1-threshold', { ageDays: 10, exposure: '1000', views: '8' }),
      item('p2-day-14', { ageDays: 14, exposure: '100', views: '1' }),
      item('protected-pay', { ageDays: 10, exposure: '100', views: '0', payments: '1' }),
      item('protected-inquiry', { ageDays: 10, exposure: '100', views: '0', inquiry: '1' }),
      item('protected-new', { ageDays: 6, exposure: '100', views: '0' }),
      item('protected-sample', { ageDays: 10, exposure: '79', views: '0' }),
      item('protected-round', { ageDays: 10, exposure: '100', views: '0' }),
      item('unknown-metrics', { ageDays: 10, exposure: '', views: '—' }),
      item('non-finite-metrics', { ageDays: 10, exposure: 'Infinity', views: '1' }),
      item('zero-exposure', { ageDays: 10, exposure: '0', views: '0' }),
    ]

    const result = diagnoseItems(items, NOW, { 'protected-round': 2 })

    const priorities = Object.fromEntries(result.candidates.map((row) => [row.itemId, row.priority]))
    expect(priorities['p1-day-7']).toBe('P1')
    expect(priorities['p1-day-13']).toBe('P1')
    expect(priorities['p1-threshold']).toBeNull()
    expect(priorities['p2-day-14']).toBe('P2')
    // 新规则取消曝光<80拦截，低曝光商品也进入候选
    expect(priorities['protected-sample']).toBe('P1')
    expect(priorities['zero-exposure']).toBe('P1')

    const reasons = Object.fromEntries(result.protected.map((row) => [row.itemId, row.protectionReason]))
    expect(reasons['protected-pay']).toBe('PAYMENT_PROTECTION')
    expect(reasons['protected-inquiry']).toBe('INQUIRY_PROTECTION')
    expect(reasons['protected-new']).toBe('NEW_LISTING')
    expect(reasons['protected-round']).toBe('ROUND_LIMIT')

    expect(result.data_incomplete.map((row) => row.itemId).sort()).toEqual([
      'non-finite-metrics',
      'unknown-metrics',
    ])
    expect(result.retest_eligible[0].itemId).toBe('p1-threshold')

    const scores = Object.fromEntries(result.candidates.map((row) => [row.itemId, row.republishScore]))
    expect(scores['p1-day-7']).toBeCloseTo(7 / 0.005, 6)
    expect(scores['zero-exposure']).toBeCloseTo(10 / 0.005, 6)
    expect(scores['p2-day-14']).toBeCloseTo(14 / 0.015, 6)

    const ordered = [...result.candidates].sort((a, b) => b.republishScore - a.republishScore)
    expect(ordered[0].republishScore).toBeGreaterThanOrEqual(ordered.at(-1).republishScore)
  })

  it('keeps records without itemId in data_incomplete without crashing', () => {
    const missing = { ...item('unused', { ageDays: 10, exposure: '500', views: '0' }) }
    delete missing.itemId
    const result = diagnoseItems([missing], NOW)
    expect(result.data_incomplete[0].diagnosticKey).toBe('missing-id-0')
    expect(result.data_incomplete[0].itemId).toBe('')
    expect(result.data_incomplete[0].protectionReason).toBe('ITEM_ID_MISSING')
  })

  it('returns deterministic advice templates', () => {
    const items = [
      item('high-exposure-low-ctr', { ageDays: 10, exposure: '1001', views: '7' }),
      item('mid-exposure-mid-ctr', { ageDays: 15, exposure: '500', views: '5' }),
      item('high-ctr-no-conversion', { ageDays: 15, exposure: '2001', views: '101' }),
    ]
    const result = diagnoseItems(items, NOW)
    const candidates = Object.fromEntries(result.candidates.map((row) => [row.itemId, row]))
    expect(candidates['high-exposure-low-ctr'].advice).toContain('彻底重做首图+重构标题前置词')
    expect(candidates['mid-exposure-mid-ctr'].advice).toContain('微调首图+小幅降价')
    const highCtr = candidates['high-ctr-no-conversion']
    expect(highCtr.protectionReason).toBeNull()
    expect(highCtr.republishScore).toBeGreaterThan(0)
  })

  it('exposes advice constants verbatim', () => {
    expect(ADVICE_HIGH_EXPOSURE_LOW_CTR).toContain('彻底重做首图')
    expect(ADVICE_MID_EXPOSURE_CTR).toContain('微调首图+小幅降价')
  })
})

describe('apiRow', () => {
  it('maps a pool row into the API shape with derived fields', () => {
    const row = {
      itemId: 'x',
      lineageId: 'root',
      title: 't',
      price: '10',
      stock: '1',
      sales: '-',
      createTime: '2026-11-01 00:00:00',
      listingAgeDays: 10,
      priorityLevel: 'P2',
      exposure7d: 500,
      views7d: 5,
      ctr7d: 1,
      inquiryCount: 0,
      orderCount: 0,
      inPoolAt: formatIso(NOW),
      status: 'QUEUING',
      republishRound: 1,
      offlinedAt: '2026-11-23T12:00:00+00:00',
      optimizationStartedAt: null,
      optimizationBaselineCtr: null,
      lastDiagnosis: '建议',
      protectionReason: null,
      dataUpdatedAt: formatIso(NOW),
    }
    const out = apiRow(row, { recovered: true })
    expect(out.republishScore).toBeCloseTo(10 / (1 / 100 + 0.005), 2)
    expect(out.repostAvailableAt).toBeTruthy()
    expect(out.metricsMissing).toBe(false)
    expect(out.recovered).toBe(true)
    expect(out.advice).toBe('建议')
  })
})
