<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { db, listBooks, removeBook, resetProgress, type Book } from '@/db'
import { importFiles } from '@/lib/import'
import { seedDemoBooks } from '@/dev/seed'
import { fmtSize } from '@/lib/util'

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
const filter = ref<'all' | 'reading' | 'unread' | 'done'>('all')
const sort = ref<'recent' | 'added' | 'title' | 'progress'>('recent')
const sortOpen = ref(false)

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

/** 继续阅读：最近在读、且没读完的那本 */
const current = computed(() => {
  if (query.value.trim() || filter.value !== 'all') return null
  return books.value.find((b) => b.percent > 0.001 && b.percent < 0.999) || null
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
    showToast(`已放入 ${n} 本示例书`)
  } catch (e: any) {
    showToast('示例书生成失败：' + (e?.message || e))
  } finally {
    busy.value = false
  }
}

function openBook(b: Book) {
  router.push({ name: 'read', params: { id: b.id } })
}

// ---------- 长按菜单 ----------
let pressTimer = 0
function onPressStart(b: Book) {
  window.clearTimeout(pressTimer)
  pressTimer = window.setTimeout(() => (menuBook.value = b), 520)
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

function fmtTime(ts: number): string {
  if (!ts) return '未读'
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return Math.floor(diff / 60_000) + ' 分钟前'
  if (diff < 86400_000) return Math.floor(diff / 3600_000) + ' 小时前'
  if (diff < 7 * 86400_000) return Math.floor(diff / 86400_000) + ' 天前'
  const d = new Date(ts)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

function onBooksChanged() {
  void load()
}

function chooseSort(id: (typeof SORTS)[number]['id']) {
  sort.value = id
  sortOpen.value = false
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
  <div class="shelf" @click="sortOpen = false">
    <header class="shelf-head">
      <div class="head-top">
        <button class="icon" aria-label="阅读统计" @click="router.push('/stats')">
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 19h16" />
            <path d="M7 16v-4M12 16V7M17 16v-6" />
          </svg>
        </button>
        <div class="brand">
          <h1>墨读</h1>
          <span>书架 · {{ readingCount ? `${readingCount} 本在读` : `${books.length} 本` }}</span>
        </div>
        <button class="icon" aria-label="导入" @click="pick">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      <div v-if="books.length" class="tools">
        <div class="search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4.2-4.2" />
          </svg>
          <input v-model="query" placeholder="搜索书名、作者" enterkeyhint="search" />
          <button v-if="query" class="clear" @click="query = ''">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div class="filters">
          <button
            v-for="f in FILTERS"
            :key="f.id"
            class="fchip"
            :class="{ on: filter === f.id }"
            @click="filter = f.id"
          >
            {{ f.label }}
          </button>
          <span class="grow" />
          <div class="sort-wrap">
            <button class="sort" @click.stop="sortOpen = !sortOpen">
              {{ SORTS.find((s) => s.id === sort)?.label }}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6" /></svg>
            </button>
            <Transition name="fade">
              <div v-if="sortOpen" class="sort-menu" @click.stop>
                <button v-for="s in SORTS" :key="s.id" :class="{ on: sort === s.id }" @click="chooseSort(s.id)">{{ s.label }}</button>
              </div>
            </Transition>
          </div>
        </div>
      </div>
    </header>

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
          <svg width="104" height="104" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <rect x="26" y="22" width="68" height="84" rx="6" />
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

      <template v-else>
        <!-- 继续阅读 -->
        <article v-if="current" class="continue-card" @click="openBook(current)">
          <div class="cc-cover">
            <img v-if="covers[current.id]" :src="covers[current.id]" alt="" />
            <div v-else class="cc-gen" :style="{ background: `linear-gradient(150deg, hsl(${current.hue}, 26%, 34%), hsl(${current.hue}, 20%, 16%))` }">{{ current.title }}</div>
          </div>
          <div class="cc-body">
            <span class="cc-eyebrow">继续阅读</span>
            <h2>{{ current.title }}</h2>
            <p>
              {{ current.author || fmtSize(current.size) }} · {{ Math.round(current.percent * 100) }}%
            </p>
            <div class="cc-bar"><i :style="{ width: Math.max(2, current.percent * 100) + '%' }" /></div>
          </div>
          <span class="cc-go">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6" /></svg>
          </span>
        </article>

        <!-- 书格 -->
        <div class="grid">
          <article
            v-for="b in visible"
            :key="b.id"
            class="card"
            @click="openBook(b)"
            @pointerdown="onPressStart(b)"
            @pointerup="onPressEnd"
            @pointercancel="onPressEnd"
            @pointerleave="onPressEnd"
            @contextmenu.prevent
          >
            <div class="cover-wrap">
              <img v-if="covers[b.id]" class="cover" :src="covers[b.id]" :alt="b.title" loading="lazy" />
              <div v-else class="cover cover-gen" :style="{ background: `linear-gradient(150deg, hsl(${b.hue}, 26%, 34%), hsl(${b.hue}, 20%, 16%))` }">
                <span>{{ b.title }}</span>
              </div>
              <span class="fmt" :class="'fmt-' + b.format">{{ b.format.toUpperCase() }}</span>
              <div v-if="b.percent > 0.001" class="pct">{{ Math.round(b.percent * 100) }}%</div>
              <div class="cover-bar"><i :style="{ width: Math.max(2, b.percent * 100) + '%' }" /></div>
            </div>
            <h3 class="title">{{ b.title }}</h3>
            <p class="meta">{{ b.author || fmtTime(b.lastReadAt) }}</p>
          </article>
        </div>

        <p v-if="visible.length === 0" class="no-result">没有找到符合条件的书</p>

        <div class="foot-tools">
          <button class="ghost sm" :disabled="busy" @click="pickSamples">放入示例书</button>
        </div>
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

    <!-- 长按菜单 -->
    <Transition name="fade">
      <div v-if="menuBook" class="scrim" @click="menuBook = null" />
    </Transition>
    <Transition name="sheet" appear>
      <div v-if="menuBook" class="sheet book-menu" @click.stop>
        <h3 class="menu-title">{{ menuBook.title }}</h3>
        <button class="menu-item" @click="doReset(menuBook)">从头开始读</button>
        <button class="menu-item danger" @click="doRemove(menuBook)">删除这本书</button>
        <button class="menu-item cancel" @click="menuBook = null">取消</button>
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
.shelf-head {
  position: sticky;
  top: 0;
  z-index: 6;
  padding: calc(10px + var(--safe-top)) 14px 8px;
  background: color-mix(in srgb, var(--shelf-bg) 86%, transparent);
  -webkit-backdrop-filter: blur(14px);
  backdrop-filter: blur(14px);
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 7%, transparent);
}
.head-top {
  display: flex;
  align-items: center;
  gap: 4px;
}
.icon {
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  color: var(--ink-2);
}
.icon:active {
  background: color-mix(in srgb, var(--ink) 8%, transparent);
}
.brand {
  flex: 1;
  text-align: center;
  min-width: 0;
}
.brand h1 {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 0.16em;
  color: var(--ink);
}
.brand span {
  display: block;
  margin-top: 1px;
  font-size: 10.5px;
  letter-spacing: 0.05em;
  color: var(--muted);
}
.tools {
  padding-top: 8px;
}
.search {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 36px;
  padding: 0 11px;
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
  font-size: 13.5px;
  font-family: inherit;
}
.search input::placeholder {
  color: var(--muted);
}
.clear {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: color-mix(in srgb, var(--ink) 10%, transparent);
  color: var(--ink-2);
}
.filters {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 0 3px;
}
.fchip {
  height: 28px;
  padding: 0 12px;
  border-radius: 14px;
  font-size: 12px;
  color: var(--ink-2);
  white-space: nowrap;
}
.fchip.on {
  background: var(--ink);
  color: var(--shelf-bg);
}
.filters .grow {
  flex: 1;
}
.sort-wrap {
  position: relative;
}
.sort {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 28px;
  padding: 0 6px 0 10px;
  border-radius: 14px;
  font-size: 12px;
  color: var(--ink-2);
}
.sort-menu {
  position: absolute;
  right: 0;
  top: 34px;
  z-index: 9;
  min-width: 116px;
  padding: 5px;
  border-radius: 12px;
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: 0 10px 26px -10px rgba(28, 25, 23, 0.3);
}
.sort-menu button {
  display: block;
  width: 100%;
  height: 36px;
  padding: 0 10px;
  border-radius: 8px;
  text-align: left;
  font-size: 13px;
  color: var(--ink-2);
}
.sort-menu button.on {
  color: var(--accent);
  font-weight: 600;
}
.sort-menu button:active {
  background: var(--surface-2);
}
.file-input {
  display: none;
}
.shelf-body {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 12px 14px calc(30px + var(--safe-bottom));
}

/* 继续阅读卡片 */
.continue-card {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 12px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid color-mix(in srgb, var(--ink) 6%, transparent);
  box-shadow: 0 8px 24px -18px rgba(28, 25, 23, 0.4);
  margin-bottom: 18px;
  cursor: pointer;
}
.continue-card:active {
  transform: scale(0.99);
}
.cc-cover {
  width: 54px;
  height: 74px;
  flex: 0 0 auto;
  border-radius: 5px;
  overflow: hidden;
  box-shadow: 0 6px 14px -8px rgba(28, 25, 23, 0.5);
}
.cc-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.cc-gen {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 5px;
  color: rgba(250, 245, 235, 0.92);
  font-family: var(--font-serif);
  font-size: 10px;
  line-height: 1.3;
  text-align: center;
  overflow: hidden;
}
.cc-body {
  flex: 1;
  min-width: 0;
}
.cc-eyebrow {
  font-size: 10.5px;
  letter-spacing: 0.12em;
  color: var(--accent);
  font-weight: 600;
}
.cc-body h2 {
  margin: 3px 0 3px;
  font-family: var(--font-serif);
  font-size: 16px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cc-body p {
  margin: 0;
  font-size: 11.5px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cc-bar {
  height: 2.5px;
  margin-top: 8px;
  border-radius: 2px;
  background: var(--line);
  overflow: hidden;
}
.cc-bar i {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
}
.cc-go {
  flex: 0 0 auto;
  color: var(--muted);
}

/* 书格 */
.grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px 14px;
}
@media (min-width: 620px) {
  .grid {
    grid-template-columns: repeat(4, 1fr);
  }
}
@media (min-width: 880px) {
  .grid {
    grid-template-columns: repeat(5, 1fr);
    gap: 26px 20px;
  }
}
.card {
  cursor: pointer;
  min-width: 0;
  animation: rise 0.3s ease both;
}
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}
.cover-wrap {
  position: relative;
  border-radius: 5px;
  overflow: hidden;
  aspect-ratio: 2 / 3;
  box-shadow: 0 6px 16px -10px rgba(28, 25, 23, 0.5);
  background: var(--surface-2);
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
  padding: 10px;
}
.cover-gen span {
  color: rgba(250, 245, 235, 0.92);
  font-family: var(--font-serif);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  text-align: center;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.fmt {
  position: absolute;
  left: 4px;
  top: 4px;
  font-size: 8.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  padding: 1.5px 4px;
  border-radius: 3px;
  color: #fff;
  background: rgba(30, 26, 20, 0.5);
  -webkit-backdrop-filter: blur(3px);
  backdrop-filter: blur(3px);
}
.fmt-epub {
  background: rgba(63, 107, 83, 0.82);
}
.fmt-pdf {
  background: rgba(150, 70, 50, 0.82);
}
.fmt-fb2 {
  background: rgba(88, 82, 130, 0.84);
}
.fmt-cbz {
  background: rgba(140, 96, 46, 0.84);
}
.pct {
  position: absolute;
  right: 4px;
  top: 4px;
  padding: 1.5px 4px;
  border-radius: 3px;
  font-size: 8.5px;
  font-weight: 600;
  color: #fff;
  background: rgba(30, 26, 20, 0.5);
  font-variant-numeric: tabular-nums;
}
.cover-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2.5px;
  background: rgba(255, 255, 255, 0.22);
}
.cover-bar i {
  display: block;
  height: 100%;
  background: rgba(255, 255, 255, 0.9);
}
.title {
  margin: 7px 1px 0;
  font-family: var(--font-serif);
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--ink);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 2.8em;
}
.meta {
  margin: 2px 1px 0;
  font-size: 10.5px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.no-result {
  margin: 60px 0;
  text-align: center;
  font-size: 13px;
  color: var(--muted);
}
.foot-tools {
  display: flex;
  justify-content: center;
  padding: 26px 0 6px;
}

/* 空态 */
.empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 40px 20px 60px;
  color: var(--muted);
}
.empty-art {
  color: var(--line-strong);
  margin-bottom: 16px;
}
.empty h2 {
  margin: 0 0 6px;
  font-family: var(--font-serif);
  font-size: 19px;
  color: var(--ink);
  letter-spacing: 0.06em;
}
.empty p {
  margin: 0 0 22px;
  font-size: 13.5px;
  line-height: 1.7;
}
.empty-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: center;
}

/* 导入进度 */
.importing {
  position: fixed;
  left: 16px;
  right: 16px;
  bottom: calc(20px + var(--safe-bottom));
  z-index: 80;
  display: flex;
  justify-content: center;
  pointer-events: none;
}
.importing-inner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 18px;
  border-radius: 16px;
  background: rgba(28, 24, 18, 0.9);
  color: #f7f1e4;
  box-shadow: var(--shadow-2);
  max-width: 100%;
}
.importing-txt {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.importing-txt strong {
  font-size: 13px;
}
.importing-txt span {
  font-size: 11px;
  color: rgba(247, 241, 228, 0.62);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.spin {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.25);
  border-top-color: #fff;
  animation: rot 0.8s linear infinite;
}
@keyframes rot {
  to {
    transform: rotate(360deg);
  }
}
.toast {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(90px + var(--safe-bottom));
  z-index: 90;
  max-width: 86vw;
  padding: 10px 16px;
  border-radius: 12px;
  background: rgba(28, 24, 18, 0.92);
  color: #f7f1e4;
  font-size: 12.5px;
  line-height: 1.5;
  box-shadow: var(--shadow-2);
}
.book-menu {
  padding-bottom: calc(12px + var(--safe-bottom));
}
.menu-title {
  font-family: var(--font-serif);
  font-size: 15px !important;
  font-weight: 600 !important;
  text-align: center;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.menu-item {
  height: 50px;
  border-radius: 13px;
  font-size: 15.5px;
  color: var(--ink);
  width: 100%;
}
.menu-item:active {
  background: var(--line);
}
.menu-item.danger {
  color: var(--danger);
}
.menu-item.cancel {
  margin-top: 6px;
  color: var(--muted);
  font-size: 14.5px;
  border-top: 1px solid var(--line);
  border-radius: 0;
}

/* 补全局按钮在本页内的形状 */
.solid {
  height: 44px;
  padding: 0 22px;
  border-radius: 13px;
  background: var(--accent);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
}
.ghost {
  height: 44px;
  padding: 0 20px;
  border-radius: 13px;
  border: 1px solid var(--line);
  color: var(--ink-2);
  font-size: 14px;
}
.ghost.sm {
  height: 36px;
  padding: 0 16px;
  font-size: 12.5px;
  border-radius: 11px;
}
.ghost:active {
  background: var(--surface-2);
}
</style>
