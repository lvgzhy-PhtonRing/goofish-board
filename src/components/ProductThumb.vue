<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  itemId: { type: String, default: '' },
  picUrl: { type: String, default: '' },
  base: { type: String, default: '' },
  size: { type: Number, default: 28 },
})

// 0 = 云端缩略图，1 = 闲鱼原链接，2 = 占位
const stage = ref(0)

const src = computed(() => {
  if (stage.value === 0 && props.itemId && props.base) {
    return `${props.base}/storage/v1/object/public/goofish-images/thumbs/${props.itemId}.webp`
  }
  if (stage.value <= 1 && props.picUrl) return props.picUrl
  return ''
})

const boxStyle = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }))
const iconSize = computed(() => `${Math.max(10, Math.round(props.size / 3))}px`)

function onError() {
  if (stage.value < 2) stage.value += 1
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
    />
    <div v-else class="grid h-full w-full place-items-center text-gray-300">
      <i class="fa-regular fa-image" :style="{ fontSize: iconSize }"></i>
    </div>
  </div>
</template>
