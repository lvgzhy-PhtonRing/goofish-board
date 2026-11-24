<script setup>
import { computed, onMounted, ref } from 'vue'
import { fetchPending, resolvePending } from '../../services/automationApi.js'
import ProductThumb from '../../components/ProductThumb.vue'

const props = defineProps({
  config: { type: Object, required: true },
  session: { type: Object, default: null },
  onSession: { type: Function, default: null },
})

const items = ref([])
const loading = ref(false)
const error = ref('')
const expanded = ref(false)
const resolving = ref('')
const toast = ref('')

const count = computed(() => items.value.length)

async function load() {
  loading.value = true
  error.value = ''
  try {
    items.value = (await fetchPending(props.config, props.session, props.onSession || undefined)) || []
  } catch (err) {
    error.value = err?.message || '读取待确认项失败'
  } finally {
    loading.value = false
  }
}

async function choose(item, value) {
  resolving.value = item.id
  error.value = ''
  try {
    await resolvePending(props.config, props.session, item.id, value, props.onSession || undefined)
    toast.value = '已记录'
    setTimeout(() => { toast.value = '' }, 2000)
    await load()
    if (!items.value.length) expanded.value = false
  } catch (err) {
    error.value = err?.message || '提交失败'
  } finally {
    resolving.value = ''
  }
}

async function acceptAll() {
  const list = [...items.value]
  for (const item of list) {
    if (item.suggestion) await choose(item, item.suggestion)
  }
}

onMounted(load)
</script>

<template>
  <section class="space-y-3">
    <button
      class="flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition-all"
      :class="count ? 'border-amber-200 bg-amber-50 hover:bg-amber-100' : 'border-gray-200 bg-white'"
      @click="expanded = !expanded; count && load()"
    >
      <span class="flex items-center gap-2 text-sm font-semibold" :class="count ? 'text-amber-900' : 'text-gray-500'">
        <i class="fa-solid" :class="count ? 'fa-triangle-exclamation' : 'fa-circle-check'" />
        {{ count ? `本次导入有 ${count} 项待确认` : '暂无待确认项' }}
        <i v-if="loading" class="fa-solid fa-circle-notch animate-spin text-xs" />
      </span>
      <span v-if="count" class="text-xs font-semibold text-amber-800">
        {{ expanded ? '收起' : '去处理' }}
        <i class="fa-solid" :class="expanded ? 'fa-chevron-up' : 'fa-chevron-right'"></i>
      </span>
    </button>

    <div v-if="expanded && count" class="apple-card space-y-3">
      <div class="flex items-center justify-between">
        <p class="text-sm font-bold text-gray-800">待确认清单</p>
        <button class="btn btn-outline btn-sm" :disabled="!!resolving" @click="acceptAll">
          <i class="fa-solid fa-check-double" />全部按建议处理
        </button>
      </div>

      <p v-if="error" class="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-danger">{{ error }}</p>
      <p v-if="toast" class="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-semibold text-success">{{ toast }}</p>

      <div v-for="item in items" :key="item.id" class="rounded-lg border border-gray-200 bg-gray-50/60 p-3">
        <div class="flex items-start gap-2">
          <ProductThumb :item-id="item.item_id || ''" :base="config.supabaseUrl" :size="24" />
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold text-gray-800">{{ item.question }}</p>
          </div>
        </div>
        <p v-if="item.extra && item.extra.matched" class="mt-1 text-xs text-gray-400">
          匹配：{{ item.extra.matched }}（置信度 {{ item.extra.score }}）
        </p>
        <div class="mt-2 flex flex-wrap gap-2">
          <button
            v-for="option in item.options"
            :key="option.value"
            class="btn btn-sm"
            :class="item.suggestion === option.value ? 'btn-primary' : 'btn-outline'"
            :disabled="!!resolving"
            @click="choose(item, option.value)"
          >
            <i v-if="resolving === item.id" class="fa-solid fa-circle-notch animate-spin" />
            {{ option.label }}
            <span v-if="item.suggestion === option.value" class="text-[10px] opacity-80">建议</span>
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
