<script setup lang="ts">
/**
 * 应用外壳
 * 还原自 main-CoY7YGNA.js 里的 App 组件（原 __name: "App"）
 *
 * 结构：左侧固定导航（可拖动排序，顺序存 settings.navOrder）+ 顶栏（搜索/今日时长/剧场模式/返回）
 *      + .scroll 里的 <RouterView>。没有 keep-alive：原实现用
 *      `:key="route.fullPath + '#' + ui.refreshSeq"` 强制换页/刷新时重建组件。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import BiliImage from '@/components/BiliImage.vue'
import PageFloat from '@/components/PageFloat.vue'
import ReminderCards from '@/components/ReminderCards.vue'
import MiniPlayer from '@/components/MiniPlayer.vue'
import Toasts from '@/components/Toasts.vue'
import LoginModal from '@/components/LoginModal.vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import { useUiStore } from '@/stores/ui'
import { useAuthStore } from '@/stores/auth'
import { useSettingsStore } from '@/stores/settings'
import { useLearnStore } from '@/stores/learn'
import { useHabitsStore } from '@/stores/habits'
import { useRemindStore } from '@/stores/remind'
import { useCoursesStore } from '@/stores/courses'
import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import { useUpsStore } from '@/stores/ups'
import { bili } from '@/bridge'
import { putLocal } from '@/db'
import { toHours } from '@/utils/format'

interface NavItem {
  to: string
  icon: string
  label: string
}

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const settings = useSettingsStore()
const learn = useLearnStore()
const habits = useHabitsStore()
const remind = useRemindStore()
const courses = useCoursesStore()
const ups = useUpsStore()
const ui = useUiStore()

const keyword = ref('')
const searchEl = ref<HTMLInputElement | null>(null)
const scrollEl = ref<HTMLElement | null>(null)
/** 剧场模式：收起侧栏与顶栏（原实现用 ref 存在 setup 里，不落盘） */
const theater = ref(false)

function toggleTheater() {
  theater.value = !theater.value
}

// 换路由：退出剧场模式并把内容区滚回顶部（原实现 watch route.fullPath）
watch(
  () => route.fullPath,
  () => {
    theater.value = false
    const el = scrollEl.value || document.querySelector('.scroll')
    if (!el) return
    try {
      el.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
    } catch {
      el.scrollTop = 0
    }
  },
)

/** 归到「更多」区域的三个入口（原实现 b 数组） */
const MORE_PATHS = ['/fav', '/ups', '/settings']

const NAV_ITEMS: NavItem[] = [
  { to: '/ups', icon: 'users', label: 'UP 管理' },
  { to: '/fav', icon: 'star', label: '收藏' },
  { to: '/learn', icon: 'book', label: '学习' },
  { to: '/habit', icon: 'check', label: '习惯' },
  { to: '/schedule', icon: 'grid', label: '课表' },
  { to: '/local', icon: 'film', label: '本地' },
  { to: '/settings', icon: 'settings', label: '设置' },
]

/** 按 settings.navOrder 排序后的全部导航项（未列出的按默认顺序补在后面） */
const orderedNav = computed<NavItem[]>(() => {
  const custom = (Array.isArray(settings.settings.navOrder) ? settings.settings.navOrder : [])
    .map((to) => NAV_ITEMS.find((n) => n.to === to))
    .filter(Boolean) as NavItem[]
  const rest = NAV_ITEMS.filter((n) => !custom.some((c) => c.to === n.to))
  return [...custom, ...rest]
})

/** 主区域导航（不含「更多」） */
const mainNav = computed(() => orderedNav.value.filter((n) => !MORE_PATHS.includes(n.to)))
/** 「更多」区域导航 */
const moreNav = computed(() => orderedNav.value.filter((n) => MORE_PATHS.includes(n.to)))

// ---- 拖动排序（HTML5 drag & drop）----
const dragFrom = ref('')
const dropTo = ref('')

function isMore(to: string) {
  return MORE_PATHS.includes(to)
}

function onDragStart(item: NavItem, e: DragEvent) {
  dragFrom.value = item.to
  dropTo.value = ''
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', item.to)
  }
}

function onDragOver(item: NavItem, e: DragEvent) {
  if (!dragFrom.value || dragFrom.value === item.to) return
  // 只允许同组内互换（主区域 <> 更多区域 不允许）
  if (isMore(dragFrom.value) !== isMore(item.to)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dropTo.value = item.to
}

async function onDrop(item: NavItem, e: DragEvent) {
  e.preventDefault()
  const from = dragFrom.value || (e.dataTransfer && e.dataTransfer.getData('text/plain')) || ''
  dragFrom.value = ''
  dropTo.value = ''
  if (!from || from === item.to || isMore(from) !== isMore(item.to)) return

  const order = orderedNav.value.map((n) => n.to)
  const fromIndex = order.indexOf(from)
  const toIndex = order.indexOf(item.to)
  if (fromIndex < 0 || toIndex < 0) return
  order.splice(toIndex, 0, order.splice(fromIndex, 1)[0])
  try {
    // 保存时也是「主区域顺序 + 更多区域顺序」拼接（与原实现一致）
    const next = [...order.filter((t) => !isMore(t)), ...order.filter((t) => isMore(t))]
    await settings.patch({ navOrder: next })
  } catch (e: any) {
    console.warn('[nav] 侧栏顺序保存失败：', e && e.message)
  }
}

function cancelDrag() {
  dragFrom.value = ''
  dropTo.value = ''
}

/** 今日学习时长（小时，保留 1~2 位小数） */
const todayHours = computed(() => toHours(learn.todaySeconds))
/** 当前路径：用于侧栏高亮（原实现用 route.path 精确匹配，不用 router-link 的前缀匹配） */
const activePath = computed(() => route.path)

function onSearch() {
  const q = keyword.value.trim()
  if (!q) return
  router.push({ name: 'search', query: { q } })
}

function logout() {
  auth.logout()
  ui.toast('已退出登录')
}

// 键盘快捷键
let keyHandler: ((e: KeyboardEvent) => void) | null = null
/** 0.4.13：数据变化后延迟重排系统通知 */
let nativeSyncTimer: any = null

function onKeydown(e: KeyboardEvent) {
  const el = document.activeElement as HTMLElement | null
  // 正在输入框/可编辑区域里打字时不抢快捷键
  const editing = !!el && (/^(INPUT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable)
  if (e.key === '/' && !editing) {
    e.preventDefault()
    if (searchEl.value) searchEl.value.focus()
    return
  }
  if (editing || e.ctrlKey || e.metaKey || e.altKey) return
  if (e.key === 'f' || e.key === 'F') {
    e.preventDefault()
    toggleTheater()
  } else if (e.key === 'Escape' && theater.value) {
    theater.value = false
  }
}

/**
 * 别的 App「分享 / 用其他应用打开」进来的视频（本机定制 0.4.15）。
 *
 * 场景：WPS 网盘里长按视频 →「分享」→ BiliLite（或从系统文件管理器「用其他应用打开」）。
 * 原生插件已经把 `content://` 复制到 App 私有目录（`files/local-media/`），这里只负责入库 + 跳转播放。
 */
let sharedBusy = false
async function importSharedMedia() {
  if (sharedBusy) return
  if (!bili.local || !bili.local.sharedPending) return
  if (bili.platform !== 'android') return
  sharedBusy = true
  try {
    const res = await bili.local.sharedPending()
    const entries = (res && res.entries) || []
    if (!entries.length) return
    for (const entry of entries) {
      await putLocal({
        id: entry.id,
        path: entry.path,
        name: entry.name,
        size: Number(entry.size) || 0,
        mtime: Number(entry.mtime) || 0,
      })
    }
    ui.ok(entries.length > 1 ? `已收到 ${entries.length} 个视频，去「本地」里挑一个播` : `已收到「${entries[0].name}」，开始播放`)
    if (entries.length === 1) router.push(`/local/${entries[0].id}`)
    else router.push('/local')
  } catch (e: any) {
    console.warn('[share] 导入分享的视频失败：', e && e.message)
  } finally {
    sharedBusy = false
  }
}

function onVisibilityForShare() {
  if (document.visibilityState === 'visible') importSharedMedia()
}

onMounted(async () => {
  // 启动预热：设置 -> 登录态 -> 本地数据（各块失败只影响自己）
  await settings.init()
  await auth.restore()
  try {
    await learn.init()
  } catch (e: any) {
    console.warn('[learn] 本地学习库初始化失败：', e && e.message)
  }
  try {
    await ups.init()
  } catch (e: any) {
    console.warn('[ups] 本机 UP 名单初始化失败：', e && e.message)
  }
  try {
    await habits.init()
    habits.startReminders()
  } catch (e: any) {
    console.warn('[habit] 习惯数据初始化失败：', e && e.message)
  }
  // 本机构建 0.4.12：专注目标 / 课表的到点提醒（习惯提醒走 habits.startReminders）
  try {
    remind.start()
  } catch (e: any) {
    console.warn('[remind] 提醒中心启动失败：', e && e.message)
  }
  // 本机构建 0.4.13：提醒同时交给系统通知（应用在后台/切走也能看到，带提示音）
  try {
    await courses.init()
  } catch (e: any) {
    console.warn('[courses] 课表初始化失败：', e && e.message)
  }
  watch(
    () => [settings.settings.focusTargets, habits.habits, courses.list],
    () => {
      if (nativeSyncTimer) clearTimeout(nativeSyncTimer)
      nativeSyncTimer = setTimeout(() => {
        remind.syncNative().catch(() => {})
      }, 1200)
    },
    { deep: true },
  )
  // 点系统通知 → 跳到对应页面（extra.path 由 bridge/notify.ts 写入）
  if (Capacitor.isNativePlatform()) {
    try {
      LocalNotifications.addListener('localNotificationActionPerformed', (action: any) => {
        const path = action && action.notification && action.notification.extra && action.notification.extra.path
        if (typeof path === 'string' && path) router.push(path)
      })
    } catch {}
  }

  // 本机构建 0.4.15：接收「分享 / 用其他应用打开」过来的视频
  window.addEventListener('localShare', importSharedMedia)
  document.addEventListener('visibilitychange', onVisibilityForShare)
  importSharedMedia()

  keyHandler = onKeydown
  window.addEventListener('keydown', keyHandler)
})

onUnmounted(() => {
  // 原实现没有解绑（单例外壳不会卸载），这里补上以便 HMR 不叠加监听
  window.removeEventListener('localShare', importSharedMedia)
  document.removeEventListener('visibilitychange', onVisibilityForShare)
  if (keyHandler) window.removeEventListener('keydown', keyHandler)
  keyHandler = null
  if (nativeSyncTimer) clearTimeout(nativeSyncTimer)
  nativeSyncTimer = null
  remind.stop()
})
</script>

<template>
  <div :class="['app', { theater }]">
    <aside class="side">
      <div class="brand">
        <div class="brand-mark">学</div>
        <div class="brand-text">
          <b>BiliLite</b>
          <span>专注模式 · 黑白极简</span>
        </div>
      </div>

      <nav class="side-nav">
        <RouterLink
          v-for="item in mainNav"
          :key="item.to"
          :to="item.to"
          :class="[
            'nav-item',
            {
              'router-link-active': activePath === item.to,
              dragging: dragFrom === item.to,
              'drop-target': dropTo === item.to && dragFrom !== item.to,
            },
          ]"
          draggable="true"
          :title="`${item.label}（按住拖动可调整顺序）`"
          @dragstart="onDragStart(item, $event)"
          @dragover="onDragOver(item, $event)"
          @drop="onDrop(item, $event)"
          @dragend="cancelDrag"
        >
          <Icon :name="item.icon" :size="17" />
          <span>{{ item.label }}</span>
          <span v-if="item.to === '/learn' && learn.todaySeconds > 0" class="badge">
            {{ todayHours }}h
          </span>
        </RouterLink>
      </nav>

      <div class="side-foot">
        <nav class="side-nav side-more" aria-label="更多">
          <RouterLink
            v-for="item in moreNav"
            :key="item.to"
            :to="item.to"
            :class="[
              'nav-item',
              {
                'router-link-active': activePath === item.to,
                dragging: dragFrom === item.to,
                'drop-target': dropTo === item.to && dragFrom !== item.to,
              },
            ]"
            draggable="true"
            :title="`${item.label}（按住拖动可调整顺序）`"
            @dragstart="onDragStart(item, $event)"
            @dragover="onDragOver(item, $event)"
            @drop="onDrop(item, $event)"
            @dragend="cancelDrag"
          >
            <Icon :name="item.icon" :size="17" />
            <span>{{ item.label }}</span>
            <span v-if="item.to === '/learn' && learn.todaySeconds > 0" class="badge">
              {{ todayHours }}h
            </span>
          </RouterLink>
        </nav>

        <div class="side-account">
          <template v-if="auth.loggedIn">
            <div class="side-user">
              <BiliImage :src="auth.avatar" :alt="auth.user?.uname || ''" />
              <div class="who">
                <b>{{ auth.user?.uname }}</b>
                <span>Lv{{ auth.user?.level || 0 }} · 已登录</span>
              </div>
            </div>
            <button class="btn sm ghost" @click="logout">
              <Icon name="logout" :size="14" /> 退出登录
            </button>
          </template>
          <template v-else>
            <div class="side-user">
              <div class="avatar-fallback"></div>
              <div class="who">
                <b>未登录</b>
                <span>部分功能受限</span>
              </div>
            </div>
            <button class="btn sm primary" @click="ui.loginOpen = true">
              <Icon name="user" :size="14" /> 扫码登录
            </button>
          </template>
        </div>
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
            @keyup.enter="onSearch"
          />
          <button class="btn" @click="onSearch">
            <Icon name="search" :size="16" />
          </button>
        </div>
        <span class="grow"></span>
        <span class="chip plain" title="今天累计学习时长">
          <Icon name="clock" :size="13" /> 今日 {{ todayHours }}h
        </span>
        <button
          :class="['btn ghost sm', { on: theater }]"
          title="剧场模式：收起侧栏与顶栏，专注看这一段（快捷键 F，Esc 退出）"
          @click="toggleTheater"
        >
          <Icon name="monitor" :size="14" /> 剧场模式 <span class="kbd">F</span>
        </button>
        <button class="btn ghost sm" title="返回" @click="router.back()">
          <Icon name="left" :size="15" />
        </button>
      </header>

      <div ref="scrollEl" class="scroll">
        <RouterView v-slot="{ Component }">
          <!-- 原实现没有 keep-alive：key 带上 refreshSeq，全局刷新即重建页面 -->
          <component :is="Component" :key="`${route.fullPath}#${ui.refreshSeq}`" />
        </RouterView>
      </div>
    </main>

    <button v-if="theater" class="btn sm theater-exit" title="退出剧场模式（Esc）" @click="toggleTheater">
      <Icon name="monitor" :size="14" /> 退出剧场 <span class="kbd">Esc</span>
    </button>

    <PageFloat />
    <MiniPlayer />
    <ReminderCards />
    <Toasts />
    <LoginModal />
    <ConfirmModal />
  </div>
</template>
