<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { createCloudStore } from '../../services/cloudState.js'
import { createRepublishStore } from '../../engine/republishStore.js'
import { fetchShopStatus, insertEvent } from '../../services/automationApi.js'
import { loadRow } from '../../services/supabaseClient.js'
import { sourceMeta } from '../../services/dataSources.js'
import PendingPanel from './PendingPanel.vue'
import ProductThumb from '../../components/ProductThumb.vue'

const props = defineProps({
  config: { type: Object, required: true },
  session: { type: Object, default: null },
  onSession: { type: Function, default: null },
})

const cloud = createCloudStore({
  config: props.config,
  getSession: () => props.session,
  onSession: props.onSession || undefined,
})
const store = createRepublishStore(cloud)

const dashboard = ref(null)
const activeTab = ref('queue')
const isLoading = ref(true)
const pageError = ref('')
const actionKey = ref('')
const tick = ref(Date.now())
const skipped = ref(new Set())
const checklist = ref({})
const repostDialogOpen = ref(false)
const repostTarget = ref(null)
const newItemId = ref('')
const toastMessage = ref('')
const toastTone = ref('success')
const manualOpen = ref(false)
const manualLoading = ref(false)
const manualError = ref('')
const manualKeyword = ref('')
const manualDate = ref('')
const manualItems = ref([])

let clockTimer
let toastTimer

const topQueue = computed(() =>
  (dashboard.value?.queue || []).filter((item) => !skipped.value.has(item.itemId)).slice(0, 3),
)
const quota = computed(() => dashboard.value?.quota)
const dataStatus = computed(() => dashboard.value?.data_status)
const poolIsFull = computed(() => {
  if (!dashboard.value) return false
  return dashboard.value.queue.length + dashboard.value.retesting.length >= 15
})

const statusReason = {
  CACHE_UNAVAILABLE: '本地尚未推送活力数据',
  CACHE_INVALID: '活力数据格式无效',
  RANGE_NOT_7D: '活力数据不是近 7 天口径',
  CACHE_INCOMPLETE: '活力数据不完整（部分页未抓满）',
  TIMESTAMP_INVALID: '数据时间无法解析',
  TIMESTAMP_IN_FUTURE: '数据时间在未来，已按过期处理',
  CACHE_STALE: '活力数据已超过 36 小时',
}

const reasonText = {
  PAYMENT_PROTECTION: '近 7 天有支付，保护',
  INQUIRY_PROTECTION: '近 7 天有询单，保护',
  NEW_LISTING: '上架不足 7 天，新品保护',
  ROUND_LIMIT: '已达两轮重发止损',
  METRICS_INCOMPLETE: '指标缺失，数据不足',
  ITEM_ID_MISSING: '缺少商品 ID',
  ITEM_NOT_IN_CACHE: '不在最新活力缓存中',
  WAITING_NEW_LISTING_DATA: '等待新商品数据',
  RETEST_PASSED: '复测点击率已回升',
  CTR_RECOVERED: '点击率已回升，可移出',
  HEALTHY: '点击健康（建议改价格/详情，不重发）',
  CAPACITY_WAITLIST: '容量候补（池满，等待出池）',
}

const queueLayers = {
  high_exposure: { label: '高曝光低点击', tone: 'bg-rose-100 text-rose-700' },
  reborn: { label: '正常衰退', tone: 'bg-amber-100 text-amber-800' },
  activate: { label: '待激活（低曝光）', tone: 'bg-slate-100 text-slate-600' },
}

function queueLayer(item) {
  return queueLayers[item.queueKind] || null
}

function localDate(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const today = localDate(new Date())

const poolStatusById = computed(() => {
  const map = new Map()
  for (const row of dashboard.value?.queue || []) map.set(String(row.itemId), '排队中')
  for (const row of dashboard.value?.retesting || []) map.set(String(row.itemId), '复测中')
  for (const row of dashboard.value?.protected || []) {
    map.set(String(row.itemId), row.protectionReason === 'HEALTHY' ? '健康' : '保护')
  }
  for (const row of dashboard.value?.offlined || []) map.set(String(row.itemId), '下架区')
  return map
})

const manualFiltered = computed(() => {
  const text = manualKeyword.value.trim().toLowerCase()
  if (!text) return manualItems.value
  const priceText = text.replace(/[¥￥\s,]/g, '')
  return manualItems.value.filter((item) => {
    const title = String(item.title || '').toLowerCase()
    const itemId = String(item.itemId || '')
    const price = String(item.price || '')
    return title.includes(text) || itemId.includes(text) || (priceText !== '' && price.includes(priceText))
  })
})

function manualStatus(itemId) {
  return poolStatusById.value.get(String(itemId)) || '未入池'
}

function manualStatusTone(itemId) {
  switch (manualStatus(itemId)) {
    case '排队中':
      return 'bg-sky-50 text-sky-700'
    case '复测中':
      return 'bg-violet-50 text-violet-700'
    case '健康':
      return 'bg-emerald-50 text-emerald-700'
    case '保护':
      return 'bg-amber-50 text-amber-800'
    case '下架区':
      return 'bg-red-50 text-red-700'
    default:
      return 'bg-gray-100 text-gray-600'
  }
}

function toast(message, tone = 'success') {
  toastMessage.value = message
  toastTone.value = tone
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastMessage.value = ''
  }, 3200)
}

async function loadDashboard() {
  isLoading.value = true
  pageError.value = ''
  try {
    dashboard.value = await store.getDashboard(new Date())
  } catch (error) {
    pageError.value = error?.message || '读取看板失败'
  } finally {
    isLoading.value = false
  }
}

async function recordUserOffline(item, occurredAt = new Date().toISOString(), dateOnly = false) {
  try {
    await insertEvent(
      props.config,
      props.session,
      {
        item_id: item.itemId,
        type: 'offline',
        occurred_at: occurredAt,
        data: { title: item.title, price: item.price, source: 'user', ...(dateOnly ? { dateOnly: true } : {}) },
      },
      props.onSession || undefined,
    )
  } catch {
    // 动态记录失败不影响打卡结果
  }
}

async function loadManualItems() {
  manualLoading.value = true
  manualError.value = ''
  try {
    const [{ payload }, status] = await Promise.all([
      loadRow(props.config, 'goofish_vitality', props.session, {
        onSession: props.onSession || undefined,
      }),
      fetchShopStatus(props.config, props.session, props.onSession || undefined).catch(() => null),
    ])
    const merged = new Map()
    for (const item of status?.payload?.items || []) {
      const itemId = String(item?.itemId || '')
      if (itemId) merged.set(itemId, { ...item, source: 'cdp' })
    }
    for (const item of payload?.vitality || []) {
      const itemId = String(item?.itemId || '')
      if (!itemId) continue
      merged.set(itemId, { ...(merged.get(itemId) || {}), ...item, source: 'excel' })
    }
    const offlined = new Set((dashboard.value?.offlined || []).map((row) => String(row.itemId)))
    const terminal = new Set(['OFFLINED', 'REPOSTED', 'CANCELED', 'ARCHIVED'])
    const poolStatuses = dashboard.value?.pool_statuses || {}
    manualItems.value = [...merged.values()].filter((item) => {
      const itemId = String(item.itemId)
      const status = poolStatuses[itemId]
      return !offlined.has(itemId) && !terminal.has(status)
    })
  } catch (error) {
    manualError.value = error?.message || '读取商品列表失败'
  } finally {
    manualLoading.value = false
  }
}

async function openManualOffline() {
  manualOpen.value = true
  manualKeyword.value = ''
  manualDate.value = localDate(new Date())
  await loadManualItems()
}

async function manualOfflineAction(item) {
  const now = new Date()
  const dateOnly = manualDate.value !== localDate(now)
  if (!manualDate.value) {
    toast('请选择下架日期', 'danger')
    return
  }
  const offlinedAt = dateOnly ? `${manualDate.value}T00:00:00+08:00` : now.toISOString()
  const ok = await runAction(
    `manual-offline:${item.itemId}`,
    () => store.manualOffline(item, { offlinedAt }, now),
    '已下架并进入暂存区',
  )
  if (!ok) return
  await recordUserOffline(item, offlinedAt, dateOnly)
  activeTab.value = 'offlined'
  manualOpen.value = false
}

async function removeOfflineAction(item) {
  if (!window.confirm(`确认把「${item.title || item.itemId}」移出下架区？`)) return
  await runAction(
    `remove-offline:${item.itemId}`,
    () => store.removeOffline(item.itemId, new Date()),
    '已移出下架区',
  )
}

async function confirmOfflineAction(item) {
  const ok = await runAction(
    `offline:${item.itemId}`,
    () => store.confirmOffline(item.itemId, { offlineConfirmed: true, materialsPrepared: true }, new Date()),
    '已记录下架静置',
  )
  if (ok) await recordUserOffline(item)
  return ok
}

async function runAction(key, action, success) {
  actionKey.value = key
  try {
    await action()
    toast(success)
    skipped.value = new Set()
    await loadDashboard()
    return true
  } catch (error) {
    toast(error?.message || '操作失败', 'danger')
    await loadDashboard()
    return false
  } finally {
    actionKey.value = ''
  }
}

function checklistFor(itemId) {
  return checklist.value[itemId] || { offline: false, materials: false, keywords: false }
}

function setChecklist(itemId, key, value) {
  checklist.value = {
    ...checklist.value,
    [itemId]: { ...checklistFor(itemId), [key]: value === true },
  }
}

function skipItem(itemId) {
  skipped.value = new Set([...skipped.value, itemId])
}

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(String(value).replace(' ', 'T'))
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function formatDay(value) {
  return value ? String(value).slice(0, 10) : '—'
}

function formatNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Number(value))
}

function formatPrice(value) {
  if (value === null || value === undefined || value === '') return '—'
  return typeof value === 'number' ? value.toFixed(2) : value
}

function daysInPool(item) {
  void tick.value
  if (!item.inPoolAt) return 0
  const elapsed = Date.now() - new Date(item.inPoolAt).getTime()
  return Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed / 86_400_000)) : 0
}

function ctrTone(item) {
  if (item.metricsMissing) return 'text-gray-400'
  if (item.ctr7d < 0.8) return 'text-danger'
  if (item.ctr7d < 1.5) return 'text-warning'
  return 'text-success'
}

function countdown(item) {
  void tick.value
  if (!item.repostAvailableAt) return '时间不可用'
  const remaining = new Date(item.repostAvailableAt).getTime() - Date.now()
  if (remaining <= 0) return '可确认重发'
  const hours = Math.floor(remaining / 3_600_000)
  const minutes = Math.floor((remaining % 3_600_000) / 60_000)
  return `${hours} 小时 ${minutes} 分`
}

function repostReady(item) {
  void tick.value
  return Boolean(item.repostAvailableAt) && new Date(item.repostAvailableAt).getTime() <= Date.now()
}

function retestCountdown(item) {
  void tick.value
  if (!item.optimizationStartedAt) return '时间不可用'
  const remaining = new Date(item.optimizationStartedAt).getTime() + 72 * 3_600_000 - Date.now()
  if (remaining <= 0) return '复测到期'
  const hours = Math.floor(remaining / 3_600_000)
  const minutes = Math.floor((remaining % 3_600_000) / 60_000)
  return `${hours} 小时 ${minutes} 分后复测`
}

function openRepost(item) {
  repostTarget.value = item
  newItemId.value = ''
  repostDialogOpen.value = true
}

async function recordUserRepost(item, newItemId, occurredAt = new Date().toISOString()) {
  try {
    await insertEvent(
      props.config,
      props.session,
      {
        item_id: newItemId,
        type: 'repost',
        occurred_at: occurredAt,
        data: {
          title: item.title,
          price: item.price,
          source: 'user',
          matched: item.itemId,
          oldItemId: item.itemId,
          score: 1,
        },
      },
      props.onSession || undefined,
    )
  } catch {
    // 动态记录失败不影响重发结果
  }
}

async function submitRepost() {
  if (!repostTarget.value || !newItemId.value.trim()) return
  const item = repostTarget.value
  const nextId = newItemId.value.trim()
  const succeeded = await runAction(
    `repost:${item.itemId}`,
    () => store.confirmRepost(item.itemId, nextId, new Date()),
    '重发已记录',
  )
  if (succeeded) {
    await recordUserRepost(item, nextId)
    repostDialogOpen.value = false
    repostTarget.value = null
  }
}

function handleImageError(event) {  event.target.style.display = 'none'
}

onMounted(() => {
  void loadDashboard()
  clockTimer = setInterval(() => {
    tick.value = Date.now()
  }, 60_000)
})

onUnmounted(() => {
  clearInterval(clockTimer)
  clearTimeout(toastTimer)
})
</script>

<template>
  <div class="mx-auto w-full max-w-[1440px] space-y-5 pb-10">
    <header class="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
      <div>
        <div class="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-gray-400">
          <span class="h-2 w-2 rounded-full bg-warning"></span>运营看板
        </div>
        <h1 class="text-2xl font-black tracking-tight text-gray-900">重发看板</h1>
        <p class="mt-1 max-w-3xl text-sm text-gray-500">
          只给建议并记录你在闲鱼端已完成的动作；不登录、不发布、不下架、不发任何闲鱼请求。
        </p>
      </div>
      <div class="flex items-center gap-2">
        <button class="btn btn-outline" :disabled="isLoading" @click="openManualOffline">
          <i class="fa-solid fa-arrow-down" />手动下架
        </button>
        <button class="btn btn-outline" :disabled="isLoading" @click="loadDashboard">
          <i class="fa-solid fa-arrows-rotate" :class="isLoading ? 'animate-spin' : ''" />刷新
        </button>
      </div>
    </header>

    <section
      v-if="dataStatus && !dataStatus.available"
      class="flex gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950"
    >
      <i class="fa-solid fa-triangle-exclamation mt-0.5 text-lg" />
      <div>
        <p class="font-bold">活力数据不可用</p>
        <p class="mt-1 text-sm">{{ statusReason[dataStatus.reason] || '暂无有效数据' }}</p>
      </div>
    </section>
    <section
      v-else-if="dataStatus && (!dataStatus.complete || dataStatus.range !== '7')"
      class="flex gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950"
    >
      <i class="fa-solid fa-triangle-exclamation mt-0.5 text-lg" />
      <div>
        <p class="font-bold">数据不完整</p>
        <p class="mt-1 text-sm">当前不是完整的近 7 天数据，依赖统计的新操作已关闭。</p>
      </div>
    </section>

    <section v-if="pageError" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-danger">
      {{ pageError }}
    </section>

    <details class="apple-card cursor-pointer">
      <summary class="text-sm font-bold text-gray-800">重发规则说明（点击展开）</summary>
      <div class="mt-3 space-y-2 text-xs leading-relaxed text-gray-600">
        <p><strong>分层规则（按近 7 天曝光与点击率）：</strong></p>
        <ul class="list-disc space-y-1 pl-5">
          <li><strong>高曝光低点击</strong>（曝光 ≥1000 且点击率 &lt;0.8%）：彻底重做首图+标题后重发</li>
          <li><strong>正常衰退</strong>（曝光 100–1000 且点击率 &lt;1.5%）：换首图/标题 + 小幅降价后重发</li>
          <li><strong>待激活</strong>（曝光 &lt;100）：先补全标题关键词 + 换首图，再重发</li>
          <li><strong>点击健康</strong>（曝光 ≥1000 且点击率 ≥0.8%，或曝光 100–1000 且点击率 ≥1.5%）：不重发，建议改价格/详情</li>
        </ul>
        <p><strong>排队顺序：</strong>入池成员按分层规则确定；「排队中」与「优先动作」按重发更新指数（权重）降序展示。</p>
        <p><strong>重发约束（平台规则）：</strong></p>
        <ul class="list-disc space-y-1 pl-5">
          <li>同一商品链接累计编辑 ≤3 次，否则判定“商品不稳定”降权</li>
          <li>删除后新建链接须换首图 + 改标题前置词 + 微调价格，否则触发“重复铺货”降权</li>
          <li>两轮重发止损；每日配额：上新+重发 ≥3 或重发 ≥2 锁定</li>
        </ul>
      </div>
    </details>

    <PendingPanel :config="config" :session="session" :on-session="onSession" />

    <section class="grid gap-3 md:grid-cols-3">
      <div class="apple-card flex items-center justify-between p-5">
        <div>
          <p class="text-xs font-bold uppercase tracking-wider text-gray-500">今日真实上新</p>
          <p class="mt-2 text-3xl font-black tabular-nums text-gray-900">
            {{ quota?.new_listings_today ?? 0 }}<span class="ml-1 text-sm font-medium text-gray-400">件</span>
          </p>
        </div>
        <button
          class="btn btn-primary btn-sm"
          :disabled="isLoading || !!actionKey || !!quota?.locked"
          @click="runAction('new-listing', () => store.recordNewListing(new Date()), '已记录一次真实上新')"
        >
          <i class="fa-solid" :class="actionKey === 'new-listing' ? 'fa-circle-notch animate-spin' : 'fa-plus'" />
          记录上新
        </button>
      </div>

      <div class="apple-card p-5">
        <div class="flex items-end justify-between gap-3">
          <div>
            <p class="text-xs font-bold uppercase tracking-wider text-gray-500">今日重发</p>
            <p class="mt-2 text-3xl font-black tabular-nums text-gray-900">
              {{ quota?.reposts_today ?? 0 }}<span class="text-gray-400"> / 2</span>
            </p>
          </div>
          <p class="text-right text-xs text-gray-500">
            建议余量<br /><strong class="text-xl text-gray-800">{{ quota?.remaining_suggested ?? 0 }}</strong>
          </p>
        </div>
        <div class="mt-3 h-2 overflow-hidden rounded-full bg-gray-100">
          <div
            class="h-full rounded-full bg-gray-800 transition-all"
            :style="{ width: `${Math.min(((quota?.reposts_today ?? 0) / 2) * 100, 100)}%` }"
          ></div>
        </div>
      </div>

      <div class="apple-card flex items-center gap-3 p-5" :class="quota?.locked ? 'border-red-300 bg-red-50' : 'bg-gray-50'">
        <i
          class="fa-solid text-2xl"
          :class="quota?.locked ? 'fa-shield-halved text-danger' : 'fa-shield-check text-success'"
        />
        <div>
          <p class="font-bold" :class="quota?.locked ? 'text-red-900' : 'text-gray-800'">
            {{ quota?.locked ? '今日配额已锁定' : '配额安全' }}
          </p>
          <p class="mt-1 text-xs text-gray-500">上新 + 重发 ≥ 3 或重发 ≥ 2 时锁定</p>
        </div>
      </div>
    </section>

    <section class="space-y-3">
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-lg font-black text-gray-900">优先动作</h2>
          <p class="text-xs text-gray-500">
            按重发更新指数（权重）排序的 Top 3 · 健康商品（不重发）{{ dashboard?.healthy_count ?? 0 }} 件
          </p>
        </div>
        <span class="rounded-md bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-600">{{ topQueue.length }} / 3</span>
      </div>

      <div v-if="isLoading && !dashboard" class="grid gap-4 xl:grid-cols-2">
        <div v-for="i in 2" :key="i" class="apple-card h-56 animate-pulse bg-gray-50" />
      </div>
      <div v-else-if="topQueue.length" class="grid gap-4 xl:grid-cols-2">
        <div v-for="item in topQueue" :key="item.itemId" class="apple-card overflow-hidden p-0">
          <div class="h-1" :class="item.priority === 'P1' ? 'bg-danger' : 'bg-warning'"></div>
          <div class="space-y-4 p-5">
            <div class="flex flex-wrap items-center gap-2">
              <span
                class="rounded-md px-2 py-1 text-[11px] font-black uppercase"
                :class="item.priority === 'P1' ? 'bg-red-100 text-red-700' : item.priority === 'P2' ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600'"
              >
                {{ item.priority === 'P1' ? 'P1' : item.priority === 'P2' ? 'P2' : '待优化' }}
              </span>
              <span v-if="queueLayer(item)" class="rounded-md px-2 py-1 text-[11px] font-black" :class="queueLayer(item).tone">
                {{ queueLayer(item).label }}
              </span>
              <span class="rounded-md bg-gray-900 px-2 py-1 text-[11px] font-black text-white">
                指数 {{ item.republishScore?.toFixed(0) ?? '—' }}
              </span>
              <span class="text-xs font-semibold text-gray-500">第 {{ item.republishRound + 1 }} 轮</span>
              <span class="ml-auto text-xs text-gray-400">入池 {{ daysInPool(item) }} 天</span>
            </div>

            <div class="flex gap-4">
              <ProductThumb :item-id="item.itemId" :pic-url="item.picUrl" :base="config.supabaseUrl" :size="80" />
              <div class="min-w-0 flex-1">
                <h3 class="line-clamp-2 font-bold leading-snug text-gray-900">{{ item.title }}</h3>
                <p class="mt-1 break-all font-mono text-[10px] text-gray-400">ID {{ item.itemId }}</p>
                <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-600">
                  <span><strong class="text-gray-900">¥{{ formatPrice(item.price) }}</strong></span>
                  <span>库存: {{ item.stock || '—' }}</span>
                  <span>销量: {{ item.sales || '—' }}</span>
                </div>
                <p class="mt-1 text-[11px] text-gray-400">
                  上架: {{ formatDate(item.createTime) }}
                  <span class="ml-1">({{ item.listingAgeDays ?? '—' }} 天)</span>
                </p>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <div class="rounded-lg bg-gray-50 p-2">
                <p class="text-[10px] font-bold uppercase text-gray-400">曝光</p>
                <p class="mt-1 font-mono text-sm font-bold text-gray-900">{{ item.metricsMissing ? '—' : formatNumber(item.exposure7d) }}</p>
              </div>
              <div class="rounded-lg bg-gray-50 p-2">
                <p class="text-[10px] font-bold uppercase text-gray-400">浏览</p>
                <p class="mt-1 font-mono text-sm font-bold text-gray-900">{{ item.metricsMissing ? '—' : formatNumber(item.views7d) }}</p>
              </div>
              <div
                class="rounded-lg border p-2"
                :class="item.metricsMissing ? 'border-gray-200 bg-gray-50' : item.ctr7d < 0.8 ? 'border-red-200 bg-red-50' : item.ctr7d < 1.5 ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'"
              >
                <p class="text-[10px] font-bold uppercase text-gray-400">点击率</p>
                <p class="mt-1 font-mono text-sm font-black" :class="ctrTone(item)">
                  {{ item.metricsMissing ? '—' : `${item.ctr7d.toFixed(2)}%` }}
                </p>
              </div>
              <div class="rounded-lg bg-gray-50 p-2">
                <p class="text-[10px] font-bold uppercase text-gray-400">询单</p>
                <p class="mt-1 font-mono text-sm font-bold text-gray-900">{{ item.metricsMissing ? '—' : formatNumber(item.inquiryCount) }}</p>
              </div>
              <div class="rounded-lg bg-gray-50 p-2">
                <p class="text-[10px] font-bold uppercase text-gray-400">支付</p>
                <p class="mt-1 font-mono text-sm font-bold text-gray-900">{{ item.metricsMissing ? '—' : formatNumber(item.orderCount) }}</p>
              </div>
            </div>

            <div class="rounded-lg border border-sky-100 bg-sky-50 p-3">
              <p class="mb-1 flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wide text-sky-800">
                <i class="fa-solid fa-wand-magic-sparkles" />诊断建议
              </p>
              <p class="text-sm leading-relaxed text-sky-950">{{ item.advice }}</p>
            </div>

            <div class="grid gap-2 sm:grid-cols-2">
              <label class="flex cursor-pointer items-start gap-2 rounded-lg border border-gray-200 p-2.5 text-xs text-gray-600">
                <input
                  type="checkbox"
                  class="mt-0.5"
                  :checked="checklistFor(item.itemId).offline"
                  @change="setChecklist(item.itemId, 'offline', $event.target.checked)"
                />
                <span>已在闲鱼端手动下架</span>
              </label>
              <label class="flex cursor-pointer items-start gap-2 rounded-lg border border-gray-200 p-2.5 text-xs text-gray-600">
                <input
                  type="checkbox"
                  class="mt-0.5"
                  :checked="checklistFor(item.itemId).materials"
                  @change="setChecklist(item.itemId, 'materials', $event.target.checked)"
                />
                <span>已准备新版首图与标题（不得沿用原图/原标题，否则按重复铺货降权）</span>
              </label>
              <label
                v-if="item.queueKind === 'activate'"
                class="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-300 bg-slate-50 p-2.5 text-xs text-slate-700 sm:col-span-2"
              >
                <input
                  type="checkbox"
                  class="mt-0.5"
                  :checked="checklistFor(item.itemId).keywords"
                  @change="setChecklist(item.itemId, 'keywords', $event.target.checked)"
                />
                <span>标题已补全关键词（低曝光商品必做：品牌/编号/车型，参考同类热卖标题）</span>
              </label>
            </div>

            <div class="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
              <button
                class="btn btn-danger btn-sm"
                :disabled="!dataStatus?.available || !!quota?.locked || !checklistFor(item.itemId).offline || !checklistFor(item.itemId).materials || (item.queueKind === 'activate' && !checklistFor(item.itemId).keywords) || !!actionKey"
                @click="confirmOfflineAction(item)"
              >
                <i class="fa-solid" :class="actionKey === `offline:${item.itemId}` ? 'fa-circle-notch animate-spin' : 'fa-arrow-down'" />
                确认下架静置
              </button>
              <button class="btn btn-outline btn-sm ml-auto" @click="skipItem(item.itemId)">
                <i class="fa-solid fa-arrow-up" />跳过
              </button>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="apple-card border-dashed border-gray-300 bg-gray-50/70 text-center">
        <i class="fa-solid fa-circle-check text-3xl text-success" />
        <p class="mt-3 font-bold text-gray-800">暂无优先动作</p>
        <p class="mt-1 text-sm text-gray-500">当前没有符合重发条件的商品，或数据尚未同步。</p>
      </div>
    </section>

    <section class="space-y-4">
      <div class="grid h-auto w-full grid-cols-3 rounded-xl bg-gray-100 p-1">
        <button
          v-for="tab in [
            { key: 'queue', label: '排队中', count: dashboard?.queue.length ?? 0 },
            { key: 'offlined', label: '下架区', count: dashboard?.offlined.length ?? 0 },
            { key: 'protected', label: '保护 / 健康', count: dashboard?.protected.length ?? 0 },
          ]"
          :key="tab.key"
          class="rounded-lg py-2.5 text-xs sm:text-sm"
          :class="activeTab === tab.key ? 'tab-active' : 'tab-inactive'"
          @click="activeTab = tab.key"
        >
          {{ tab.label }} <span class="text-gray-400">{{ tab.count }}</span>
        </button>
      </div>

      <div v-show="activeTab === 'queue'" class="space-y-4">
        <div v-if="dashboard?.retesting.length" class="apple-card border-violet-200 bg-violet-50/50">
          <p class="flex items-center gap-2 text-sm font-bold text-violet-950">
            <i class="fa-solid fa-rotate-left" />72 小时复测中
          </p>
          <div class="mt-3 space-y-2">
            <div v-for="item in dashboard.retesting" :key="item.itemId" class="flex flex-col gap-3 rounded-lg border border-violet-100 bg-white p-3 sm:flex-row sm:items-center">
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-semibold text-gray-800">{{ item.title }}</p>
                <p class="mt-1 text-xs text-gray-500">
                  基线 {{ item.optimizationBaselineCtr?.toFixed(2) ?? '—' }}% · 当前
                  {{ item.metricsMissing ? '—' : `${item.ctr7d.toFixed(2)}%` }} · {{ retestCountdown(item) }}
                </p>
              </div>
              <button
                v-if="item.recovered"
                class="btn btn-outline btn-sm border-emerald-300 text-emerald-800"
                :disabled="!!actionKey"
                @click="runAction(`cancel:${item.itemId}`, () => store.cancelItem(item.itemId, new Date()), '已移出排队')"
              >
                <i class="fa-solid fa-check" />数据回升，移出
              </button>
            </div>
          </div>
        </div>

        <div v-if="dashboard?.optimization_candidates.length" class="apple-card border-sky-200 bg-sky-50/50">
          <p class="flex items-center gap-2 text-sm font-bold text-sky-950">
            <i class="fa-solid fa-rotate-left" />可开始 3 天复测
          </p>
          <div class="mt-3 space-y-2">
            <div v-for="item in dashboard.optimization_candidates" :key="item.itemId" class="flex flex-col gap-3 rounded-lg border border-sky-100 bg-white p-3 sm:flex-row sm:items-center">
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-semibold text-gray-800">{{ item.title }}</p>
                <p class="mt-1 text-xs text-gray-500">点击率 {{ item.ctr7d.toFixed(2) }}% · 曝光 {{ formatNumber(item.exposure7d) }}</p>
              </div>
              <button
                class="btn btn-outline btn-sm"
                :disabled="!dataStatus?.available || poolIsFull || !!actionKey"
                @click="runAction(`optimize:${item.itemId}`, () => store.startOptimization(item.itemId, new Date()), '已开始复测')"
              >
                <i class="fa-solid" :class="actionKey === `optimize:${item.itemId}` ? 'fa-circle-notch animate-spin' : 'fa-rotate-right'" />
                开始复测
              </button>
            </div>
          </div>
        </div>

        <div class="apple-card p-0">
          <div class="border-b border-gray-100 px-5 py-3 text-sm font-bold text-gray-800">排队中</div>
          <div class="overflow-x-auto">
            <table v-if="dashboard?.queue.length" class="apple-table min-w-[760px]">
              <thead>
                <tr>
                  <th>分层 / 优先</th>
                  <th>商品</th>
                  <th>点击率</th>
                  <th>指数</th>
                  <th>轮次</th>
                  <th>入池时间</th>
                  <th class="text-right">状态</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in dashboard.queue" :key="item.itemId" :class="item.recovered ? 'bg-emerald-50' : ''">
                  <td>
                    <span class="rounded px-2 py-1 text-[10px] font-black" :class="item.priority === 'P1' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800'">
                      {{ item.priority || '—' }}
                    </span>
                    <span
                      v-if="queueLayer(item)"
                      class="mt-1 block rounded px-2 py-1 text-center text-[10px] font-black"
                      :class="queueLayer(item).tone"
                    >
                      {{ queueLayer(item).label }}
                    </span>
                  </td>
                  <td class="max-w-[320px]">
                    <div class="flex items-center gap-2">
                      <ProductThumb :item-id="item.itemId" :pic-url="item.picUrl" :base="config.supabaseUrl" :size="24" />
                      <div class="min-w-0">
                        <p class="truncate font-semibold text-gray-800">{{ item.title }}</p>
                        <p class="mt-0.5 font-mono text-[10px] text-gray-400">{{ item.itemId }} · ¥{{ formatPrice(item.price) }}</p>
                      </div>
                    </div>
                  </td>
                  <td class="font-mono font-bold" :class="ctrTone(item)">{{ item.metricsMissing ? '—' : `${item.ctr7d.toFixed(2)}%` }}</td>
                  <td class="font-mono font-bold text-gray-900">{{ item.republishScore?.toFixed(0) ?? '—' }}</td>
                  <td class="text-gray-600">第 {{ item.republishRound + 1 }} 轮</td>
                  <td class="text-xs text-gray-500">{{ formatDate(item.inPoolAt) }}</td>
                  <td class="text-right">
                    <button
                      v-if="item.recovered"
                      class="btn btn-outline btn-sm border-emerald-300 text-emerald-800"
                      :disabled="!!actionKey"
                      @click="runAction(`cancel:${item.itemId}`, () => store.cancelItem(item.itemId, new Date()), '已移出排队')"
                    >
                      <i class="fa-solid fa-check" />移出
                    </button>
                    <span v-else class="text-xs font-semibold text-gray-500">排队中</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-else class="py-10 text-center text-sm text-gray-500">队列为空</div>
          </div>

          <div v-if="dashboard?.capacity_waitlist.length" class="m-4 rounded-lg border border-dashed border-gray-300 bg-gray-50 p-3">
            <p class="mb-2 text-xs font-bold text-gray-600">容量候补（池满 15 件）</p>
            <p v-for="item in dashboard.capacity_waitlist" :key="item.itemId" class="truncate py-1 text-xs text-gray-500">
              {{ item.title }} <span class="font-mono text-gray-400">{{ item.itemId }}</span>
            </p>
          </div>
        </div>
      </div>

      <div v-show="activeTab === 'offlined'" class="apple-card">
        <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <p class="flex items-center gap-2 text-sm font-bold text-gray-800">
            <i class="fa-solid fa-box-open text-warning" />下架区（暂存）
            <span class="rounded bg-gray-100 px-2 py-0.5 text-[11px] font-bold text-gray-500">{{ dashboard?.offlined.length ?? 0 }} 件</span>
          </p>
          <p class="text-xs text-gray-400">不占 15 件排队池；满 24 小时可重发，也可直接移出</p>
        </div>
        <div class="mt-3 space-y-3">
          <article
            v-for="item in dashboard?.offlined || []"
            :key="item.itemId"
            class="flex flex-col gap-4 rounded-xl border border-gray-200 p-4 lg:flex-row lg:items-center"
          >
            <div class="flex min-w-0 flex-1 items-center gap-3">
              <ProductThumb :item-id="item.itemId" :pic-url="item.picUrl" :base="config.supabaseUrl" :size="28" />
              <div class="min-w-0">
                <p class="truncate font-bold text-gray-900">{{ item.title }}</p>
                <p class="mt-1 font-mono text-[10px] text-gray-400">
                  {{ item.itemId }} · 第 {{ item.republishRound + 1 }} 轮
                  <span v-if="item.offlinedAt"> · 下架 {{ formatDay(item.offlinedAt) }}</span>
                </p>
                <p v-if="item.protectionReason" class="mt-1 text-xs font-semibold text-amber-700">
                  {{ reasonText[item.protectionReason] || item.protectionReason }}
                </p>
              </div>
            </div>
            <div class="rounded-lg bg-amber-50 px-4 py-2 text-center">
              <p class="text-[10px] font-bold uppercase tracking-wider text-amber-700">静置倒计时</p>
              <p class="mt-1 font-mono text-sm font-black text-amber-950">{{ countdown(item) }}</p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <button class="btn btn-primary btn-sm" :disabled="!repostReady(item) || !!quota?.locked || !!actionKey" @click="openRepost(item)">
                <i class="fa-solid fa-circle-check" />确认重发
              </button>
              <button class="btn btn-outline btn-sm" :disabled="!!actionKey" @click="removeOfflineAction(item)">
                <i class="fa-solid fa-box-archive" />移出暂存
              </button>
            </div>
          </article>
          <div v-if="!dashboard?.offlined.length" class="py-10 text-center text-sm text-gray-500">下架区暂无商品</div>
        </div>
      </div>

      <div v-show="activeTab === 'protected'" class="apple-card">
        <p class="flex items-center gap-2 text-sm font-bold text-gray-800">
          <i class="fa-solid fa-shield-halved text-gray-500" />保护 / 健康 / 数据不足
        </p>
        <div class="mt-3 space-y-2">
          <div
            v-for="item in dashboard?.protected || []"
            :key="item.diagnosticKey || item.itemId"
            class="flex flex-col gap-2 rounded-lg border border-gray-200 bg-gray-50/70 p-3 sm:flex-row sm:items-center"
          >
            <div class="flex min-w-0 flex-1 items-center gap-3">
              <ProductThumb :item-id="item.itemId" :pic-url="item.picUrl" :base="config.supabaseUrl" :size="24" />
              <div class="min-w-0">
                <p class="truncate text-sm font-semibold text-gray-800">{{ item.title || item.itemId }}</p>
                <p class="mt-1 font-mono text-[10px] text-gray-400">{{ item.itemId || '商品 ID 不可用' }}</p>
              </div>
            </div>
            <span
              class="rounded px-2 py-1 text-[10px] font-bold"
              :class="item.protectionReason === 'HEALTHY' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-200 text-gray-700'"
            >
              {{ reasonText[item.protectionReason] || item.protectionReason || '数据不足' }}
            </span>
            <p v-if="item.advice" class="text-xs text-gray-600 sm:max-w-[40%]">{{ item.advice }}</p>
          </div>
          <div v-if="!dashboard?.protected.length" class="py-10 text-center text-sm text-gray-500">暂无保护项</div>
        </div>
      </div>
    </section>

    <footer class="flex flex-col gap-2 border-t border-gray-200 pt-3 text-[11px] text-gray-400 sm:flex-row sm:justify-between">
      <span class="flex flex-wrap items-center gap-2">
        <span>诊断数据：{{ sourceMeta('excel').label }}（{{ dataStatus?.range === '7' ? '近 7 天' : '—' }} · {{ dataStatus?.complete ? '完整' : '不完整' }} · 可信度 {{ sourceMeta('excel').confidence }}）</span>
        <span class="rounded px-1.5 py-0.5 font-bold" :class="sourceMeta('user').badge">打卡：{{ sourceMeta('user').label }}（{{ sourceMeta('user').confidence }}）</span>
      </span>
      <span>数据时间：{{ formatDate(dataStatus?.fetched_at) }}</span>
    </footer>

    <div
      v-if="manualOpen"
      class="modal-overlay"
      tabindex="-1"
      @click.self="manualOpen = false"
      @keydown.esc="manualOpen = false"
    >
      <div class="glass-modal flex max-h-[82vh] w-full max-w-3xl flex-col p-6">
        <div class="flex items-start justify-between gap-3">
          <div>
            <h3 class="text-lg font-bold text-gray-900">手动下架（进入暂存区）</h3>
            <p class="mt-1 text-sm text-gray-500">选择任意商品并记录下架日期；不占 15 件排队池。</p>
          </div>
          <button class="btn btn-outline btn-sm" @click="manualOpen = false">关闭</button>
        </div>

        <div class="mt-4 grid gap-3 sm:grid-cols-[1fr_190px]">
          <input v-model="manualKeyword" class="apple-input" type="search" placeholder="搜索标题 / 商品 ID / 价格" />
          <label class="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-500">
            <span class="whitespace-nowrap">下架日期</span>
            <input v-model="manualDate" class="min-w-0 flex-1 bg-transparent text-sm text-gray-800 outline-none" type="date" :max="today" />
          </label>
        </div>
        <p class="mt-2 text-[11px] text-gray-400">历史日期按当天 00:00 记录；今天按下架时刻记录。下架后自动写入店铺动态。</p>

        <section v-if="manualError" class="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-danger">
          {{ manualError }}
        </section>

        <div class="mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border border-gray-100">
          <div v-if="manualLoading" class="py-10 text-center text-sm text-gray-400">
            <i class="fa-solid fa-circle-notch mr-2 animate-spin" />正在读取商品…
          </div>
          <div v-else-if="!manualFiltered.length" class="py-10 text-center text-sm text-gray-400">
            没有匹配的商品
          </div>
          <div
            v-for="item in manualFiltered"
            v-else
            :key="item.itemId"
            class="flex items-center gap-3 border-b border-gray-100 px-3 py-2.5 last:border-b-0"
          >
            <ProductThumb :item-id="item.itemId" :pic-url="item.picUrl" :base="config.supabaseUrl" :size="36" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold text-gray-800">{{ item.title || item.itemId }}</p>
              <p class="mt-0.5 font-mono text-[10px] text-gray-400">
                {{ item.itemId }} · ¥{{ formatPrice(item.price) }}
                <span v-if="item.createTime"> · 上架 {{ String(item.createTime).slice(0, 10) }}</span>
              </p>
            </div>
            <span class="whitespace-nowrap rounded px-2 py-0.5 text-[10px] font-bold" :class="manualStatusTone(item.itemId)">
              {{ manualStatus(item.itemId) }}
            </span>
            <button
              class="btn btn-outline btn-sm whitespace-nowrap"
              :disabled="!!actionKey"
              @click="manualOfflineAction(item)"
            >
              <i class="fa-solid" :class="actionKey === `manual-offline:${item.itemId}` ? 'fa-circle-notch animate-spin' : 'fa-arrow-down'" />
              下架
            </button>
          </div>
        </div>

        <p class="mt-3 text-[11px] text-gray-400">共 {{ manualFiltered.length }} 件可选 · 已在下架区的商品不重复显示</p>
      </div>
    </div>

    <div v-if="repostDialogOpen" class="modal-overlay" tabindex="-1" @click.self="repostDialogOpen = false" @keydown.esc="repostDialogOpen = false">
      <div class="glass-modal w-full max-w-md p-6">
        <h3 class="text-lg font-bold text-gray-900">确认已重发</h3>
        <p class="mt-1 text-sm text-gray-500">请录入闲鱼生成的新商品 ID，系统会关联原商品谱系并累计轮次。</p>
        <label class="mt-4 block">
          <span class="mb-1 block text-xs font-semibold text-gray-500">新商品 ID</span>
          <input v-model="newItemId" class="apple-input" inputmode="numeric" autocomplete="off" placeholder="粘贴新版商品 ID" autofocus />
        </label>
        <p class="mt-2 text-xs text-gray-400">新 ID 必须不同于旧 ID，且不能已被使用或出现在当前活力数据中。</p>
        <div class="mt-5 flex justify-end gap-2">
          <button class="btn btn-outline" :disabled="!!actionKey" @click="repostDialogOpen = false">取消</button>
          <button class="btn btn-primary" :disabled="!newItemId.trim() || !!actionKey" @click="submitRepost">
            <i class="fa-solid" :class="actionKey.startsWith('repost:') ? 'fa-circle-notch animate-spin' : 'fa-circle-check'" />
            确认重发
          </button>
        </div>
      </div>
    </div>

    <div
      v-if="toastMessage"
      class="fixed bottom-6 right-6 z-50 rounded-xl px-4 py-3 text-sm font-semibold text-white shadow-lg"
      :class="toastTone === 'danger' ? 'bg-danger' : 'bg-gray-900'"
    >
      {{ toastMessage }}
    </div>
  </div>
</template>
