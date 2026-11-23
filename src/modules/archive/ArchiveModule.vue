<script setup>
import { computed, onMounted, ref } from 'vue'
import { fetchEvents } from '../../services/automationApi.js'

const props = defineProps({
  config: { type: Object, required: true },
  session: { type: Object, default: null },
  onSession: { type: Function, default: null },
})

const events = ref([])
const loading = ref(true)
const error = ref('')
const keyword = ref('')
const expanded = ref(null)

const typeLabels = {
  discovered: '新上架',
  sold: '售出',
  offline: '下架',
  repost: '重发',
  price_change: '改价',
  title_change: '改标题',
  image_change: '换首图',
  pay_increment: '成交',
  refund_increment: '退款',
}

const typeIcons = {
  discovered: 'fa-solid fa-plus',
  sold: 'fa-solid fa-sack-dollar',
  offline: 'fa-solid fa-arrow-down',
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

const groups = computed(() => {
  const map = new Map()
  for (const event of events.value) {
    const key = event.lineage_id || event.item_id || 'unknown'
    if (!map.has(key)) {
      map.set(key, {
        key,
        title: '',
        itemIds: new Set(),
        counts: {},
        lastAt: '',
        timeline: [],
      })
    }
    const group = map.get(key)
    if (event.item_id) group.itemIds.add(event.item_id)
    const type = event.type
    group.counts[type] = (group.counts[type] || 0) + 1
    if (!group.lastAt || String(event.occurred_at) > group.lastAt) group.lastAt = event.occurred_at
    if (event.data?.title && !group.title) group.title = event.data.title
    if (event.data?.title) group.title = event.data.title
    group.timeline.push(event)
  }
  return [...map.values()]
    .map((group) => ({
      ...group,
      title: group.title || [...group.itemIds][0] || group.key,
      itemIds: [...group.itemIds],
      timeline: [...group.timeline].sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at))),
    }))
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))
})

const filtered = computed(() => {
  const text = keyword.value.trim().toLowerCase()
  if (!text) return groups.value
  return groups.value.filter(
    (group) =>
      String(group.title).toLowerCase().includes(text) ||
      group.itemIds.some((id) => String(id).includes(text)),
  )
})

function countOf(group, type) {
  return group.counts[type] || 0
}

function toggle(key) {
  expanded.value = expanded.value === key ? null : key
}

function formatTime(value) {
  if (!value) return '—'
  const date = new Date(String(value).replace(' ', 'T'))
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function eventDetail(event) {
  const data = event.data || {}
  switch (event.type) {
    case 'price_change':
      return `${data.from ?? '—'} → ${data.to ?? '—'}`
    case 'title_change':
      return `${data.from ?? '—'} → ${data.to ?? '—'}`
    case 'pay_increment':
      return `+${data.orderDelta ?? 0} 单 / +¥${data.amountDelta ?? 0}`
    case 'refund_increment':
      return `+${data.orderDelta ?? 0} 单退款`
    case 'repost':
      return `关联 ${data.matched || ''}（置信度 ${data.score ?? '—'}）`
    default:
      return data.title || ''
  }
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    events.value = (await fetchEvents(props.config, props.session, props.onSession || undefined)) || []
  } catch (err) {
    error.value = err?.message || '读取商品档案失败'
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
        <h1 class="text-2xl font-black tracking-tight text-gray-900">商品档案</h1>
        <p class="mt-1 text-sm text-gray-500">每件商品的上架、成交、下架与重发历史；按谱系聚合。</p>
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
      <i class="fa-solid fa-circle-notch mr-2 animate-spin" />正在读取档案…
    </section>

    <section v-else-if="!filtered.length" class="apple-card text-center">
      <i class="fa-solid fa-folder-open mb-3 text-3xl text-gray-300" />
      <p class="font-semibold text-gray-700">暂无商品档案</p>
      <p class="mt-1 text-sm text-gray-500">导入 Excel 后，系统会自动记录上架/成交/下架/重发事件。</p>
    </section>

    <div v-else class="apple-card p-0">
      <table class="apple-table">
        <thead>
          <tr>
            <th>商品</th>
            <th class="text-center">上架</th>
            <th class="text-center">下架</th>
            <th class="text-center">成交</th>
            <th class="text-center">重发</th>
            <th class="text-right">最近事件</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="group in filtered" :key="group.key">
            <tr class="cursor-pointer" @click="toggle(group.key)">
              <td>
                <p class="max-w-[380px] truncate font-semibold text-gray-800">{{ group.title }}</p>
                <p class="mt-0.5 font-mono text-[10px] text-gray-400">{{ group.itemIds.join(' · ') }}</p>
              </td>
              <td class="text-center font-mono font-bold text-success">{{ countOf(group, 'discovered') }}</td>
              <td class="text-center font-mono font-bold text-danger">{{ countOf(group, 'offline') }}</td>
              <td class="text-center font-mono font-bold text-primary">{{ countOf(group, 'sold') + countOf(group, 'pay_increment') }}</td>
              <td class="text-center font-mono font-bold text-violet-600">{{ countOf(group, 'repost') }}</td>
              <td class="text-right text-xs text-gray-500">
                {{ formatTime(group.lastAt) }}
                <i class="fa-solid ml-1 text-gray-300" :class="expanded === group.key ? 'fa-chevron-up' : 'fa-chevron-down'"></i>
              </td>
            </tr>
            <tr v-if="expanded === group.key">
              <td colspan="6" class="bg-gray-50/70">
                <ol class="space-y-2 py-2">
                  <li v-for="event in group.timeline" :key="event.id" class="flex items-start gap-3 text-sm">
                    <i :class="[typeIcons[event.type] || 'fa-solid fa-circle', typeColors[event.type] || 'text-gray-400', 'mt-0.5 w-4 text-center']" />
                    <div class="min-w-0 flex-1">
                      <p class="font-semibold text-gray-700">
                        {{ typeLabels[event.type] || event.type }}
                        <span class="ml-2 text-xs font-normal text-gray-400">{{ formatTime(event.occurred_at) }}</span>
                      </p>
                      <p v-if="eventDetail(event)" class="mt-0.5 truncate text-xs text-gray-500">{{ eventDetail(event) }}</p>
                    </div>
                    <span class="font-mono text-[10px] text-gray-400">{{ event.item_id }}</span>
                  </li>
                </ol>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>
