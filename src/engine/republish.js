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

const BRAND_HINTS = [
  'HOT WHEELS',
  '风火轮',
  'MINIGT',
  'TLV',
  'TOMICA',
  '多美卡',
  'RLC',
  '京商',
  'KYOSHO',
  'FIRST',
  '保时捷',
  '兰博基尼',
  '日产',
  '丰田',
  '奔驰',
  '宝马',
  '法拉利',
]

function hashText(value) {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  return hash
}

function numberText(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number) : 0
}

function percentText(value) {
  const number = Number(value)
  return Number.isFinite(number) ? `${Math.round(number * 10) / 10}%` : '0%'
}

/** 从标题提取品牌/车型词，供建议文案引用；确定性，不调用外部服务。 */
function keywordFromTitle(title) {
  let text = String(title || '')
    .replace(/【[^】]*】/g, ' ')
    .replace(/[#☆★✦]/g, ' ')
    .replace(/([^\d])\/([^\d])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return '品牌词'
  const upper = text.toUpperCase()
  let start = -1
  for (const brand of BRAND_HINTS) {
    const index = upper.indexOf(brand.toUpperCase())
    if (index >= 0) {
      start = index
      break
    }
  }
  let phrase = (start >= 0 ? text.slice(start) : text).trim()
  if (phrase.length > 22) phrase = phrase.slice(0, 22).trim()
  phrase = phrase.replace(/\s+\d{1,4}$/, '').trim()
  return phrase || '品牌词'
}

function priceHint(price) {
  const number = Number(price)
  if (!Number.isFinite(number) || number <= 0) return ''
  if (number < 100) return `当前 ¥${Math.round(number)} 属低客单，优先换首图拿点击，不必再降价。`
  if (number < 500) return `当前 ¥${Math.round(number)} 属中客单，可小幅降价 3~5 元配合新首图。`
  return `当前 ¥${Math.round(number)} 属高客单，首图要突出编号/成色/细节，降价要谨慎。`
}

/** 诊断建议：按分层 + 曝光/点击/年龄/标题关键词/价格带生成确定性个性化文案。 */
export function diagnosticAdvice(input, ctrArg, priorityArg) {
  const ctx = typeof input === 'object' && input !== null ? input : { exposure: input, ctr: ctrArg, priority: priorityArg }
  const exposure = Number(ctx.exposure) || 0
  const views = Number(ctx.views) || 0
  const ctr = Number(ctx.ctr) || 0
  const ageDays = ctx.ageDays === null || ctx.ageDays === undefined ? null : Number(ctx.ageDays)
  const keyword = keywordFromTitle(ctx.title)
  const queueKind = ctx.queueKind || classifyQueueKind(exposure, ctr)
  const exp = numberText(exposure)
  const browse = numberText(views)
  const c = percentText(ctr)
  const age = ageDays === null ? '—' : numberText(ageDays)
  const engage = `近 7 天曝光 ${exp} 次、浏览 ${browse} 次（点击率 ${c}）`
  const ageText =
    ageDays === null
      ? ''
      : ageDays >= 180
        ? `上架 ${age} 天，属于老链接`
        : ageDays >= 30
          ? `上架 ${age} 天，已过新品期`
          : `上架 ${age} 天，仍在观察期`
  const priceText = priceHint(ctx.price)

  let templates
  if (queueKind === 'high_exposure') {
    templates = [
      ADVICE_HIGH_EXPOSURE_LOW_CTR + `你这件${engage}，问题在首图/标题，不在曝光量。`,
      `【建议彻底重做首图+重构标题前置词】${exp} 次曝光只换来 ${browse} 次点击（${c}），买家看到了却不点。` +
        `首图换新角度，标题最前面放「${keyword}」。`,
      `【建议彻底重做首图+重构标题前置词】${engage}。先别改价，优先重拍首图，` +
        `并把「${keyword}」放到标题前 12 字，重发后 72 小时复测。${priceText}`,
      `【建议彻底重做首图+重构标题前置词】平台给了 ${exp} 次曝光，点击率只有 ${c}（${browse} 次点击）。` +
        `先换首图，再把「${keyword}」放到标题最前；不要只改价格。`,
    ]
  } else if (queueKind === 'reborn') {
    templates = [
      ADVICE_MID_EXPOSURE_CTR + `你这件${engage}，属于典型衰退。`,
      `【建议微调首图+小幅降价】${engage}，有曝光但点击不足。首图换成局部细节特写，` +
        `标题前置「${keyword}」，价格下调 3~5 元后重发。`,
      `【建议微调首图+小幅降价】${ageText}，${engage}。先改标题前置词为「${keyword}」，` +
        `再小幅降价，不必重做详情。`,
      `【建议微调首图+小幅降价】${engage}，点击率低于 1.5%。把「${keyword}」放到标题前 12 字，` +
        `首图换细节特写，价格降 3~5 元。`,
    ]
  } else if (queueKind === 'activate') {
    templates = [
      `曝光只有 ${exp} 次（浏览 ${browse} 次），说明还没进入推荐池。先把标题前 12 字改成「${keyword}」，` +
        `再换一张干净白底首图，重发后观察 3 天。`,
      `${ageText}，仅 ${exp} 次曝光，属于「未被看到」。重发前补全品牌/编号/车型关键词（如「${keyword}」），` +
        `首图换成正面 45° 实拍。`,
      `当前曝光 ${exp}、点击率 ${c}（${browse}/${exp}）。低曝光阶段先别降价，` +
        `优先用「${keyword}」重写标题并换首图，争取第一波推荐。`,
      `这件 ${age} 天的链接几乎没曝光（${exp} 次）。建议保留价格，先换首图+把「${keyword}」放到标题最前，` +
        `再重发测试 72 小时。${priceText}`,
      `这件链接不是点击问题，而是曝光太少（${exp} 次）。重发前只做两件事：标题前 12 字放「${keyword}」，` +
        `首图换白底正面；价格先不动。`,
      `近 7 天只有 ${exp} 次曝光，说明系统还没给你推荐位。建议按「品牌+编号+车型」重写标题（参考「${keyword}」），` +
        `并换一张更干净的首图。`,
      `${ageText || '这件链接'}，曝光 ${exp} 次。老链接重发前必须换首图/标题，否则容易被判重复内容；` +
        `关键词建议前置「${keyword}」。`,
    ]
  } else if (queueKind === 'healthy') {
    return `点击率 ${c}（${browse}/${exp}）属健康区间，建议改价格/详情或等自然成交，不做重发。`
  } else if (priorityArg === 'P1' || ctx.priority === 'P1') {
    templates = [
      `上架 ${age} 天、点击率 ${c}，先换首图并改标题前置词为「${keyword}」，重发后 3 天复测。`,
      `点击率 ${c} 偏低，建议换全新首图+标题前置「${keyword}」，先观察 72 小时再决定是否降价。`,
    ]
  } else {
    templates = [
      '建议优化首图与标题后复测，关注近 7 天点击率变化。',
      `建议换一张新首图，并把「${keyword}」放到标题前 12 字，重发后观察 3 天。`,
    ]
  }

  const index =
    hashText(`${ctx.itemId || ''}|${queueKind}|${ctx.title || ''}|${exposure}|${ctr}`) % templates.length
  return templates[index]
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
    healthy: [],
  }
}

export const QUEUE_LAYERS = {
  high_exposure: { label: '高曝光低点击', order: 0, tone: 'bg-rose-100 text-rose-700' },
  reborn: { label: '正常衰退', order: 1, tone: 'bg-amber-100 text-amber-800' },
  activate: { label: '待激活（低曝光）', order: 2, tone: 'bg-slate-100 text-slate-600' },
  healthy: { label: '点击健康', order: 3, tone: 'bg-emerald-100 text-emerald-700' },
}

/** 按曝光与点击率分层：只有前 3 层进入重发候选，健康商品不重发。 */
export function classifyQueueKind(exposure, ctrPct) {
  if (exposure >= 1000 && ctrPct < 0.8) return 'high_exposure'
  if (exposure >= 100 && exposure < 1000 && ctrPct < 1.5) return 'reborn'
  if (exposure < 100) return 'activate'
  return 'healthy'
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

    // 曝光分层：健康商品不进重发候选，但仍可进入 3 天复测路径
    const queueKind = classifyQueueKind(exposure, ctrPct)

    // 优先级仅作展示标签，排序一律按重发更新指数
    let priority = null
    if (ageDays >= 7 && ageDays < 14 && ctrPct < 0.8) priority = 'P1'
    else if (ageDays >= 14 && ctrPct < 1.5) priority = 'P2'

    const candidateData = {
      ...classified,
      priority,
      queueKind,
      advice: diagnosticAdvice({
        itemId,
        title: item.title,
        price: item.price,
        exposure,
        views,
        ctr: ctrPct,
        ageDays,
        queueKind,
        priority,
      }),
    }
    if (queueKind === 'healthy') {
      result.healthy.push(candidateData)
    } else {
      result.candidates.push(candidateData)
    }

    // 3 天原位复测：7–13 天、CTR 0.8%–1.5% 的子集
    if (ageDays >= 7 && ageDays < 14 && ctrPct >= 0.8 && ctrPct < 1.5) {
      result.retest_eligible.push({
        ...classified,
        advice: diagnosticAdvice({
          itemId,
          title: item.title,
          price: item.price,
          exposure,
          views,
          ctr: ctrPct,
          ageDays,
          queueKind,
          priority: 'P2',
        }),
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
    queueKind: row.queueKind || null,
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
