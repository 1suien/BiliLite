<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { db, listBooks, removeBook, resetProgress, listSessions, type Book } from '@/db'
import { importFiles } from '@/lib/import'
import { seedDemoBooks } from '@/dev/seed'
import { fmtSize } from '@/lib/util'
import { fmtDuration } from '@/lib/stats'
import HomeHeader from '@/components/HomeHeader.vue'

const router = useRouter()
const books = ref<Book[]>([])
const covers = ref<Record<string, string>>({})
const loading = ref(true)
const importing = ref<{ done: number; total: number; name: string } | null>(null)
const toast = ref('')
const fileInput = ref<HTMLInputElement>()
const menuBook = ref<Book | null>(null)
const busy = ref(false)

const query = ref('')
const searchOpen = ref(false)
const searchInput = ref<HTMLInputElement>()
const filter = ref<'all' | 'reading' | 'unread' | 'done'>('all')
const sort = ref<'recent' | 'added' | 'title' | 'progress'>('recent')
const drawer = ref(false)
const moreOpen = ref(false)
const settingsOpen = ref(false)
const stats = ref<{ books: number; notes: number; ms: number }>({ books: 0, notes: 0, ms: 0 })

const SORTS = [
  { id: 'recent', label: '最近打开' },
  { id: 'added', label: '最近添加' },
  { id: 'title', label: '书名' },
  { id: 'progress', label: '阅读进度' },
] as const

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'reading', label: '在读' },
  { id: 'unread', label: '未读' },
  { id: 'done', label: '读完' },
] as const

const APP_VERSION = '0.3.1'

async function load() {
  const list = await listBooks()
  const cs = await db.covers.toArray()
  const map: Record<string, string> = {}
  for (const c of cs) if (c.dataUrl) map[c.id] = c.dataUrl
  books.value = list
  covers.value = map
  loading.value = false
}

const visible = computed(() => {
  let list = books.value.slice()
  const q = query.value.trim().toLowerCase()
  if (q) list = list.filter((b) => b.title.toLowerCase().includes(q) || (b.author || '').toLowerCase().includes(q))
  if (filter.value === 'reading') list = list.filter((b) => b.percent > 0.001 && b.percent < 0.999)
  else if (filter.value === 'unread') list = list.filter((b) => !b.lastReadAt)
  else if (filter.value === 'done') list = list.filter((b) => b.percent >= 0.999)
  if (sort.value === 'recent') list.sort((a, b) => (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt))
  else if (sort.value === 'added') list.sort((a, b) => b.addedAt - a.addedAt)
  else if (sort.value === 'title') list.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
  else if (sort.value === 'progress') list.sort((a, b) => b.percent - a.percent || b.lastReadAt - a.lastReadAt)
  return list
})

const readingCount = computed(() => books.value.filter((b) => b.percent > 0.001 && b.percent < 0.999).length)

function pick() {
  fileInput.value?.click()
}

async function onFiles(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files || [])
  input.value = ''
  if (!files.length || importing.value) return
  importing.value = { done: 0, total: files.length, name: files[0].name }
  try {
    const res = await importFiles(files, {
      onProgress: (done, total, name) => {
        importing.value = { done, total, name }
      },
    })
    await load()
    if (res.failed.length) {
      showToast(`有 ${res.failed.length} 本没导进来：` + res.failed.map((f) => `${f.name}（${f.error}）`).join('；'))
    } else if (res.added.length) {
      showToast(`已导入 ${res.added.length} 本书`)
    }
  } catch (err: any) {
    showToast(err?.message || '导入失败')
  } finally {
    importing.value = null
  }
}

let toastTimer = 0
function showToast(msg: string) {
  toast.value = msg
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toast.value = ''), 4200)
}

async function pickSamples() {
  if (busy.value) return
  busy.value = true
  try {
    const n = await seedDemoBooks(true)
    await load()
    showToast(n ? `已放入 ${n} 本示例书` : '示例书已经在书架里了')
  } catch (e: any) {
    showToast('示例书生成失败：' + (e?.message || e))
  } finally {
    busy.value = false
    moreOpen.value = false
    settingsOpen.value = false
  }
}

function openBook(b: Book) {
  router.push({ name: 'read', params: { id: b.id } })
}

// ---------- 搜索 ----------
async function toggleSearch() {
  searchOpen.value = !searchOpen.value
  if (searchOpen.value) {
    await nextTick()
    searchInput.value?.focus()
  } else {
    query.value = ''
  }
}
function closeSearch() {
  searchOpen.value = false
  query.value = ''
}

// ---------- 长按菜单 ----------
let pressTimer = 0
function onPressStart(b: Book) {
  window.clearTimeout(pressTimer)
  pressTimer = window.setTimeout(() => (menuBook.value = b), 480)
}
function onPressEnd() {
  window.clearTimeout(pressTimer)
}

async function doReset(b: Book) {
  menuBook.value = null
  await resetProgress(b.id)
  await load()
  showToast('进度已清空')
}

async function doRemove(b: Book) {
  menuBook.value = null
  await removeBook(b.id)
  await load()
  showToast(`已删除《${b.title}》`)
}

function bookMeta(b: Book): string {
  const pct = Math.round(b.percent * 100)
  const state = pct >= 99 ? '已读完' : pct > 0 ? `读到 ${pct}%` : '未读'
  return `${(b.format || '').toUpperCase()} · ${fmtSize(b.size)} · ${state}`
}

function chooseFilter(id: (typeof FILTERS)[number]['id']) {
  filter.value = id
  drawer.value = false
}
function chooseSort(id: (typeof SORTS)[number]['id']) {
  sort.value = id
  drawer.value = false
}

// ---------- 设置 ----------
async function openSettings() {
  settingsOpen.value = true
  moreOpen.value = false
  const [annotations, sessions] = await Promise.all([db.annotations.count(), listSessions(0)])
  stats.value = {
    books: books.value.length,
    notes: annotations,
    ms: sessions.reduce((s, x) => s + (x.end - x.start), 0),
  }
}

function onBooksChanged() {
  void load()
}

onMounted(async () => {
  await load()
  window.addEventListener('books-changed', onBooksChanged)
})
onBeforeUnmount(() => {
  window.removeEventListener('books-changed', onBooksChanged)
  window.clearTimeout(toastTimer)
  window.clearTimeout(pressTimer)
})
</script>

<template>
  <div class="shelf">
    <HomeHeader
      tab="shelf"
      :searching="searchOpen"
      @search="toggleSearch"
      @import="pick"
      @filter="drawer = true"
      @more="moreOpen = true"
      @stats="router.push('/stats')"
      @settings="openSettings"
    />

    <Transition name="drop">
      <div v-if="searchOpen" class="search-row">
        <div class="search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4.2-4.2" />
          </svg>
          <input ref="searchInput" v-model="query" placeholder="搜索书名、作者" enterkeyhint="search" @keydown.esc="closeSearch" />
          <button v-if="query" class="search-clear" aria-label="清空" @click="query = ''">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
          <button class="search-done" @click="closeSearch">完成</button>
        </div>
      </div>
    </Transition>

    <input
      ref="fileInput"
      class="file-input"
      type="file"
      multiple
      accept=".txt,.epub,.pdf,.fb2,.cbz,text/plain,application/epub+zip,application/pdf"
      @change="onFiles"
    />

    <main class="shelf-body">
      <!-- 空态 -->
      <div v-if="!loading && !books.length" class="empty">
        <div class="empty-art">
          <svg width="96" height="96" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="26" y="22" width="68" height="84" rx="5" />
            <path d="M26 36h68M40 50h32M40 62h40M40 74h24" />
            <path d="M92 30l10-10M14 40l10 4" stroke-dasharray="3 6" />
          </svg>
        </div>
        <h2>书架还是空的</h2>
        <p>导入 TXT、EPUB、PDF、FB2 或 CBZ，开始读第一本。</p>
        <div class="empty-actions">
          <button class="solid" @click="pick">导入本地书</button>
          <button class="ghost" @click="pickSamples">放入示例书</button>
        </div>
      </div>

      <!-- 书墙：只留封面 -->
      <template v-else>
        <div class="grid">
          <article
            v-for="b in visible"
            :key="b.id"
            class="card"
            :aria-label="b.title"
            :title="b.title"
            @click="openBook(b)"
            @pointerdown="onPressStart(b)"
            @pointerup="onPressEnd"
            @pointercancel="onPressEnd"
            @pointerleave="onPressEnd"
            @contextmenu.prevent
          >
            <div class="cover-wrap">
              <img v-if="covers[b.id]" class="cover" :src="covers[b.id]" :alt="b.title" loading="lazy" />
              <div
                v-else
                class="cover cover-gen"
                :style="{ background: `linear-gradient(155deg, hsl(${b.hue}, 24%, 33%), hsl(${b.hue}, 18%, 15%))` }"
              >
                <span>{{ b.title }}</span>
              </div>
              <i v-if="b.percent > 0.001" class="cover-bar" :style="{ width: Math.max(2, b.percent * 100) + '%' }" />
              <i v-if="b.lastReadAt && b.percent > 0.001 && b.percent < 0.999" class="reading-dot" />
            </div>
          </article>
        </div>

        <p v-if="visible.length === 0" class="no-result">
          没有找到符合条件的书
          <button @click="closeSearch(); filter = 'all'">清空筛选</button>
        </p>
      </template>
    </main>

    <!-- 导入进度 -->
    <Transition name="fade">
      <div v-if="importing" class="importing">
        <div class="importing-inner">
          <span class="spin" />
          <div class="importing-txt">
            <strong>正在导入 {{ importing.done }} / {{ importing.total }}</strong>
            <span>{{ importing.name }}</span>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 左侧筛选抽屉 -->
    <Transition name="fade">
      <div v-if="drawer" class="scrim" @click="drawer = false" />
    </Transition>
    <Transition name="drawer">
      <aside v-if="drawer" class="drawer" @click.stop>
        <h3 class="drawer-h">书架</h3>
        <p class="drawer-sub">{{ books.length }} 本 · {{ readingCount }} 本在读</p>

        <span class="group-label">筛选</span>
        <div class="chips">
          <button v-for="f in FILTERS" :key="f.id" class="chip" :class="{ on: filter === f.id }" @click="chooseFilter(f.id)">
            {{ f.label }}
          </button>
        </div>

        <span class="group-label">排序</span>
        <div class="chips">
          <button v-for="s in SORTS" :key="s.id" class="chip" :class="{ on: sort === s.id }" @click="chooseSort(s.id)">
            {{ s.label }}
          </button>
        </div>

        <div class="drawer-links">
          <button class="link-row" @click="drawer = false; router.push('/stats')">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16" /><path d="M7 16v-4M12 16V7M17 16v-6" /></svg>
            阅读统计
          </button>
          <button class="link-row" @click="drawer = false; openSettings()">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1" /><path d="M12 3.5v2.2M12 18.3v2.2M4.8 7.8l1.9 1.1M17.3 15.1l1.9 1.1M4.8 16.2l1.9-1.1M17.3 8.9l1.9-1.1" /></svg>
            设置
          </button>
          <button class="link-row" @click="pickSamples">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14" /></svg>
            放入示例书
          </button>
        </div>
      </aside>
    </Transition>

    <!-- 更多 -->
    <Transition name="fade">
      <div v-if="moreOpen" class="scrim" @click="moreOpen = false" />
    </Transition>
    <Transition name="sheet" appear>
      <div v-if="moreOpen" class="sheet more-sheet" @click.stop>
        <button class="menu-row" @click="moreOpen = false; router.push('/stats')">阅读统计</button>
        <button class="menu-row" @click="openSettings">设置</button>
        <button class="menu-row" :disabled="busy" @click="pickSamples">放入示例书</button>
        <button class="menu-row" @click="moreOpen = false; toggleSearch()">搜索书籍</button>
        <button class="menu-row cancel" @click="moreOpen = false">取消</button>
      </div>
    </Transition>

    <!-- 长按：书 -->
    <Transition name="fade">
      <div v-if="menuBook" class="scrim" @click="menuBook = null" />
    </Transition>
    <Transition name="sheet" appear>
      <div v-if="menuBook" class="sheet book-menu" @click.stop>
        <h3 class="menu-title">{{ menuBook.title }}</h3>
        <p class="menu-meta">{{ bookMeta(menuBook) }}</p>
        <button class="menu-row" @click="doReset(menuBook)">从头开始读</button>
        <button class="menu-row danger" @click="doRemove(menuBook)">删除这本书</button>
        <button class="menu-row cancel" @click="menuBook = null">取消</button>
      </div>
    </Transition>

    <!-- 设置 -->
    <Transition name="fade">
      <div v-if="settingsOpen" class="scrim" @click="settingsOpen = false" />
    </Transition>
    <Transition name="sheet" appear>
      <div v-if="settingsOpen" class="sheet settings-sheet" @click.stop>
        <h3 class="sheet-title">设置</h3>
        <div class="about-card">
          <div class="about-mark">墨</div>
          <div class="about-body">
            <strong>墨读 <span class="ver">v{{ APP_VERSION }}</span></strong>
            <p>离线阅读器 · TXT / EPUB / PDF / FB2 / CBZ</p>
          </div>
        </div>
        <div class="stat-row">
          <div class="stat"><b>{{ stats.books }}</b><span>本书</span></div>
          <div class="stat"><b>{{ stats.notes }}</b><span>条划线</span></div>
          <div class="stat"><b>{{ fmtDuration(stats.ms, 'short') }}</b><span>阅读时长</span></div>
        </div>
        <p class="note-line">书、进度、划线和 AI Key 都只存在本机 IndexedDB 里，不上传；卸载应用会一起清掉。</p>
        <button class="menu-row" @click="pickSamples">放入示例书</button>
        <a class="menu-row" href="https://github.com/1suien/BiliLite/tree/modu" target="_blank" rel="noreferrer">源代码（GitHub）</a>
        <button class="menu-row cancel" @click="settingsOpen = false">关闭</button>
      </div>
    </Transition>

    <!-- 轻提示 -->
    <Transition name="fade">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.shelf {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--shelf-bg);
}
.file-input {
  display: none;
}

/* 搜索行 */
.search-row {
  flex: 0 0 auto;
  padding: 2px 14px 10px;
  background: var(--shelf-bg);
}
@media (min-width: 620px) {
  .search-row {
    padding: 2px 18px 12px;
  }
}
.search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 12px;
  border-radius: 11px;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  color: var(--muted);
}
.search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--ink);
  font-size: 14px;
  font-family: inherit;
}
.search input::placeholder {
  color: var(--muted);
}
.search-clear {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: color-mix(in srgb, var(--ink) 10%, transparent);
  color: var(--ink-2);
}
.search-done {
  font-size: 13px;
  color: var(--accent);
  padding: 4px 2px 4px 6px;
}
.drop-enter-active,
.drop-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.drop-enter-from,
.drop-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* 书墙 */
.shelf-body {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 6px 14px calc(32px + var(--safe-bottom));
}
@media (min-width: 620px) {
  .shelf-body {
    padding: 18px 24px calc(40px + var(--safe-bottom));
  }
}
@media (min-width: 900px) {
  .shelf-body {
    padding: 22px 32px calc(48px + var(--safe-bottom));
    max-width: 1560px;
    width: 100%;
    margin: 0 auto;
  }
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px 12px;
}
@media (min-width: 560px) {
  .grid {
    grid-template-columns: repeat(4, 1fr);
    gap: 26px 22px;
  }
}
@media (min-width: 760px) {
  .grid {
    grid-template-columns: repeat(5, 1fr);
  }
}
@media (min-width: 1000px) {
  .grid {
    grid-template-columns: repeat(6, 1fr);
    gap: 34px 32px;
  }
}
.card {
  min-width: 0;
  cursor: pointer;
  border-radius: 3px;
  outline: none;
  animation: fade-up 0.32s ease both;
}
@keyframes fade-up {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
.card:focus-visible .cover-wrap {
  box-shadow: 0 0 0 2px var(--accent);
}
.cover-wrap {
  position: relative;
  aspect-ratio: 2 / 3;
  border-radius: 3px;
  overflow: hidden;
  background: var(--surface-2);
  box-shadow: 0 1px 2px rgba(30, 24, 16, 0.14), 0 10px 22px -16px rgba(30, 24, 16, 0.5);
  transition: transform 0.18s ease, box-shadow 0.18s ease;
}
.card:hover .cover-wrap {
  transform: translateY(-2px);
  box-shadow: 0 2px 4px rgba(30, 24, 16, 0.16), 0 16px 30px -18px rgba(30, 24, 16, 0.55);
}
.card:active .cover-wrap {
  transform: scale(0.985);
}
.cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.cover-gen {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 9%;
}
.cover-gen span {
  color: rgba(250, 245, 235, 0.94);
  font-family: var(--font-serif);
  font-size: clamp(12px, 3.4vw, 22px);
  font-weight: 600;
  line-height: 1.45;
  letter-spacing: 0.04em;
  text-align: center;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 5;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.cover-bar {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  background: color-mix(in srgb, var(--accent) 85%, white);
  opacity: 0.9;
}
.reading-dot {
  position: absolute;
  right: 6px;
  top: 6px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: rgba(255, 253, 247, 0.9);
  box-shadow: 0 0 0 1.5px rgba(30, 24, 16, 0.28);
}
.no-result {
  margin: 46px 0 0;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
}
.no-result button {
  display: inline-block;
  margin-left: 8px;
  color: var(--accent);
  font-size: 13px;
}

/* 空态 */
.empty {
  text-align: center;
  padding-top: 18vh;
  color: var(--ink-2);
}
.empty-art {
  color: color-mix(in srgb, var(--ink) 24%, transparent);
  display: flex;
  justify-content: center;
  margin-bottom: 18px;
}
.empty h2 {
  margin: 0 0 7px;
  font-family: var(--font-serif);
  font-size: 20px;
  font-weight: 600;
  color: var(--ink);
}
.empty p {
  margin: 0 auto;
  max-width: 280px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--muted);
}
.empty-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
  margin-top: 22px;
}
.solid,
.ghost {
  height: 42px;
  padding: 0 20px;
  border-radius: 12px;
  font-size: 14px;
}
.solid {
  background: var(--accent);
  color: #fbf9f3;
}
.ghost {
  border: 1px solid var(--line-strong);
  color: var(--ink-2);
}

/* 抽屉 */
.drawer {
  position: fixed;
  z-index: 70;
  left: 0;
  top: 0;
  bottom: 0;
  width: min(304px, 82vw);
  padding: calc(24px + var(--safe-top)) 20px calc(24px + var(--safe-bottom));
  background: var(--surface);
  border-right: 1px solid var(--line);
  box-shadow: 20px 0 50px -30px rgba(30, 24, 16, 0.5);
  overflow-y: auto;
}
.drawer-h {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 22px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--ink);
}
.drawer-sub {
  margin: 5px 0 22px;
  font-size: 12px;
  color: var(--muted);
}
.group-label {
  display: block;
  margin: 16px 0 9px;
  font-size: 11px;
  letter-spacing: 0.14em;
  color: var(--muted);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.chip {
  height: 32px;
  padding: 0 13px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--ink-2);
  border: 1px solid transparent;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
}
.chip.on {
  background: var(--accent);
  color: #fbf9f3;
}
.drawer-links {
  margin-top: 26px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.link-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 44px;
  padding: 0 4px;
  font-size: 14px;
  color: var(--ink-2);
}
.link-row:active {
  color: var(--accent);
}
.drawer-enter-active,
.drawer-leave-active {
  transition: transform 0.22s cubic-bezier(0.32, 0.72, 0, 1);
}
.drawer-enter-from,
.drawer-leave-to {
  transform: translateX(-100%);
}

/* 菜单/sheet */
.sheet-title {
  margin: 4px 2px 16px;
  font-family: var(--font-serif);
  font-size: 18px;
  font-weight: 600;
  color: var(--ink);
}
.more-sheet,
.book-menu,
.settings-sheet {
  max-height: 82vh;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.menu-title {
  margin: 2px 4px 4px;
  font-family: var(--font-serif);
  font-size: 18px;
  font-weight: 600;
  color: var(--ink);
  line-height: 1.35;
}
.menu-meta {
  margin: 0 4px 14px;
  font-size: 12px;
  color: var(--muted);
}
.menu-row {
  display: block;
  width: 100%;
  height: 48px;
  padding: 0 4px;
  text-align: left;
  font-size: 15px;
  color: var(--ink);
  border-top: 1px solid color-mix(in srgb, var(--ink) 7%, transparent);
}
.menu-row:first-of-type {
  border-top: 0;
}
.menu-row:active {
  color: var(--accent);
}
.menu-row.danger {
  color: var(--danger);
}
.menu-row.cancel {
  color: var(--muted);
  text-align: center;
  border-top: 6px solid var(--shelf-bg-2);
  border-radius: 0 0 14px 14px;
}
.about-card {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 4px 2px 16px;
}
.about-mark {
  width: 46px;
  height: 46px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border-radius: 12px;
  background: var(--accent);
  color: #fbf9f3;
  font-family: var(--font-serif);
  font-size: 25px;
  font-weight: 600;
}
.about-body strong {
  font-size: 15px;
  color: var(--ink);
}
.about-body .ver {
  font-weight: 400;
  font-size: 12.5px;
  color: var(--muted);
  margin-left: 2px;
}
.about-body p {
  margin: 3px 0 0;
  font-size: 12px;
  color: var(--muted);
}
.stat-row {
  display: flex;
  gap: 8px;
  padding: 0 0 4px;
}
.stat {
  flex: 1;
  padding: 11px 8px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--ink) 3.5%, transparent);
  text-align: center;
}
.stat b {
  display: block;
  font-family: var(--font-serif);
  font-size: 19px;
  font-weight: 600;
  color: var(--ink);
}
.stat span {
  display: block;
  margin-top: 2px;
  font-size: 10.5px;
  color: var(--muted);
}
.note-line {
  margin: 10px 2px 12px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--muted);
}
.settings-sheet a.menu-row {
  line-height: 48px;
}

/* 导入进度 */
.importing {
  position: fixed;
  left: 0;
  right: 0;
  bottom: calc(22px + var(--safe-bottom));
  z-index: 80;
  display: flex;
  justify-content: center;
  pointer-events: none;
}
.importing-inner {
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 86vw;
  padding: 12px 16px;
  border-radius: 14px;
  background: rgba(28, 25, 23, 0.92);
  color: #f7f3ea;
  box-shadow: 0 12px 30px -12px rgba(0, 0, 0, 0.5);
}
.spin {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.28);
  border-top-color: #fff;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.importing-txt {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.importing-txt strong {
  font-size: 12.5px;
  font-weight: 600;
}
.importing-txt span {
  margin-top: 2px;
  font-size: 11px;
  opacity: 0.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
