// 重发看板规则引擎 —— 由 Python src/services/republish_service.py 逐条移植。
// 语义基准：Python 代码 + tests/test_republish_service.py（PRD 与代码冲突时以代码为准）。

export const MAX_CACHE_AGE_HOURS = 36

export class RepublishError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RepublishError'
    this.code = code
  }
}

const PLACEHOLDERS = new Set(['—', '-', 'N/A', '暂无'])

/** 解析活力计数字段；空白、占位符、非有限数和负数都视为未知。 */
export function parseNumber(value) {
  if (value === null || value === undefined) return null
  const text = String(value).trim().replace(/,/g, '')
  if (!text || PLACEHOLDERS.has(text)) return null
  const number = Number(text)
  if (!Number.isFinite(number) || number < 0) return null
  return number
}

/** 兼容 "YYYY-MM-DD HH:mm:ss"、"YYYY-MM-DDTHH:mm:ss"、带 Z/偏移的 ISO。 */
export function parseDateTime(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const text = value.trim()
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? `${text}T00:00:00`
    : text.includes('T')
      ? text
      : text.replace(' ', 'T')
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/** 本地时区 ISO-8601（秒精度，带偏移），等价 Python isoformat(timespec="seconds")。 */
export function formatIso(date) {
  const pad = (n) => String(n).padStart(2, '0')
  const offsetMin = -date.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const hours = pad(Math.floor(Math.abs(offsetMin) / 60))
  const minutes = pad(Math.abs(offsetMin) % 60)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${hours}:${minutes}`
  )
}

/** 本地日期 YYYY-MM-DD（用于每日配额）。 */
export function formatLocalDay(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 上架天数：本地日期差；未来时间或不可解析返回 null。 */
export function listingAgeDays(value, now) {
  if (typeof value !== 'string' || !value.trim()) return null
  const created = parseDateTime(value)
  if (!created) return null
  const age = Math.round((startOfLocalDay(now) - startOfLocalDay(created)) / 86_400_000)
  return age >= 0 ? age : null
}

export const ADVICE_HIGH_EXPOSURE_LOW_CTR =
  '【建议彻底重做首图+重构标题前置词】平台已给大量曝光但买家不点。' +
  '重发时首图必须更换全新拍摄角度或背景，标题最前方更换为最热门搜索词。'

export const ADVICE_MID_EXPOSURE_CTR =
  '【建议微调首图+小幅降价】链接处于正常衰退期。新版本建议更换局部细节特写图为首图，' +
  '价格向下微调 3~5 元增加让利吸引力。'

/** 诊断建议（纯本地确定性模板）。 */
export function diagnosticAdvice(exposure, ctr, priority) {
  if (exposure > 1000 && ctr < 0.8) return ADVICE_HIGH_EXPOSURE_LOW_CTR
  if (exposure >= 200 && exposure <= 800 && ctr >= 0.8 && ctr < 1.5) return ADVICE_MID_EXPOSURE_CTR
  if (priority === 'P1') return '建议更换首图并重构标题前置词，先解决点击率偏低问题。'
  return '建议优化首图与标题后复测，关注近 7 天点击率变化。'
}

/**
 * 校验活力缓存：必须完整、range=7、fetched_at 可解析且不超过 36 小时。
 * raw 可为 JSON 字符串或已解析对象。fetched_at 无时区按浏览器本地时区解释。
 */
export function parseVitalityCache(raw, now) {
  if (raw === null || raw === undefined) return { available: false, reason: 'CACHE_UNAVAILABLE' }
  let data = raw
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw)
    } catch {
      return { available: false, reason: 'CACHE_UNAVAILABLE' }
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { available: false, reason: 'CACHE_INVALID' }
  }
  if (String(data.range) !== '7') return { available: false, reason: 'RANGE_NOT_7D' }
  if (data.complete !== true) return { available: false, reason: 'CACHE_INCOMPLETE' }
  if (!Array.isArray(data.vitality)) return { available: false, reason: 'CACHE_INVALID' }
  if (typeof data.fetched_at !== 'string') return { available: false, reason: 'TIMESTAMP_INVALID' }
  const fetchedAt = parseDateTime(data.fetched_at)
  if (!fetchedAt) return { available: false, reason: 'TIMESTAMP_INVALID' }

  const ageMs = now.getTime() - fetchedAt.getTime()
  if (ageMs < 0) return { available: false, reason: 'TIMESTAMP_IN_FUTURE' }
  if (ageMs > MAX_CACHE_AGE_HOURS * 3_600_000) return { available: false, reason: 'CACHE_STALE' }

  return {
    available: true,
    reason: null,
    range: '7',
    complete: true,
    fetchedAt: formatIso(fetchedAt),
    ageHours: ageMs / 3_600_000,
    items: data.vitality,
  }
}

export function emptyDiagnosis() {
  return {
    candidates: [],
    retest_eligible: [],
    protected: [],
    data_incomplete: [],
    observed: [],
  }
}

/**
 * 按本地规则把商品分为重发候选、3 天复测、保护项和数据不足项。
 * 规则优先级：完整指标 → 否决 → 指数/优先级；顺序不可颠倒。
 */
export function diagnoseItems(items, now, roundById = {}) {
  const result = emptyDiagnosis()

  items.forEach((item, index) => {
    const itemId = String(item?.itemId ?? '').trim()
    if (!itemId) {
      result.data_incomplete.push({
        ...item,
        itemId: '',
        diagnosticKey: `missing-id-${index}`,
        protectionReason: 'ITEM_ID_MISSING',
      })
      return
    }

    const ageDays = listingAgeDays(item.createTime, now)
    const exposure = parseNumber(item.exposure)
    const views = parseNumber(item.viewCount)
    const inquiries = parseNumber(item.inquiry)
    const payments = parseNumber(item.payCount)

    let repostRound = 0
    const rawRound = roundById[itemId]
    if (rawRound !== undefined && rawRound !== null) {
      const parsed = Number(rawRound)
      repostRound = Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0
    }

    const base = {
      itemId,
      title: String(item.title ?? ''),
      price: item.price ?? '',
      stock: item.stock ?? '',
      sales: item.sales ?? '',
      createTime: item.createTime ?? '',
      listingAgeDays: ageDays,
      exposure7d: exposure,
      views7d: views,
      inquiryCount: inquiries,
      orderCount: payments,
      republishRound: repostRound,
    }

    // 一票否决：支付/询单保护、新品保护、两轮止损
    let vetoReason = null
    if (payments !== null && payments > 0) vetoReason = 'PAYMENT_PROTECTION'
    else if (inquiries !== null && inquiries > 0) vetoReason = 'INQUIRY_PROTECTION'
    else if (ageDays !== null && ageDays < 7) vetoReason = 'NEW_LISTING'
    else if (repostRound >= 2) vetoReason = 'ROUND_LIMIT'
    if (vetoReason) {
      result.protected.push({ ...base, protectionReason: vetoReason, advice: '' })
      return
    }

    if (ageDays === null || [exposure, views, inquiries, payments].some((v) => v === null)) {
      result.data_incomplete.push({ ...base, protectionReason: 'METRICS_INCOMPLETE' })
      return
    }

    // 重发更新指数 = 上架天数 / (CTR + 0.005)，CTR 用小数（0.015 = 1.5%）
    const ctrDecimal = exposure > 0 ? views / exposure : 0
    const score = ageDays / (ctrDecimal + 0.005)
    const ctrPct = ctrDecimal * 100
    const classified = {
      ...base,
      ctr7d: ctrPct,
      republishScore: score,
      protectionReason: null,
    }
    result.observed.push(classified)

    // 优先级仅作展示标签，排序一律按重发更新指数
    let priority = null
    if (ageDays >= 7 && ageDays < 14 && ctrPct < 0.8) priority = 'P1'
    else if (ageDays >= 14 && ctrPct < 1.5) priority = 'P2'

    result.candidates.push({
      ...classified,
      priority,
      advice: diagnosticAdvice(exposure, ctrPct, priority),
    })

    // 3 天原位复测：7–13 天、CTR 0.8%–1.5% 的子集
    if (ageDays >= 7 && ageDays < 14 && ctrPct >= 0.8 && ctrPct < 1.5) {
      result.retest_eligible.push({
        ...classified,
        advice: diagnosticAdvice(exposure, ctrPct, 'P2'),
      })
    }
  })

  return result
}

/** 池行 → API 输出对象（等价 Python _api_row）。 */
export function apiRow(row, { recovered = false } = {}) {
  let repostAvailableAt = null
  if (row.offlinedAt) {
    const offlined = parseDateTime(row.offlinedAt)
    if (offlined) repostAvailableAt = formatIso(new Date(offlined.getTime() + 24 * 3_600_000))
  }
  const age = row.listingAgeDays || 0
  const ctrPct = row.ctr7d || 0
  const score = age ? age / (ctrPct / 100 + 0.005) : 0
  return {
    itemId: row.itemId,
    lineageId: row.lineageId,
    title: row.title,
    price: row.price,
    stock: row.stock,
    sales: row.sales,
    createTime: row.createTime,
    listingAgeDays: row.listingAgeDays,
    priority: row.priorityLevel,
    republishScore: Math.round(score * 100) / 100,
    exposure7d: row.exposure7d,
    views7d: row.views7d,
    ctr7d: row.ctr7d,
    inquiryCount: row.inquiryCount,
    orderCount: row.orderCount,
    inPoolAt: row.inPoolAt,
    status: row.status,
    republishRound: row.republishRound,
    offlinedAt: row.offlinedAt,
    repostAvailableAt,
    optimizationStartedAt: row.optimizationStartedAt,
    optimizationBaselineCtr: row.optimizationBaselineCtr,
    protectionReason: row.protectionReason,
    advice: row.lastDiagnosis || '',
    metricsMissing: ['WAITING_NEW_LISTING_DATA', 'METRICS_INCOMPLETE'].includes(row.protectionReason),
    recovered,
    picUrl: row.picUrl || '',
  }
}
