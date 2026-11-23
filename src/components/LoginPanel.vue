<script setup>
import { ref } from 'vue'

const props = defineProps({
  ready: { type: Boolean, default: false },
  onLogin: { type: Function, required: true },
})

const email = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')

async function submit() {
  if (!props.ready) {
    error.value = '云端配置未就绪，无法登录'
    return
  }
  if (!email.value.trim() || !password.value) {
    error.value = '请填写账号和密码'
    return
  }
  loading.value = true
  error.value = ''
  try {
    await props.onLogin({ email: email.value.trim(), password: password.value })
  } catch (err) {
    error.value = err?.message || '登录失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="flex flex-1 items-center justify-center bg-appbg p-6">
    <div class="apple-card w-full max-w-sm">
      <div class="mb-6 flex items-center gap-3">
        <div class="grid h-11 w-11 place-items-center rounded-xl bg-[#eff6ff] text-primary">
          <i class="fa-solid fa-store text-lg" />
        </div>
        <div>
          <h1 class="text-lg font-bold text-gray-800">店铺管理</h1>
          <p class="text-xs text-gray-400">闲鱼商品活力与重发看板</p>
        </div>
      </div>

      <form class="space-y-3" @submit.prevent="submit">
        <label class="block">
          <span class="mb-1 block text-xs font-semibold text-gray-500">账号</span>
          <input v-model="email" class="apple-input" type="email" autocomplete="username" placeholder="邮箱" />
        </label>
        <label class="block">
          <span class="mb-1 block text-xs font-semibold text-gray-500">密码</span>
          <input v-model="password" class="apple-input" type="password" autocomplete="current-password" placeholder="密码" />
        </label>

        <p v-if="error" class="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-danger">{{ error }}</p>
        <p v-if="!ready" class="rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-warning">
          云端配置未就绪，请检查部署流程。
        </p>

        <button class="btn btn-primary w-full" type="submit" :disabled="loading">
          <i v-if="loading" class="fa-solid fa-circle-notch animate-spin" />
          <i v-else class="fa-solid fa-right-to-bracket" />
          登录
        </button>
      </form>

      <a
        href="https://lvgzhy-phtonring.github.io/Ysp-app/"
        target="_blank"
        rel="noopener"
        class="mt-5 flex items-center justify-center gap-2 text-xs text-gray-400 hover:text-primary"
      >
        <i class="fa-solid fa-arrow-left" />返回 YSP 主程序
      </a>
    </div>
  </div>
</template>
