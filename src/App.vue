<script setup>
import { computed, onMounted, ref } from 'vue'
import AppSidebar from './components/AppSidebar.vue'
import LoginPanel from './components/LoginPanel.vue'
import VitalityModule from './modules/vitality/VitalityModule.vue'
import RepublishModule from './modules/republish/RepublishModule.vue'
import {
  hasValidSession,
  isCloudConfigReady,
  readCloudConfig,
  refreshSession,
  signIn,
  signOut,
} from './services/supabaseClient.js'

const SESSION_KEY = 'goofish_session'

const currentTab = ref('vitality')
const config = ref(null)
const configError = ref('')
const session = ref(null)
const booting = ref(true)

const loggedIn = computed(() => Boolean(session.value?.accessToken))

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null')
  } catch {
    return null
  }
}

function saveSession(next) {
  session.value = next
  if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next))
  else localStorage.removeItem(SESSION_KEY)
}

async function boot() {
  booting.value = true
  try {
    config.value = await readCloudConfig(import.meta.env.BASE_URL)
  } catch (error) {
    configError.value = error.message || '未找到 cloud-config.json'
  }
  const stored = loadSession()
  if (stored && config.value && isCloudConfigReady(config.value)) {
    session.value = stored
    if (!hasValidSession(stored)) {
      try {
        saveSession(await refreshSession(config.value, stored))
      } catch {
        saveSession(null)
      }
    }
  }
  booting.value = false
}

async function handleLogin({ email, password }) {
  const next = await signIn(config.value, email, password)
  saveSession(next)
}

async function handleLogout() {
  try {
    await signOut(config.value, session.value)
  } catch {
    // 尽力而为
  }
  saveSession(null)
}

function onSession(next) {
  saveSession(next)
}

onMounted(boot)
</script>

<template>
  <div class="flex h-screen overflow-hidden bg-appbg">
    <div v-if="booting" class="flex flex-1 items-center justify-center text-sm text-gray-400">
      <i class="fa-solid fa-circle-notch mr-2 animate-spin" />正在加载…
    </div>

    <div v-else-if="configError" class="flex flex-1 items-center justify-center p-6">
      <div class="apple-card max-w-md text-center">
        <i class="fa-solid fa-plug-circle-xmark mb-3 text-3xl text-danger" />
        <p class="font-bold text-gray-800">云端配置缺失</p>
        <p class="mt-2 text-sm text-gray-500">{{ configError }}</p>
        <p class="mt-2 text-xs text-gray-400">请确认部署时已生成 public/cloud-config.json。</p>
      </div>
    </div>

    <LoginPanel
      v-else-if="!loggedIn"
      :ready="isCloudConfigReady(config)"
      :on-login="handleLogin"
    />

    <template v-else>
      <AppSidebar
        :current-tab="currentTab"
        :email="session?.user?.email || ''"
        @select="currentTab = $event"
        @logout="handleLogout"
      />
      <main class="flex-1 overflow-y-auto p-6">
        <VitalityModule
          v-if="currentTab === 'vitality'"
          :config="config"
          :session="session"
          :on-session="onSession"
        />
        <RepublishModule
          v-else-if="currentTab === 'republish'"
          :config="config"
          :session="session"
          :on-session="onSession"
        />
      </main>
    </template>
  </div>
</template>
