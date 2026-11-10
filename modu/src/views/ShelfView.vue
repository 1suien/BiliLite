<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
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

async function load() {
  const list = await listBooks()
  const cs = await db.covers.toArray()
  const map: Record<string, string> = {}
  for (const c of cs) if (c.dataUrl) map[c.id] = c.dataUrl
  books.value = list
  covers.value = map
  loading.value = false
}

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

onMounted(() => {
  void load()
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
    <header class="shelf-head">
      <div class="brand">
        <svg class="logo" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 5.5C4 4.7 4.7 4 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5v-13Z" />
          <path d="M20 5.5c0-.8-.7-1.5-1.5-1.5H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5v-13Z" />
        </svg>
        <div>
          <h1>墨读</h1>
          <p class="sub">书架 · {{ books.length }} 本</p>
        </div>
      </div>
      <div class="head-actions">
        <button class="icon-btn" title="放入示例书" :disabled="busy" @click="pickSamples">
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3v3M12 18v3M4.2 7.5l2.6 1.5M17.2 15l2.6 1.5M3 12h3M18 12h3M4.2 16.5l2.6-1.5M17.2 9l2.6-1.5" />
            <circle cx="12" cy="12" r="3.2" />
          </svg>
        </button>
        <button class="btn import-btn" @click="pick">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          导入
        </button>
      </div>
    </header>

    <input
      ref="fileInput"
      class="file-input"
      type="file"
      multiple
      accept=".txt,.epub,.pdf,text/plain,application/epub+zip,application/pdf"
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
        <p>导入 TXT、EPUB 或 PDF，开始读第一本。</p>
        <div class="empty-actions">
          <button class="btn" @click="pick">导入本地书</button>
          <button class="btn ghost" @click="pickSamples">放入示例书</button>
        </div>
      </div>

      <!-- 书格 -->
      <div v-else class="grid">
        <article
          v-for="b in books"
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
            <div v-if="b.percent > 0.001" class="continue">读 {{ Math.round(b.percent * 100) }}%</div>
          </div>
          <h3 class="title">{{ b.title }}</h3>
          <p class="meta">
            <span v-if="b.author" class="author">{{ b.author }}</span>
            <span v-else>{{ fmtSize(b.size) }}</span>
            <span class="dot">·</span>
            <span>{{ fmtTime(b.lastReadAt) }}</span>
          </p>
          <div class="bar">
            <i :style="{ width: Math.max(2, b.percent * 100) + '%' }" />
          </div>
        </article>
      </div>
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
  background: linear-gradient(180deg, var(--shelf-bg) 0%, var(--shelf-bg-2) 100%);
}
.shelf-head {
  padding: calc(14px + var(--safe-top)) 18px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  position: sticky;
  top: 0;
  z-index: 5;
  backdrop-filter: blur(8px);
  background: color-mix(in srgb, var(--shelf-bg) 78%, transparent);
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}
.logo {
  color: var(--accent);
}
.brand h1 {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.14em;
}
.sub {
  margin: 1px 0 0;
  font-size: 11.5px;
  color: var(--muted);
  letter-spacing: 0.04em;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.import-btn {
  height: 40px;
  padding: 0 16px;
  font-size: 14px;
  border-radius: 13px;
}
.file-input {
  display: none;
}
.shelf-body {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 6px 16px calc(28px + var(--safe-bottom));
}
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
  border-radius: 8px;
  overflow: hidden;
  aspect-ratio: 3 / 4.25;
  box-shadow: var(--shadow-cover);
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
  padding: 12px;
}
.cover-gen span {
  color: rgba(250, 245, 235, 0.92);
  font-family: var(--font-serif);
  font-size: 15px;
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
  left: 5px;
  top: 5px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  padding: 2px 5px;
  border-radius: 4px;
  color: #fff;
  background: rgba(30, 26, 20, 0.55);
  backdrop-filter: blur(3px);
}
.fmt-epub {
  background: rgba(63, 107, 83, 0.82);
}
.fmt-pdf {
  background: rgba(150, 70, 50, 0.82);
}
.continue {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 14px 6px 4px;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.94);
  background: linear-gradient(180deg, transparent, rgba(20, 16, 10, 0.62));
  text-align: right;
  letter-spacing: 0.04em;
}
.title {
  margin: 8px 2px 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--ink);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 2.7em;
}
.meta {
  margin: 3px 2px 0;
  font-size: 10.5px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta .dot {
  margin: 0 3px;
}
.author {
  color: var(--ink-2);
}
.bar {
  margin: 6px 2px 0;
  height: 2.5px;
  border-radius: 2px;
  background: var(--line);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
  transition: width 0.3s ease;
}
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
</style>
