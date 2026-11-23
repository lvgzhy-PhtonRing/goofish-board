// 重发看板服务 —— 由 Python RepublishService 移植。
// 持久化改为整块 JSONB 快照（pool + logs），乐观锁由外层 writeState 负责。
import {
  RepublishError,
  apiRow,
  diagnoseItems,
  emptyDiagnosis,
  formatIso,
  formatLocalDay,
  parseDateTime,
  parseVitalityCache,
} from './republish.js'

const ACTIVE_STATUSES = new Set(['RETESTING', 'QUEUING', 'OFFLINED'])
const TERMINAL_STATUSES = new Set(['REPOSTED', 'CANCELED', 'ARCHIVED'])
const POOL_CAPACITY = 15

function normalizeState(payload) {
  const logs = Array.isArray(payload?.logs) ? payload.logs : []
  const nextLogId = Number.isFinite(payload?.nextLogId)
    ? payload.nextLogId
    : logs.reduce((max, log) => Math.max(max, Number(log?.logId) || 0), 0) + 1
  return {
    pool: payload?.pool && typeof payload.pool === 'object' ? { ...payload.pool } : {},
    logs: [...logs],
    nextLogId,
  }
}

function quotaCounts(state, now) {
  const day = formatLocalDay(now)
  const count = (action) =>
    state.logs.filter((log) => log.action === action && String(log.createdAt || '').slice(0, 10) === day).length
  return [count('NEW_LISTING'), count('REPOST')]
}

function assertQuotaAvailable(newListings, reposts) {
  if (newListings + reposts >= 3 || reposts >= 2) {
    throw new RepublishError('DAILY_LIMIT', '今日发排配额已达安全上限，建议明日再操作。')
  }
}

function quotaView(newListings, reposts) {
  return {
    new_listings_today: newListings,
    reposts_today: reposts,
    remaining_suggested: Math.max(0, 3 - newListings - reposts),
    locked: newListings + reposts >= 3 || reposts >= 2,
  }
}

export function createRepublishStore({ readState, writeState, readVitality }) {
  function log(state, { itemId, relatedItemId = null, title = '', repostRound = 0, action, now, remark = '', data = null }) {
    state.logs.push({
      logId: state.nextLogId++,
      itemId,
      relatedItemId,
      title,
      repostRound,
      action,
      createdAt: formatIso(now),
      remark,
      data: data || {},
    })
  }

  function updateRow(state, item, { status, lineageId, repostRound, now, inPoolAt, protectionReason }) {
    const prev = state.pool[item.itemId] || {}
    const next = {
      itemId: item.itemId,
      lineageId,
      title: item.title ?? '',
      price: item.price ?? '',
      stock: item.stock ?? '',
      sales: item.sales ?? '',
      createTime: item.createTime ?? null,
      listingAgeDays: item.listingAgeDays ?? null,
      priorityLevel: item.priority ?? prev.priorityLevel ?? null,
      exposure7d: Math.trunc(Number(item.exposure7d) || 0),
      views7d: Math.trunc(Number(item.views7d) || 0),
      ctr7d: Number(item.ctr7d) || 0,
      inquiryCount: Math.trunc(Number(item.inquiryCount) || 0),
      orderCount: Math.trunc(Number(item.orderCount) || 0),
      inPoolAt: inPoolAt !== undefined ? inPoolAt : prev.inPoolAt ?? null,
      status,
      republishRound: repostRound,
      offlinedAt: prev.offlinedAt ?? null,
      optimizationStartedAt: prev.optimizationStartedAt ?? null,
      optimizationBaselineCtr: prev.optimizationBaselineCtr ?? null,
      lastDiagnosis: item.advice ?? prev.lastDiagnosis ?? '',
      protectionReason: protectionReason !== undefined ? protectionReason : prev.protectionReason ?? null,
      dataUpdatedAt: formatIso(now),
      picUrl: item.picUrl ?? prev.picUrl ?? '',
    }
    state.pool[item.itemId] = next
    return next
  }

  function syncCandidates(state, diagnosed, now) {
    // 与 Python 一致：状态判断基于进入时的池快照，_updateRow 改动不回流到判断
    const snapshot = Object.fromEntries(
      Object.entries(state.pool).map(([itemId, row]) => [itemId, { ...row }]),
    )
    let activeCount = Object.values(snapshot).filter((row) => ACTIVE_STATUSES.has(row.status)).length
    const waitlist = []

    const byId = (rows) => Object.fromEntries(rows.filter((row) => row.itemId).map((row) => [row.itemId, row]))
    const candidates = byId(diagnosed.candidates)
    const vetoes = byId(diagnosed.protected)
    const incomplete = byId(diagnosed.data_incomplete)
    const observed = byId(diagnosed.observed)

    // 用最新有效快照更新或保护现有非终态记录
    for (const [itemId, row] of Object.entries(snapshot)) {
      if (!ACTIVE_STATUSES.has(row.status) && row.status !== 'PROTECTED') continue
      const item = candidates[itemId] || vetoes[itemId] || incomplete[itemId] || observed[itemId]
      if (!item) {
        if (row.status === 'QUEUING' || row.status === 'RETESTING') {
          const current = state.pool[itemId]
          if (current) {
            current.status = 'PROTECTED'
            current.protectionReason = 'ITEM_NOT_IN_CACHE'
            current.dataUpdatedAt = formatIso(now)
          }
          log(state, {
            itemId,
            title: row.title,
            repostRound: row.republishRound,
            action: 'PROTECT',
            now,
            remark: '商品未出现在最新完整活力缓存中，暂停出库',
          })
          activeCount -= 1
        }
        continue
      }
      if (vetoes[itemId] || incomplete[itemId]) {
        const reason = item.protectionReason || 'METRICS_INCOMPLETE'
        const newStatus =
          row.status === 'OFFLINED' ? 'OFFLINED' : reason === 'ROUND_LIMIT' ? 'ARCHIVED' : 'PROTECTED'
        if (row.status !== newStatus || row.protectionReason !== reason) {
          log(state, {
            itemId,
            title: row.title,
            repostRound: row.republishRound,
            action: newStatus === 'ARCHIVED' ? 'ARCHIVE' : 'PROTECT',
            now,
            remark: reason,
          })
        }
        updateRow(state, item, {
          status: newStatus,
          lineageId: row.lineageId,
          repostRound: row.republishRound,
          now,
          protectionReason: reason,
        })
        if (ACTIVE_STATUSES.has(row.status) && !ACTIVE_STATUSES.has(newStatus)) activeCount -= 1
        continue
      }

      // 保留当前运营状态；刷新指标不得重置静置倒计时
      if (!('priority' in item)) item.priority = row.priorityLevel
      if (row.status === 'PROTECTED' && !candidates[itemId]) item.priority = row.priorityLevel
      updateRow(state, item, {
        status: row.status,
        lineageId: row.lineageId,
        repostRound: row.republishRound,
        now,
        inPoolAt: row.inPoolAt,
        protectionReason: null,
      })

      if (row.status === 'RETESTING' && row.optimizationStartedAt) {
        const started = parseDateTime(row.optimizationStartedAt)
        const elapsed = started ? now.getTime() - started.getTime() : 0
        if (elapsed >= 72 * 3_600_000) {
          const latest = { ...item }
          if (latest.ctr7d >= 1.5) {
            updateRow(state, latest, {
              status: 'PROTECTED',
              lineageId: row.lineageId,
              repostRound: row.republishRound,
              now,
              inPoolAt: row.inPoolAt,
              protectionReason: 'RETEST_PASSED',
            })
            log(state, {
              itemId,
              title: row.title,
              repostRound: row.republishRound,
              action: 'RETEST_PASS',
              now,
              remark: '优化满 72 小时后 CTR 已回升至 1.5% 或以上',
            })
            activeCount -= 1
          } else {
            latest.priority = 'P2'
            latest.advice = '【P2 | 复测失败】优化满 3 天后 CTR 仍低于 1.5%，可进入重发队列。'
            updateRow(state, latest, {
              status: 'QUEUING',
              lineageId: row.lineageId,
              repostRound: row.republishRound,
              now,
              inPoolAt: formatIso(now),
              protectionReason: null,
            })
            log(state, {
              itemId,
              title: row.title,
              repostRound: row.republishRound,
              action: 'RETEST_FAIL',
              now,
              remark: '优化满 72 小时后 CTR 仍低于 1.5%',
              data: { ctr7d: latest.ctr7d, baselineCtr: row.optimizationBaselineCtr },
            })
          }
        }
      }
    }

    // 按重发更新指数降序入池
    const ordered = [...diagnosed.candidates].sort(
      (a, b) => (b.republishScore || 0) - (a.republishScore || 0),
    )
    for (const item of ordered) {
      const itemId = item.itemId
      const row = snapshot[itemId]
      if (row && TERMINAL_STATUSES.has(row.status)) continue
      if (row && ACTIVE_STATUSES.has(row.status)) continue
      if (activeCount >= POOL_CAPACITY) {
        waitlist.push(item)
        continue
      }
      const lineage = row ? row.lineageId : itemId
      const repostRound = row ? row.republishRound || 0 : 0
      const reentry = Boolean(row && row.status === 'PROTECTED')
      updateRow(state, item, {
        status: 'QUEUING',
        lineageId: lineage,
        repostRound,
        now,
        inPoolAt: reentry ? row.inPoolAt || formatIso(now) : formatIso(now),
      })
      if (reentry) {
        log(state, {
          itemId,
          title: item.title || '',
          repostRound,
          action: 'REENTRY',
          now,
          remark: '保护条件解除且仍符合入池条件',
        })
      }
      activeCount += 1
    }

    return waitlist
  }

  function buildDashboard(state, diagnosed, waitlist, cache, now) {
    const stored = Object.values(state.pool)
    const bucket = (status) => stored.filter((row) => row.status === status).map((row) => apiRow(row))

    const blockedOptimization = new Set(
      stored
        .filter((row) => ACTIVE_STATUSES.has(row.status) || TERMINAL_STATUSES.has(row.status))
        .map((row) => row.itemId),
    )
    const optimizationCandidates = cache.available
      ? diagnosed.retest_eligible.filter((row) => !blockedOptimization.has(row.itemId))
      : []

    const recoveredIds = new Set(
      diagnosed.observed.filter((row) => now.getDay() === 0 && row.ctr7d >= 1.5).map((row) => row.itemId),
    )

    const queue = stored
      .filter((row) => row.status === 'QUEUING')
      .map((row) => apiRow(row, { recovered: recoveredIds.has(row.itemId) }))
    queue.sort((a, b) => (b.republishScore || 0) - (a.republishScore || 0))

    const protectedMap = new Map()
    for (const row of diagnosed.protected) {
      const key = row.diagnosticKey || row.itemId
      if (key && !protectedMap.has(key)) protectedMap.set(key, row)
    }
    for (const row of bucket('PROTECTED')) {
      if (!protectedMap.has(row.itemId)) protectedMap.set(row.itemId, row)
    }
    for (const row of diagnosed.data_incomplete) {
      const key = row.diagnosticKey || row.itemId
      if (key && !protectedMap.has(key)) protectedMap.set(key, row)
    }
    const protectedList = [...protectedMap.values()]

    const [newListings, reposts] = quotaCounts(state, now)
    const retesting = stored
      .filter((row) => row.status === 'RETESTING')
      .map((row) => apiRow(row, { recovered: recoveredIds.has(row.itemId) }))
    const offlined = bucket('OFFLINED')

    const picById = {}
    if (cache.available) {
      for (const item of cache.items) {
        if (item && item.itemId) picById[String(item.itemId)] = String(item.picUrl || '')
      }
    }
    for (const rows of [queue, retesting, offlined, protectedList, optimizationCandidates, waitlist]) {
      for (const row of rows) {
        if (!row.picUrl) row.picUrl = picById[String(row.itemId || '')] || ''
      }
    }

    return {
      data_status: {
        available: cache.available,
        reason: cache.reason,
        range: cache.range || '7',
        complete: cache.complete || false,
        fetched_at: cache.fetchedAt ?? null,
        age_hours: cache.ageHours ?? null,
      },
      quota: quotaView(newListings, reposts),
      top_action_queue: queue.slice(0, 3),
      queue,
      retesting,
      optimization_candidates: optimizationCandidates,
      offlined,
      protected: protectedList,
      capacity_waitlist: waitlist,
    }
  }

  async function mutate(fn) {
    let lastError = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { payload, revision } = await readState()
      const state = normalizeState(payload)
      const result = await fn(state)
      try {
        await writeState(state, revision)
        return result
      } catch (error) {
        if (error?.code === 'CLOUD_REVISION_CONFLICT') {
          lastError = error
          continue
        }
        throw error
      }
    }
    throw lastError || new RepublishError('CLOUD_REVISION_CONFLICT', '云端数据已被其他设备更新，请重试')
  }

  async function getDashboard(now = new Date()) {
    const cache = parseVitalityCache(await readVitality(), now)
    if (!cache.available) {
      const { payload } = await readState()
      return buildDashboard(normalizeState(payload), emptyDiagnosis(), [], cache, now)
    }
    const { state, diagnosed, waitlist } = await mutate(async (draft) => {
      const roundById = {}
      for (const row of Object.values(draft.pool)) roundById[row.itemId] = row.republishRound || 0
      const diagnosis = diagnoseItems(cache.items, now, roundById)
      const waiting = syncCandidates(draft, diagnosis, now)
      return { state: draft, diagnosed: diagnosis, waitlist: waiting }
    })
    return buildDashboard(state, diagnosed, waitlist, cache, now)
  }

  async function startOptimization(itemId, now = new Date()) {
    const cache = parseVitalityCache(await readVitality(), now)
    if (!cache.available) {
      throw new RepublishError('DATA_UNAVAILABLE', '需要新鲜、完整的近 7 天商品活力数据才能开始复测。')
    }
    return mutate(async (state) => {
      const old = state.pool[itemId]
      if (old && ['RETESTING', 'OFFLINED', ...TERMINAL_STATUSES].includes(old.status)) {
        throw new RepublishError('INVALID_STATE', '该商品当前状态不能开始 3 天复测。')
      }
      const roundById = {}
      for (const row of Object.values(state.pool)) roundById[row.itemId] = row.republishRound || 0
      const diagnosed = diagnoseItems(cache.items, now, roundById)
      const item = diagnosed.retest_eligible.find((row) => row.itemId === itemId)
      if (!item) {
        throw new RepublishError(
          'NOT_ELIGIBLE',
          '仅 7 至不足 14 天、CTR 为 0.8% 至不足 1.5% 且无否决项的商品可开始复测。',
        )
      }
      const active = Object.values(state.pool).filter((row) => ACTIVE_STATUSES.has(row.status)).length
      if (active >= POOL_CAPACITY) {
        throw new RepublishError('POOL_FULL', '重发池已满（15 件），当前不能开始复测。')
      }
      const lineageId = old ? old.lineageId : itemId
      const repostRound = old ? old.republishRound || 0 : roundById[itemId] || 0
      const startedAt = formatIso(now)
      state.pool[itemId] = {
        ...(old || {}),
        itemId,
        lineageId,
        title: item.title,
        price: item.price,
        stock: item.stock,
        sales: item.sales,
        createTime: item.createTime,
        listingAgeDays: item.listingAgeDays,
        priorityLevel: 'P2',
        exposure7d: item.exposure7d,
        views7d: item.views7d,
        ctr7d: item.ctr7d,
        inquiryCount: item.inquiryCount,
        orderCount: item.orderCount,
        inPoolAt: old?.inPoolAt || null,
        status: 'RETESTING',
        republishRound: repostRound,
        offlinedAt: old?.offlinedAt || null,
        optimizationStartedAt: startedAt,
        optimizationBaselineCtr: item.ctr7d,
        lastDiagnosis: item.advice,
        protectionReason: null,
        dataUpdatedAt: startedAt,
        picUrl: old?.picUrl || '',
      }
      log(state, {
        itemId,
        title: item.title,
        repostRound,
        action: 'OPTIMIZE',
        now,
        remark: '原位优化已标记，开始 72 小时复测',
        data: { baselineCtr: item.ctr7d },
      })
      return apiRow(state.pool[itemId])
    })
  }

  async function recordNewListing(now = new Date()) {
    return mutate(async (state) => {
      const [newListings, reposts] = quotaCounts(state, now)
      assertQuotaAvailable(newListings, reposts)
      log(state, { itemId: null, action: 'NEW_LISTING', now, remark: '用户确认记录一件真实上新' })
      const [afterNew, afterReposts] = quotaCounts(state, now)
      return quotaView(afterNew, afterReposts)
    })
  }

  async function confirmOffline(itemId, { offlineConfirmed, materialsPrepared } = {}, now = new Date()) {
    if (!offlineConfirmed || !materialsPrepared) {
      throw new RepublishError('CHECKLIST_REQUIRED', '请先确认已在闲鱼下架且新版首图/标题已准备。')
    }
    const cache = parseVitalityCache(await readVitality(), now)
    if (!cache.available) {
      throw new RepublishError('DATA_UNAVAILABLE', '需要新鲜、完整的近 7 天数据才能开始下架静置。')
    }
    const diagnosed = diagnoseItems(cache.items, now)
    const candidate = diagnosed.candidates.find((row) => row.itemId === itemId)
    const retestCandidate = diagnosed.retest_eligible.find((row) => row.itemId === itemId)

    return mutate(async (state) => {
      const [newListings, reposts] = quotaCounts(state, now)
      assertQuotaAvailable(newListings, reposts)
      const row = state.pool[itemId]
      if (!row || row.status !== 'QUEUING') {
        throw new RepublishError('INVALID_STATE', '该商品不在排队状态，不能确认下架静置。')
      }
      let resolved = candidate
      if (!resolved) {
        const failedRetest = state.logs.some((entry) => entry.itemId === itemId && entry.action === 'RETEST_FAIL')
        if (retestCandidate && row.priorityLevel === 'P2' && failedRetest) {
          resolved = { ...retestCandidate, priority: 'P2' }
        } else {
          throw new RepublishError('NOT_ELIGIBLE', '该商品当前不符合重发候选条件。')
        }
      }
      const merged = {
        ...resolved,
        priority: row.priorityLevel || resolved.priority,
        advice: resolved.advice || row.lastDiagnosis || '',
      }
      updateRow(state, merged, {
        status: 'OFFLINED',
        lineageId: row.lineageId,
        repostRound: row.republishRound,
        now,
        inPoolAt: row.inPoolAt,
      })
      state.pool[itemId].offlinedAt = formatIso(now)
      log(state, {
        itemId,
        title: row.title,
        repostRound: row.republishRound,
        action: 'OFFLINE',
        now,
        remark: '用户确认闲鱼端已下架且新版物料已准备',
      })
      return apiRow(state.pool[itemId])
    })
  }

  async function confirmRepost(itemId, newItemId, now = new Date()) {
    const nextId = String(newItemId || '').trim()
    if (!nextId || nextId.length > 64 || nextId === itemId) {
      throw new RepublishError('INVALID_NEW_ITEM_ID', '请输入不同于旧商品且有效的新商品 ID。')
    }
    const cache = parseVitalityCache(await readVitality(), now)
    return mutate(async (state) => {
      const old = state.pool[itemId]
      if (!old || old.status !== 'OFFLINED') {
        throw new RepublishError('INVALID_STATE', '该商品未处于下架静置状态。')
      }
      const offlinedAt = parseDateTime(old.offlinedAt)
      if (!offlinedAt) {
        throw new RepublishError('OFFLINE_TIME_INVALID', '缺少有效的下架时间，不能确认重发。')
      }
      if (now.getTime() - offlinedAt.getTime() < 24 * 3_600_000) {
        throw new RepublishError('COOLDOWN_ACTIVE', '下架静置未满 24 小时，暂不能确认重发。')
      }
      const [newListings, reposts] = quotaCounts(state, now)
      assertQuotaAvailable(newListings, reposts)
      if (state.pool[nextId]) {
        throw new RepublishError('ITEM_ID_EXISTS', '新商品 ID 已存在于重发履历中。')
      }
      if (cache.available && cache.items.some((item) => String(item?.itemId || '').trim() === nextId)) {
        throw new RepublishError('ITEM_ID_EXISTS', '新商品 ID 已存在于当前活力数据中。')
      }

      const newRound = (old.republishRound || 0) + 1
      if (newRound > 2) {
        throw new RepublishError('ROUND_LIMIT', '该商品 lineage 已达到两轮重发上限。')
      }
      const lineageId = old.lineageId
      const newStatus = newRound >= 2 ? 'ARCHIVED' : 'PROTECTED'
      const newReason = newRound >= 2 ? 'ROUND_LIMIT' : 'WAITING_NEW_LISTING_DATA'
      old.status = 'REPOSTED'
      old.republishRound = newRound
      old.dataUpdatedAt = formatIso(now)
      state.pool[nextId] = {
        itemId: nextId,
        lineageId,
        title: old.title,
        price: old.price,
        stock: old.stock,
        sales: old.sales,
        createTime: null,
        listingAgeDays: 0,
        priorityLevel: null,
        exposure7d: 0,
        views7d: 0,
        ctr7d: 0,
        inquiryCount: 0,
        orderCount: 0,
        inPoolAt: null,
        status: newStatus,
        republishRound: newRound,
        offlinedAt: null,
        optimizationStartedAt: null,
        optimizationBaselineCtr: null,
        lastDiagnosis: '',
        protectionReason: newReason,
        dataUpdatedAt: formatIso(now),
        picUrl: old.picUrl || '',
      }
      log(state, {
        itemId,
        relatedItemId: nextId,
        title: old.title,
        repostRound: newRound,
        action: 'REPOST',
        now,
        remark: '用户确认新版已在闲鱼上架',
      })
      if (newRound >= 2) {
        log(state, {
          itemId: nextId,
          title: old.title,
          repostRound: newRound,
          action: 'ARCHIVE',
          now,
          remark: 'lineage 已达到两轮重发上限',
        })
      }
      return apiRow(state.pool[nextId])
    })
  }

  async function cancelItem(itemId, now = new Date()) {
    if (now.getDay() !== 0) {
      throw new RepublishError('REVIEW_DAY_ONLY', '数据回升复核只在星期日开放移出操作。')
    }
    const cache = parseVitalityCache(await readVitality(), now)
    if (!cache.available) {
      throw new RepublishError('DATA_UNAVAILABLE', '需要新鲜、完整的近 7 天数据才能复核回升。')
    }
    const observed = diagnoseItems(cache.items, now).observed.find((row) => row.itemId === itemId)
    if (!observed || observed.ctr7d < 1.5) {
      throw new RepublishError('NOT_RECOVERED', '当前没有有效数据证明点击率已回升至 1.5%。')
    }
    return mutate(async (state) => {
      const row = state.pool[itemId]
      if (!row || !['QUEUING', 'RETESTING'].includes(row.status)) {
        throw new RepublishError('INVALID_STATE', '只有排队中或复测中的商品可以因数据回升而移出。')
      }
      row.status = 'CANCELED'
      row.protectionReason = 'CTR_RECOVERED'
      row.dataUpdatedAt = formatIso(now)
      log(state, {
        itemId,
        title: row.title,
        repostRound: row.republishRound,
        action: 'CANCEL',
        now,
        remark: '星期日复核：近 7 天 CTR 已回升至 1.5% 或以上',
      })
      return apiRow(row)
    })
  }

  return {
    getDashboard,
    startOptimization,
    recordNewListing,
    confirmOffline,
    confirmRepost,
    cancelItem,
  }
}
