<script setup>
import { computed, onMounted, ref } from 'vue'
import { fetchShopMetrics } from '../../services/automationApi.js'

const props = defineProps({
  config: { type: Object, required: true },
  session: { type: Object, default: null },
  onSession: { type: Function, default: null },
})

const records = ref([])
const loading = ref(true)
const error = ref('')
const rangeKey = ref('range1')

const latest = computed(() => records.value[0] || null)
const payload = computed(() => latest.value?.payload || null)
const current = computed(() => payload.value?.[rangeKey.value] || null)
const overview = computed(() => current.value?.overview || {})
const products = computed(() => current.value?.products || {})
const funnel = computed(() => current.value?.funnel || {})
const distributions = computed(() => current.value?.distributions || {})

const overviewCards = computed(() => [
  '商品访问次数', '商品访问人数', '商品曝光次数', '商品曝光人数',
  '商品浏览次数', '商品浏览人数', '支付笔数', '支付金额（元）',
].map((label) => ({ label, record: overview.value[label] })))

const productCards = computed(() => [
  '在线商品数', '被浏览商品数', '动销商品数',
].map((label) => ({ label, record: products.value[label] })))

const sourceRows = computed(() => entriesWithValue(distributions.value['来源分布']))
const timeRows = computed(() => entriesWithValue(distributions.value['时间分布']))
const regionRows = computed(() => entriesWithValue(distributions.value['地域分布']).slice(0, 12))

const historyRows = computed(() =>
  records.value.map((row) => {
    const range1 = row.payload?.range1 || {}
    return {
      at: row.captured_at,
      visits: range1.overview?.['商品访问次数']?.value ?? '—',
      exposure: range1.overview?.['商品曝光次数']?.value ?? '—',
      views: range1.overview?.['商品浏览次数']?.value ?? '—',
      pay: range1.overview?.支付笔数?.value ?? '—',
      complete: row.complete,
      reason: row.reason,
    }
  }),
)

function parsePercent(value) {
  const number = parseFloat(String(value ?? '').replace('%', ''))
  return Number.isFinite(number) ? number : 0
}

function entriesWithValue(obj) {
  if (!obj || typeof obj !== 'object') return []
  return Object.entries(obj)
    .map(([label, value]) => ({ label, value, percent: parsePercent(value) }))
    .sort((a, b) => b.percent - a.percent)
}

function formatValue(record) {
  if (!record || record.value === null || record.value === undefined || record.value === '') return '—'
  return record.value
}

function formatPrev(record) {
  if (!record || record.prev === null || record.prev === undefined || record.prev === '') return '—'
  return record.prev
}

function formatDelta(record) {
  if (!record || !record.delta || record.delta === '-') return '—'
  return record.delta
}

function deltaTone(record) {
  const value = parsePercent(record?.delta)
  if (!record?.delta || record.delta === '-') return 'text-gray-400'
  return value > 0 ? 'text-success' : value < 0 ? 'text-danger' : 'text-gray-400'
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    records.value = (await fetchShopMetrics(props.config, props.session, props.onSession || undefined)) || []
  } catch (err) {
    error.value = err?.message || '读取全店数据失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="mx-auto w-full max-w-[1440px] space-y-5">
    <header class="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
      <div>
        <h1 class="text-2xl font-black tracking-tight text-gray-900">全店数据</h1>
        <p class="mt-1 text-sm text-gray-500">
          卖家数据总览的本地留存：每次在本地程序点「抓取全店数据」，这里即可按天对比分析。
        </p>
      </div>
      <div class="flex items-center gap-2">
        <div class="flex rounded-lg bg-gray-100 p-1">
          <button
            v-for="option in [{ key: 'range1', label: '近 1 天' }, { key: 'range7', label: '近 7 天' }]"
            :key="option.key"
            class="rounded-md px-3 py-1.5 text-xs font-semibold"
            :class="rangeKey === option.key ? 'tab-active' : 'tab-inactive'"
            @click="rangeKey = option.key"
          >
            {{ option.label }}
          </button>
        </div>
        <button class="btn btn-outline" :disabled="loading" @click="load">
          <i class="fa-solid fa-arrows-rotate" :class="loading ? 'animate-spin' : ''" />刷新
        </button>
      </div>
    </header>

    <section v-if="error" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-danger">
      {{ error }}
    </section>
    <section v-else-if="loading" class="apple-card text-center text-sm text-gray-400">
      <i class="fa-solid fa-circle-notch mr-2 animate-spin" />正在读取全店数据…
    </section>
    <section v-else-if="!latest" class="apple-card text-center">
      <i class="fa-solid fa-chart-line mb-3 text-3xl text-gray-300" />
      <p class="font-semibold text-gray-700">暂无全店数据</p>
      <p class="mt-1 text-sm text-gray-500">请在本地 goofish 程序「商品活力」页点击「抓取全店数据」。</p>
    </section>

    <template v-else>
      <section
        v-if="!latest.complete"
        class="flex gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950"
      >
        <i class="fa-solid fa-triangle-exclamation mt-0.5 text-lg" />
        <div>
          <p class="font-bold">本次抓取不完整</p>
          <p class="mt-1 text-sm">{{ latest.reason || '页面未加载出完整数据' }}</p>
          <p class="mt-1 text-xs">数据时间：{{ latest.captured_at }}</p>
        </div>
      </section>

      <div v-else class="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 text-xs text-gray-500">
        <span><i class="fa-regular fa-clock mr-1" />抓取时间：{{ latest.captured_at }}</span>
        <span class="text-success"><i class="fa-solid fa-circle-check mr-1" />抓取完整</span>
        <span class="ml-auto">共 {{ records.length }} 次记录</span>
      </div>

      <section class="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div v-for="card in overviewCards" :key="card.label" class="apple-card p-4">
          <p class="text-[11px] font-bold uppercase tracking-wider text-gray-500">{{ card.label }}</p>
          <p class="mt-2 text-2xl font-black tabular-nums text-gray-900">{{ formatValue(card.record) }}</p>
          <p class="mt-1 text-[11px] text-gray-400">
            前1日 {{ formatPrev(card.record) }}
            <span class="ml-1 font-semibold" :class="deltaTone(card.record)">{{ formatDelta(card.record) }}</span>
          </p>
        </div>
      </section>

      <section class="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div v-for="card in productCards" :key="card.label" class="apple-card p-4">
          <p class="text-[11px] font-bold uppercase tracking-wider text-gray-500">{{ card.label }}</p>
          <p class="mt-2 text-2xl font-black tabular-nums text-gray-900">{{ formatValue(card.record) }}</p>
          <p class="mt-1 text-[11px] text-gray-400">
            前1日 {{ formatPrev(card.record) }}
            <span class="ml-1 font-semibold" :class="deltaTone(card.record)">{{ formatDelta(card.record) }}</span>
          </p>
        </div>
      </section>

      <section v-if="rangeKey === 'range1' && Object.keys(funnel).length" class="apple-card">
        <p class="text-sm font-bold text-gray-800">转化漏斗</p>
        <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div class="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <p class="text-[10px] font-bold uppercase text-gray-400">商品曝光人数</p>
            <p class="mt-1 font-mono text-lg font-bold text-gray-900">{{ funnel['商品曝光人数'] || '—' }}</p>
          </div>
          <div class="rounded-lg border border-sky-200 bg-sky-50 p-3">
            <p class="text-[10px] font-bold uppercase text-gray-400">商品详情曝光人数</p>
            <p class="mt-1 font-mono text-lg font-bold text-primary">{{ funnel['商品详情曝光人数'] || '—' }}</p>
          </div>
          <div class="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <p class="text-[10px] font-bold uppercase text-gray-400">支付人数</p>
            <p class="mt-1 font-mono text-lg font-bold text-gray-900">{{ funnel['支付人数'] || '—' }}</p>
          </div>
        </div>
      </section>

      <section v-if="rangeKey === 'range1'" class="grid gap-4 lg:grid-cols-3">
        <div class="apple-card">
          <p class="text-sm font-bold text-gray-800">浏览来源</p>
          <div class="mt-3 space-y-2">
            <div v-for="row in sourceRows" :key="row.label">
              <div class="flex justify-between text-xs text-gray-600">
                <span>{{ row.label }}</span>
                <span class="font-mono font-semibold">{{ row.value }}</span>
              </div>
              <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-100">
                <div class="h-full rounded-full bg-primary" :style="{ width: `${Math.min(row.percent, 100)}%` }"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="apple-card">
          <p class="text-sm font-bold text-gray-800">浏览时间</p>
          <div class="mt-3 space-y-2">
            <div v-for="row in timeRows" :key="row.label">
              <div class="flex justify-between text-xs text-gray-600">
                <span>{{ row.label }}</span>
                <span class="font-mono font-semibold">{{ row.value }}</span>
              </div>
              <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-100">
                <div class="h-full rounded-full bg-warning" :style="{ width: `${Math.min(row.percent * 3, 100)}%` }"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="apple-card">
          <p class="text-sm font-bold text-gray-800">地域分布（前 12）</p>
          <div class="mt-3 space-y-1.5">
            <div v-for="row in regionRows" :key="row.label" class="flex items-center justify-between text-xs text-gray-600">
              <span>{{ row.label }}</span>
              <span class="font-mono font-semibold">{{ row.value }}</span>
            </div>
          </div>
        </div>
      </section>

      <section class="apple-card p-0">
        <div class="border-b border-gray-100 px-5 py-3 text-sm font-bold text-gray-800">历史抓取</div>
        <div class="overflow-x-auto">
          <table class="apple-table min-w-[640px]">
            <thead>
              <tr>
                <th>抓取时间</th>
                <th class="text-center">访问次数</th>
                <th class="text-center">曝光次数</th>
                <th class="text-center">浏览次数</th>
                <th class="text-center">支付笔数</th>
                <th class="text-right">状态</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in historyRows" :key="row.at">
                <td class="text-xs text-gray-500">{{ row.at }}</td>
                <td class="text-center font-mono font-bold">{{ row.visits }}</td>
                <td class="text-center font-mono font-bold">{{ row.exposure }}</td>
                <td class="text-center font-mono font-bold">{{ row.views }}</td>
                <td class="text-center font-mono font-bold">{{ row.pay }}</td>
                <td class="text-right">
                  <span v-if="row.complete" class="text-xs font-semibold text-success">完整</span>
                  <span v-else class="text-xs font-semibold text-warning" :title="row.reason || ''">不完整</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
