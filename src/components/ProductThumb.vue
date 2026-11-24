<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  itemId: { type: String, default: '' },
  picUrl: { type: String, default: '' },
  base: { type: String, default: '' },
  size: { type: Number, default: 28 },
})

const MAX_CACHE_BYTES = 200 * 1024
const MAX_CACHE_KEYS = 3000

// stage: 0 = 云端缩略图，1 = 闲鱼原链接，2 = 占位
const stage = ref(0)
const localData = ref('')

function hash(value) {
  let result = 0
  const text = String(value || '')
  for (let i = 0; i < text.length; i += 1) result = (result * 31 + text.charCodeAt(i)) | 0
  return Math.abs(result).toString(36)
}

const cacheKey = computed(() => `gf_thumb_${props.itemId}_${hash(props.picUrl)}`)

function readLocal() {
  try {
    localData.value = localStorage.getItem(cacheKey.value) || ''
  } catch {
    localData.value = ''
  }
}

watch(cacheKey, readLocal, { immediate: true })

const cloudThumb = computed(() =>
  props.itemId && props.base
    ? `${props.base}/storage/v1/object/public/goofish-images/thumbs/${props.itemId}.webp`
    : '',
)

const src = computed(() => {
  if (localData.value) return localData.value
  if (stage.value === 0 && cloudThumb.value) return cloudThumb.value
  if (stage.value <= 1 && props.picUrl) return props.picUrl
  return ''
})

const boxStyle = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }))
const iconSize = computed(() => `${Math.max(10, Math.round(props.size / 3))}px`)

function onError() {
  if (stage.value < 2) stage.value += 1
}

function trimCache() {
  try {
    const keys = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key && key.startsWith('gf_thumb_')) keys.push(key)
    }
    if (keys.length <= MAX_CACHE_KEYS) return
    for (const key of keys.slice(0, keys.length - MAX_CACHE_KEYS + 200)) {
      localStorage.removeItem(key)
    }
  } catch {
    // 忽略
  }
}

async function cacheImage(url) {
  try {
    const resp = await fetch(url)
    if (!resp.ok) return
    const blob = await resp.blob()
    if (!blob.size || blob.size > MAX_CACHE_BYTES) return
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => resolve('')
      reader.readAsDataURL(blob)
    })
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
      trimCache()
      localStorage.setItem(cacheKey.value, dataUrl)
    }
  } catch {
    // 本地存储已满或网络不可用：静默忽略，下次仍走云端
  }
}

function onLoad() {
  const url = src.value
  if (!url || url.startsWith('data:') || !cacheKey.value || localData.value) return
  void cacheImage(url)
}
</script>

<template>
  <div
    class="shrink-0 overflow-hidden rounded-md border border-gray-200 bg-gray-50"
    :style="boxStyle"
  >
    <img
      v-if="src"
      :src="src"
      alt=""
      loading="lazy"
      referrerpolicy="no-referrer"
      class="h-full w-full object-cover"
      @error="onError"
      @load="onLoad"
    />
    <div v-else class="grid h-full w-full place-items-center text-gray-300">
      <i class="fa-regular fa-image" :style="{ fontSize: iconSize }"></i>
    </div>
  </div>
</template>
