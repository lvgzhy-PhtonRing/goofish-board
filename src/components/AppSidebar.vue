<script setup>
defineProps({
  currentTab: { type: String, required: true },
  email: { type: String, default: '' },
})

const emit = defineEmits(['select', 'logout'])

const items = [
  { id: 'vitality', name: '商品活力', icon: 'fa-solid fa-chart-simple' },
  { id: 'republish', name: '重发看板', icon: 'fa-solid fa-rotate' },
]

function tone(tab, currentTab) {
  return currentTab === tab ? 'background:#eff6ff;color:#0066cc;' : 'color:#4b5563;'
}
</script>

<template>
  <aside class="z-10 flex h-screen w-56 shrink-0 flex-col border-r border-gray-200 bg-white">
    <div class="flex-1">
      <div class="h-20 border-b border-gray-100 px-5 py-4">
        <div class="text-xl font-bold tracking-wide text-gray-800">店铺管理</div>
        <div class="mt-1 text-[11px] text-gray-400">PhotonRing</div>
      </div>

      <nav class="space-y-4 p-4">
        <div class="flex gap-3">
          <div class="w-1 self-stretch rounded-full bg-gray-200"></div>
          <div class="flex-1 space-y-1">
            <button
              v-for="item in items"
              :key="item.id"
              class="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-base font-bold transition-all"
              :style="tone(item.id, currentTab)"
              @click="emit('select', item.id)"
            >
              <i :class="item.icon + ' w-5 text-center'" />
              {{ item.name }}
            </button>
          </div>
        </div>
      </nav>
    </div>

    <div class="space-y-2 border-t border-gray-100 p-4">
      <div class="truncate px-1 text-[11px] text-gray-400">{{ email }}</div>
      <a
        href="https://lvgzhy-phtonring.github.io/Ysp-app/"
        target="_blank"
        rel="noopener"
        class="flex w-full items-center gap-2 rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
      >
        <i class="fa-solid fa-arrow-left w-4 text-center" />返回主程序
      </a>
      <button
        class="flex w-full items-center gap-2 rounded-lg px-4 py-2 text-left text-sm text-gray-500 hover:bg-gray-50"
        @click="emit('logout')"
      >
        <i class="fa-solid fa-right-from-bracket w-4 text-center" />退出登录
      </button>
    </div>
  </aside>
</template>
