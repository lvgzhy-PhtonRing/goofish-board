<script setup>
import { computed, onMounted, ref } from 'vue'
import { fetchEvents } from '../../services/automationApi.js'
import { loadRow } from '../../services/supabaseClient.js'
import { eventSourceMeta } from '../../services/dataSources.js'
import ProductThumb from '../../components/ProductThumb.vue'

const props = defineProps({
  config: { type: Object, required: true },
  session: { type: Object, default: null },
  onSession: { type: Function, default: null },
})

const events = ref([])
const itemMeta = ref({})
const loading = ref(true)
const error = ref('')
const keyword = ref('')

const TYPE_ORDER = [
  'discovered',
  'repost',
  'price_change',
  'title_change',
  'image_change',
  'pay_increment',
  'sold',
  'refund_increment',
  'offline',
]

const typeLabels = {
  discovered: '上新',
  sold: '售出',
  offline: '下架',
  repost: '重新上新',
  price_change: '改价',
  title_change: '改标题',
  image_change: '换首图',
  pay_increment: '成交',
  refund_increment: '退款',
}

const typeIcons = {
  discovered: 'fa-solid fa-circle-plus',
  sold: 'fa-solid fa-sack-dollar',
  offline: 'fa-solid fa-circle-minus',
  repost: 'fa-solid fa-rotate',
  price_change: 'fa-solid fa-tag',
  title_change: 'fa-solid fa-pen',
  image_change: 'fa-regular fa-image',
  pay_increment: 'fa-solid fa-coins',
  refund_increment: 'fa-solid fa-rotate-left',
}

const typeColors = {
  discovered: 'text-success',
  sold: 'text-primary',
  offline: 'text-danger',
  repost: 'text-violet-600',
  price_change: 'text-warning',
  title_change: 'text-gray-500',
  image_change: 'text-gray-500',
  pay_increment: 'text-primary',
  refund_increment: 'text-danger',
}

const enriched = computed(() => {
  const text = keyword.value.trim().toLowerCase()
  return events.value
    .filter((event) => {
      if (!text) return true
      const meta = itemMeta.value[event.item_id] || {}
      const title = String(event.data?.title || meta.title || '').toLowerCase()
      return title.includes(text) || String(event.item_id || '').includes(text)
    })
    .map((event) => {
      const meta = itemMeta.value[event.item_id] || {}
      return {
        ...event,
        title: event.data?.title || meta.title || '',
        price: event.data?.price || event.data?.amount || meta.price || '',
        picUrl: event.data?.picUrl || meta.picUrl || '',
      }
    })
})

const months = computed(() => {
  const byDate = new Map()
  for (const event of enriched.value) {
    const day = String(event.occurred_at || '').slice(0, 10)
    if (!day) continue
    if (!byDate.has(day)) byDate.set(day, new Map())
    const dayMap = byDate.get(day)
    const type = event.type
    if (!dayMap.has(type)) dayMap.set(type, { type, items: [] })
    dayMap.get(type).items.push(event)
  }

  const days = [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, typeMap]) => ({
      day,
      blocks: [...typeMap.values()].sort(
        (a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type),
      ),
    }))

  const monthMap = new Map()
  for (const entry of days) {
    const month = entry.day.slice(0, 7)
    if (!monthMap.has(month)) monthMap.set(month, [])
    monthMap.get(month).push(entry)
  }
  return [...monthMap.entries()].map(([month, dayList]) => ({
    month,
    label: `${Number(month.slice(5, 7))} 月`,
    days: dayList,
  }))
})

const totalEvents = computed(() => enriched.value.length)

function blockTitle(block) {
  const count = block.items.length
  const map = {
    discovered: `上新了 ${count} 件宝贝`,
    offline: `下架了 ${count} 件宝贝`,
    sold: `售出 ${count} 件宝贝`,
    pay_increment: `成交 ${count} 件宝贝`,
    repost: `重新上新 ${count} 件宝贝`,
    price_change: `改价 ${count} 件宝贝`,
    title_change: `修改标题 ${count} 件宝贝`,
    image_change: `更换首图 ${count} 件宝贝`,
    refund_increment: `退款 ${count} 单`,
  }
  return map[block.type] || `${typeLabels[block.type] || block.type} ${count} 件`
}

function eventDetail(event) {
  const data = event.data || {}
  switch (event.type) {
    case 'price_change':
      return `${data.from ?? '—'} → ${data.to ?? '—'}`
    case 'title_change':
      return `标题修改：${String(data.from || '').slice(0, 16)} → ${String(data.to || '').slice(0, 16)}`
    case 'repost':
      return `关联旧商品 ${data.matched || ''}（置信度 ${data.score ?? '—'}）`
    case 'pay_increment':
      return `+${data.orderDelta ?? 0} 单 / +¥${data.amountDelta ?? 0}`
    case 'refund_increment':
      return `+${data.orderDelta ?? 0} 单退款`
    case 'sold':
      return data.saleDate ? `销售日期 ${data.saleDate}` : ''
    default:
      return ''
  }
}

function dayNumber(day) {
  return String(Number(day.slice(8, 10)))
}

function formatTime(input) {
  const value = typeof input === 'string' ? input : input?.occurred_at
  if (input && typeof input === 'object' && input.data?.dateOnly) return '日期补录'
  if (!value) return ''
  const date = new Date(String(value).replace(' ', 'T'))
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [eventRows, vitality] = await Promise.all([
      fetchEvents(props.config, props.session, props.onSession || undefined),
      loadRow(props.config, 'goofish_vitality', props.session, { onSession: props.onSession || undefined }),
    ])
    events.value = eventRows || []
    const meta = {}
    for (const entry of vitality?.payload?.vitality || []) {
      if (!entry?.itemId) continue
      meta[String(entry.itemId)] = {
        title: entry.title || '',
        price: entry.price || '',
        picUrl: entry.picUrl || '',
      }
    }
    itemMeta.value = meta
  } catch (err) {
    error.value = err?.message || '读取店铺动态失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="mx-auto w-full max-w-[1100px] space-y-5">
    <header class="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
      <div>
        <h1 class="text-2xl font-black tracking-tight text-gray-900">店铺动态</h1>
        <p class="mt-1 text-sm text-gray-500">
          上新、改价、成交、下架与重新上新的历史流水线；可与全店数据、商品活力交叉分析。
        </p>
      </div>
      <div class="flex items-center gap-2">
        <input v-model="keyword" class="apple-input w-56" type="search" placeholder="搜索标题或商品 ID" />
        <button class="btn btn-outline" :disabled="loading" @click="load">
          <i class="fa-solid fa-arrows-rotate" :class="loading ? 'animate-spin' : ''" />刷新
        </button>
      </div>
    </header>

    <section v-if="error" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-danger">
      {{ error }}
    </section>
    <section v-else-if="loading" class="apple-card text-center text-sm text-gray-400">
      <i class="fa-solid fa-circle-notch mr-2 animate-spin" />正在读取动态…
    </section>
    <section v-else-if="!months.length" class="apple-card text-center">
      <i class="fa-solid fa-timeline mb-3 text-3xl text-gray-300" />
      <p class="font-semibold text-gray-700">暂无店铺动态</p>
      <p class="mt-1 text-sm text-gray-500">导入 Excel 后，系统会自动记录上新/改价/成交/下架等事件。</p>
    </section>

    <template v-else>
      <div class="text-xs text-gray-400">共 {{ totalEvents }} 条动态</div>

      <section v-for="month in months" :key="month.month" class="space-y-6">
        <h2 class="text-2xl font-black tracking-tight text-gray-900">{{ month.label }}</h2>

        <div v-for="day in month.days" :key="day.day" class="relative pl-14">
          <div class="absolute left-0 top-0 text-2xl font-black leading-none text-gray-900">
            {{ dayNumber(day.day) }}
          </div>
          <div class="absolute left-[15px] top-9 h-[calc(100%-2.25rem)] w-px bg-gray-200"></div>

          <div class="space-y-5">
            <div v-for="block in day.blocks" :key="block.type">
              <p class="flex flex-wrap items-center gap-2 text-sm font-semibold text-gray-500">
                <i :class="[typeIcons[block.type] || 'fa-solid fa-circle', typeColors[block.type] || 'text-gray-400']" />
                {{ blockTitle(block) }}
                <span class="rounded px-1.5 py-0.5 text-[10px] font-bold" :class="eventSourceMeta(block.items[0]).badge">
                  {{ eventSourceMeta(block.items[0]).label }}
                </span>
                <span class="text-xs font-normal text-gray-300">{{ formatTime(block.items[0]) }}</span>
              </p>

              <div class="mt-2 space-y-2">
                <div
                  v-for="item in block.items"
                  :key="item.id"
                  class="flex items-center gap-3 rounded-xl border border-gray-100 bg-white p-2.5"
                >
                  <ProductThumb
                    :item-id="item.item_id || ''"
                    :pic-url="item.picUrl"
                    :base="config.supabaseUrl"
                    :size="52"
                  />
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-semibold text-gray-800">
                      {{ item.title || item.item_id }}
                    </p>
                    <p v-if="eventDetail(item)" class="mt-0.5 truncate text-xs text-gray-400">
                      {{ eventDetail(item) }}
                    </p>
                  </div>
                  <span v-if="item.price" class="shrink-0 font-mono text-sm font-bold text-danger">
                    ¥{{ item.price }}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
