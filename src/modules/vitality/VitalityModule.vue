<script setup>
import { computed, onMounted, ref } from 'vue'
import { loadRow } from '../../services/supabaseClient.js'
import { parseNumber } from '../../engine/republish.js'
import ProductThumb from '../../components/ProductThumb.vue'

const props = defineProps({
  config: { type: Object, required: true },
  session: { type: Object, default: null },
  onSession: { type: Function, default: null },
})

const loading = ref(true)
const error = ref('')
const payload = ref(null)
const sortKey = ref('exposure')
const sortDir = ref('desc')
const keyword = ref('')

const columns = [
  { key: 'itemId', label: '商品 ID', align: 'left' },
  { key: 'title', label: '标题', align: 'left' },
  { key: 'price', label: '价格', align: 'right' },
  { key: 'stock', label: '库存', align: 'center' },
  { key: 'sales', label: '销量', align: 'center' },
  { key: 'createTime', label: '上架时间', align: 'left' },
  { key: 'exposure', label: '曝光', align: 'center', metric: true },
  { key: 'viewCount', label: '浏览', align: 'center', metric: true },
  { key: 'ctr', label: '点击率', align: 'center', metric: true },
  { key: 'inquiry', label: '询单', align: 'center', metric: true },
  { key: 'payCount', label: '支付人数', align: 'center', metric: true },
  { key: 'conversion', label: '转化率', align: 'center', metric: true },
]

const totalCount = computed(() => (Array.isArray(payload.value?.vitality) ? payload.value.vitality.length : 0))
const isSearching = computed(() => keyword.value.trim().length > 0)

const items = computed(() => {
  let list = Array.isArray(payload.value?.vitality) ? [...payload.value.vitality] : []
  const text = keyword.value.trim().toLowerCase()
  if (text) {
    const priceText = text.replace(/[¥￥\s,]/g, '')
    list = list.filter((item) => {
      const title = String(item.title || '').toLowerCase()
      const itemId = String(item.itemId || '')
      const price = String(item.price || '')
      return title.includes(text) || itemId.includes(text) || (priceText !== '' && price.includes(priceText))
    })
  }
  list = list.map((item) => {
    const exposure = parseNumber(item.exposure)
    const views = parseNumber(item.viewCount)
    const ctr = exposure !== null && exposure > 0 && views !== null ? (views / exposure) * 100 : null
    return { ...item, ctr }
  })
  const key = sortKey.value
  const dir = sortDir.value === 'asc' ? 1 : -1
  list.sort((a, b) => {
    const av = a[key]
    const bv = b[key]
    const na = parseNumber(av)
    const nb = parseNumber(bv)
    if (na !== null && nb !== null) return (na - nb) * dir
    // 非数值（含缺失指标）统一排在末尾，保证比较器可传递
    if (na !== null) return -1
    if (nb !== null) return 1
    return String(av ?? '').localeCompare(String(bv ?? '')) * dir
  })
  return list
})

const fetchedAt = computed(() => payload.value?.fetched_at || '—')
const range = computed(() => `近${payload.value?.range || '7'}天`)
const complete = computed(() => payload.value?.complete !== false)
const count = computed(() => items.value.length)

function inquiryTone(item) {
  if (item.metricsMissing) return 'text-gray-300'
  const value = parseNumber(item.inquiry)
  if (value === null) return 'text-gray-300'
  return value > 0 ? 'text-primary' : 'text-gray-400'
}

function conversionTone(item) {
  if (item.metricsMissing) return 'text-gray-300'
  const value = parseFloat(String(item.conversion || '').replace('%', ''))
  if (!Number.isFinite(value) || value <= 0) return 'text-gray-400'
  return 'text-success'
}

function ctrTone(item) {
  if (item.metricsMissing || item.ctr === null) return 'text-gray-300'
  if (item.ctr < 0.8) return 'text-danger'
  if (item.ctr < 1.5) return 'text-warning'
  return 'text-success'
}

function toggleSort(key) {
  if (sortKey.value === key) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else {
    sortKey.value = key
    sortDir.value = 'desc'
  }
}

function cellValue(item, column) {
  if (column.metric && item.metricsMissing) return '—'
  const value = item[column.key]
  return value === null || value === undefined || value === '' ? '—' : value
}

function alignClass(column) {
  return column.align === 'right' ? 'text-right' : column.align === 'center' ? 'text-center' : 'text-left'
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const { payload: row } = await loadRow(props.config, 'goofish_vitality', props.session, {
      onSession: props.onSession || undefined,
    })
    payload.value = row
  } catch (err) {
    error.value = err?.message || '读取商品活力失败'
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
        <h1 class="text-2xl font-black tracking-tight text-gray-900">商品活力</h1>
        <p class="mt-1 text-sm text-gray-500">
          每件商品的库存、价格与曝光/浏览/询单/支付转化。数据由本地 goofish 程序导入后同步。
        </p>
      </div>
      <div class="flex items-center gap-2">
        <input v-model="keyword" class="apple-input w-56" type="search" placeholder="搜索名称 / ID / 价格" />
        <button class="btn btn-outline" :disabled="loading" @click="load">
          <i class="fa-solid fa-arrows-rotate" :class="loading ? 'animate-spin' : ''" />刷新
        </button>
      </div>
    </header>

    <section
      v-if="error"
      class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-danger"
    >
      {{ error }}
    </section>

    <section v-else-if="!loading && !payload" class="apple-card text-center">
      <i class="fa-solid fa-cloud-arrow-down mb-3 text-3xl text-gray-300" />
      <p class="font-semibold text-gray-700">云端暂无商品活力数据</p>
      <p class="mt-1 text-sm text-gray-500">请在本地 goofish 程序导入 Excel 后点击「同步到云」。</p>
    </section>

    <template v-else>
      <div v-if="payload" class="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 text-xs text-gray-500">
        <span><i class="fa-regular fa-clock mr-1" />数据时间：{{ fetchedAt }}</span>
        <span>口径：{{ range }}</span>
        <span :class="complete ? 'text-success' : 'text-warning'">
          {{ complete ? '完整' : '不完整（部分页未抓满）' }}
        </span>
        <span class="ml-auto font-semibold text-gray-700">
          共 {{ totalCount }} 件<span v-if="isSearching" class="ml-1 text-primary">（匹配 {{ count }} 件）</span>
        </span>
      </div>

      <div class="apple-card overflow-x-auto p-0">
        <table class="apple-table min-w-[1100px]">
          <thead>
            <tr>
              <th
                v-for="column in columns"
                :key="column.key"
                class="cursor-pointer select-none whitespace-nowrap"
                :class="[alignClass(column), column.key === 'itemId' ? 'w-[84px]' : '']"
                @click="toggleSort(column.key)"
              >
                {{ column.label }}
                <i
                  class="fa-solid ml-1 text-[10px]"
                  :class="sortKey === column.key ? (sortDir === 'asc' ? 'fa-arrow-up-short-wide' : 'fa-arrow-down-wide-short') : 'fa-sort text-gray-300'"
                />
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td :colspan="columns.length" class="py-10 text-center text-sm text-gray-400">
                <i class="fa-solid fa-circle-notch mr-2 animate-spin" />正在读取…
              </td>
            </tr>
            <tr v-else-if="items.length === 0">
              <td :colspan="columns.length" class="py-10 text-center text-sm text-gray-400">
                <i class="fa-solid fa-magnifying-glass mr-2" />没有匹配的商品
              </td>
            </tr>
            <tr v-for="item in items" v-else :key="item.itemId">
              <td v-for="column in columns" :key="column.key" :class="alignClass(column)" :title="column.key === 'title' ? item.title : undefined">
                <template v-if="column.key === 'title'">
                  <div class="flex items-center gap-2">
                    <ProductThumb :item-id="item.itemId" :pic-url="item.picUrl" :base="config.supabaseUrl" :size="28" />
                    <span class="block max-w-[240px] truncate">{{ cellValue(item, column) }}</span>
                  </div>
                </template>
                <template v-else-if="column.key === 'price'">
                  <span class="font-semibold text-gray-900">¥{{ cellValue(item, column) }}</span>
                </template>
                <template v-else-if="column.key === 'itemId'">
                  <span class="block w-[80px] truncate font-mono text-xs text-gray-500" :title="item.itemId">{{ item.itemId }}</span>
                </template>
                <template v-else-if="column.key === 'createTime'">
                  <span class="whitespace-nowrap">{{ String(cellValue(item, column)).slice(0, 10) }}</span>
                </template>
                <template v-else-if="column.key === 'ctr'">
                  <span :class="ctrTone(item)">
                    {{ item.metricsMissing || item.ctr === null ? '—' : item.ctr.toFixed(2) + '%' }}
                  </span>
                </template>
                <template v-else-if="column.key === 'inquiry'">
                  <span :class="inquiryTone(item)">{{ cellValue(item, column) }}</span>
                </template>
                <template v-else-if="column.key === 'conversion'">
                  <span :class="conversionTone(item)">{{ cellValue(item, column) }}</span>
                </template>
                <template v-else-if="column.metric">
                  <span :class="item.metricsMissing ? 'text-gray-300' : 'font-mono'">{{ cellValue(item, column) }}</span>
                </template>
                <template v-else>{{ cellValue(item, column) }}</template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
