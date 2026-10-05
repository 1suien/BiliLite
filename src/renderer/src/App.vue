<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from './stores/auth'
import { useSettingsStore } from './stores/settings'
import { useLearnStore } from './stores/learn'
import { useUiStore } from './stores/ui'
import Icon from './components/Icon.vue'
import Toasts from './components/Toasts.vue'
import LoginModal from './components/LoginModal.vue'
import ConfirmModal from './components/ConfirmModal.vue'
import BiliImage from './components/BiliImage.vue'
import { fmtHours } from './utils/format'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const settings = useSettingsStore()
const learn = useLearnStore()
const ui = useUiStore()

const keyword = ref('')
const searchEl = ref(null)

const NAV = [
  { to: '/', icon: 'home', label: '首页' },
  { to: '/search', icon: 'search', label: '搜索' },
  { to: '/fav', icon: 'star', label: '收藏' },
  { to: '/learn', icon: 'book', label: '学习' },
  { to: '/settings', icon: 'settings', label: '设置' }
]

const todayText = computed(() => fmtHours(learn.todaySeconds))
const activePath = computed(() => route.path)

function submitSearch() {
  const q = keyword.value.trim()
  if (!q) return
  router.push({ name: 'search', query: { q } })
}

function onLogout() {
  auth.logout()
  ui.toast('已退出登录')
}

onMounted(async () => {
  await settings.init()
  await auth.restore()
  try {
    await learn.init()
  } catch (err) {
    console.warn('[learn] 本地学习库初始化失败：', err && err.message)
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
      e.preventDefault()
      searchEl.value && searchEl.value.focus()
    }
  })
})
</script>

<template>
  <div class="app">
    <aside class="side">
      <div class="brand">
        <div class="brand-mark">学</div>
        <div class="brand-text">
          <b>学习 B 站</b>
          <span>专注模式 · 黑白极简</span>
        </div>
      </div>

      <nav class="side-nav">
        <RouterLink
          v-for="n in NAV"
          :key="n.to"
          :to="n.to"
          class="nav-item"
          :class="{ 'router-link-active': activePath === n.to }"
        >
          <Icon :name="n.icon" :size="17" />
          <span>{{ n.label }}</span>
          <span v-if="n.to === '/learn' && learn.todaySeconds > 0" class="badge">{{ todayText }}h</span>
        </RouterLink>
      </nav>

      <div class="side-foot">
        <template v-if="auth.loggedIn">
          <div class="side-user">
            <BiliImage :src="auth.avatar" :alt="auth.user.uname" />
            <div class="who">
              <b>{{ auth.user.uname }}</b>
              <span>Lv{{ auth.user.level || 0 }} · 已登录</span>
            </div>
          </div>
          <button class="btn sm ghost" @click="onLogout"><Icon name="logout" :size="14" /> 退出登录</button>
        </template>
        <template v-else>
          <div class="side-user">
            <div class="avatar-fallback" />
            <div class="who">
              <b>未登录</b>
              <span>部分功能受限</span>
            </div>
          </div>
          <button class="btn sm primary" @click="ui.loginOpen = true"><Icon name="user" :size="14" /> 扫码登录</button>
        </template>
      </div>
    </aside>

    <main class="main">
      <header class="top">
        <div class="top-search">
          <input
            ref="searchEl"
            v-model="keyword"
            class="input"
            type="search"
            placeholder="搜索视频 / 知识点，回车确认（按 / 快速聚焦）"
            @keyup.enter="submitSearch"
          />
          <button class="btn" @click="submitSearch"><Icon name="search" :size="16" /></button>
        </div>
        <span class="grow" />
        <span class="chip plain" title="今天累计学习时长">
          <Icon name="clock" :size="13" /> 今日 {{ todayText }}h
        </span>
        <button class="btn ghost sm" title="返回" @click="router.back()"><Icon name="left" :size="15" /></button>
      </header>

      <div class="scroll">
        <RouterView v-slot="{ Component }">
          <component :is="Component" />
        </RouterView>
      </div>
    </main>

    <Toasts />
    <LoginModal />
    <ConfirmModal />
  </div>
</template>
