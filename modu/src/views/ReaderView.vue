<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  db,
  DEFAULT_SETTINGS,
  loadSettings,
  savePos,
  saveSettings,
  type Book,
  type ReaderPos,
  type ReaderSettings,
} from '@/db'
import ReflowReader from '@/readers/ReflowReader.vue'
import PdfReader from '@/readers/PdfReader.vue'
import SettingsSheet from '@/components/SettingsSheet.vue'
import TocSheet, { type TocItem } from '@/components/TocSheet.vue'

const route = useRoute()
const router = useRouter()

const book = shallowRef<Book | null>(null)
const settings = ref<ReaderSettings>({ ...DEFAULT_SETTINGS })
const readerRef = ref<any>()
const tocItems = ref<TocItem[]>([])
const error = ref('')
const ready = ref(false)

const state = ref({
  chapterTitle: '',
  page: 0,
  pages: 1,
  percent: 0,
  chapter: 0,
  chapters: 0,
  loading: true,
})
const pdfLabel = ref('')

const chromeVisible = ref(true)
const sheet = ref<'settings' | 'toc' | null>(null)
const isPdf = computed(() => book.value?.format === 'pdf')

let hideTimer = 0
let saveTimer = 0
let pendingPos: ReaderPos | null = null

function scheduleChromeHide(delay = 3400) {
  window.clearTimeout(hideTimer)
  hideTimer = window.setTimeout(() => (chromeVisible.value = false), delay)
}

function toggleChrome() {
  if (chromeVisible.value) {
    chromeVisible.value = false
    window.clearTimeout(hideTimer)
  } else {
    chromeVisible.value = true
    if (sheet.value === null) scheduleChromeHide()
  }
}

function flushPos() {
  window.clearTimeout(saveTimer)
  saveTimer = 0
  if (!pendingPos || !book.value) return
  const pos = pendingPos
  pendingPos = null
  void savePos(book.value.id, pos).catch(() => undefined)
}

function onState(s: typeof state.value) {
  state.value = s
  if (s.loading) return
  pendingPos = { chapter: s.chapter, page: s.page, percent: s.percent }
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(flushPos, 550)
}

function onPdfState(s: { page: number; pages: number; percent: number; label: string; loading: boolean }) {
  pdfLabel.value = s.label
  onState({
    chapterTitle: '',
    page: s.page,
    pages: s.pages,
    percent: s.percent,
    chapter: s.page,
    chapters: s.pages,
    loading: s.loading,
  })
}

function onPdfOutline(items: TocItem[]) {
  tocItems.value = items
}

async function applySettings(next: ReaderSettings) {
  settings.value = next
  await saveSettings(next).catch(() => undefined)
}

function openToc() {
  if (!tocItems.value.length) return
  sheet.value = 'toc'
  window.clearTimeout(hideTimer)
}

function onTocSelect(index: number) {
  sheet.value = null
  if (isPdf.value) readerRef.value?.goPage?.(index)
  else void readerRef.value?.goChapter?.(index)
  chromeVisible.value = true
  scheduleChromeHide()
}

function zoomIn() {
  readerRef.value?.zoomIn?.()
}
function zoomOut() {
  readerRef.value?.zoomOut?.()
}
function fitWidth() {
  readerRef.value?.fitWidth?.()
}

function back() {
  flushPos()
  if (window.history.length > 1) router.back()
  else void router.push('/')
}

function buildToc(b: Book): TocItem[] {
  if (b.format === 'txt') {
    return (b.chapters || []).map((c, i) => ({ title: c.title, level: 0, index: i }))
  }
  if (b.format === 'epub') {
    return (b.toc || [])
      .filter((t) => typeof t.spine === 'number')
      .map((t) => ({ title: t.title, level: t.level, index: t.spine as number }))
  }
  return []
}

onMounted(async () => {
  const id = String(route.params.id || '')
  try {
    const b = await db.books.get(id)
    if (!b) {
      error.value = '这本书不在书架上了'
      return
    }
    book.value = b
    settings.value = await loadSettings()
    tocItems.value = buildToc(b)
    if (b.pos) {
      state.value = { ...state.value, chapter: b.pos.chapter, page: b.pos.page, percent: b.pos.percent }
    }
    document.title = b.title + ' · 墨读'
    ready.value = true
    scheduleChromeHide()
  } catch (e: any) {
    error.value = e?.message || String(e)
  }
})

onBeforeUnmount(() => {
  window.clearTimeout(hideTimer)
  flushPos()
  document.title = '墨读'
})
</script>

<template>
  <div class="reader" :data-rtheme="settings.theme">
    <!-- 错误 -->
    <div v-if="error" class="fatal">
      <p>{{ error }}</p>
      <button class="btn" @click="back">回到书架</button>
    </div>

    <template v-else-if="book">
      <div class="stage">
        <ReflowReader
          v-if="!isPdf"
          ref="readerRef"
          :key="book.id"
          :book="book"
          :settings="settings"
          :initial="book.pos || null"
          @state="onState"
          @tap-center="toggleChrome"
        />
        <PdfReader
          v-else
          ref="readerRef"
          :key="book.id"
          :book="book"
          :settings="settings"
          :initial="book.pos || null"
          @state="onPdfState"
          @outline="onPdfOutline"
          @tap-center="toggleChrome"
        />
      </div>

      <!-- 顶部进度细线 -->
      <div class="progress-line">
        <i :style="{ width: Math.min(100, state.percent * 100) + '%' }" />
      </div>

      <!-- 顶栏 -->
      <Transition name="fade">
        <header v-if="chromeVisible" class="topbar">
          <button class="tb-btn" aria-label="返回" @click="back">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M15 5l-7 7 7 7" />
            </svg>
          </button>
          <div class="tb-title">
            <strong>{{ isPdf ? book.title : state.chapterTitle || book.title }}</strong>
            <span v-if="!isPdf && book.author">{{ book.author }}</span>
          </div>
          <div class="tb-actions">
            <button v-if="tocItems.length" class="tb-btn" aria-label="目录" @click="openToc">
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 6.5h9M4 12h12M4 17.5h7" />
                <path d="M18 8.5v-3l2 1" stroke-width="1.6" />
              </svg>
            </button>
            <button v-if="!isPdf" class="tb-btn" aria-label="阅读设置" @click="sheet = 'settings'">
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
                <circle cx="16" cy="7" r="2.1" />
                <circle cx="10" cy="17" r="2.1" />
              </svg>
            </button>
          </div>
        </header>
      </Transition>

      <!-- 底栏 -->
      <Transition name="fade">
        <footer v-if="!state.loading" class="footbar">
          <template v-if="isPdf">
            <button class="fb-btn" @click="zoomOut">A−</button>
            <span class="fb-label">{{ pdfLabel }}</span>
            <button class="fb-btn" @click="zoomIn">A+</button>
            <button class="fb-btn small" @click="fitWidth">适宽</button>
          </template>
          <template v-else>
            <span class="fb-label">{{ Math.min(state.page + 1, state.pages) }} / {{ Math.max(1, state.pages) }} 页</span>
            <span class="fb-dot">·</span>
            <span class="fb-label">{{ Math.round(state.percent * 100) }}%</span>
          </template>
        </footer>
      </Transition>

      <SettingsSheet
        v-if="sheet === 'settings'"
        :settings="settings"
        @update="applySettings"
        @close="sheet = null"
      />
      <TocSheet
        v-if="sheet === 'toc'"
        :items="tocItems"
        :current="state.chapter"
        @select="onTocSelect"
        @close="sheet = null"
      />
    </template>

    <div v-else-if="!ready" class="fatal loading">
      <span class="ring" />
    </div>
  </div>
</template>

<style scoped>
.reader {
  position: fixed;
  inset: 0;
  background: var(--r-bg);
  color: var(--r-ink);
  overflow: hidden;
}
.stage {
  position: absolute;
  inset: 0;
}
.progress-line {
  position: absolute;
  left: 0;
  top: 0;
  right: 0;
  height: 2px;
  z-index: 24;
  background: transparent;
  pointer-events: none;
}
.progress-line i {
  display: block;
  height: 100%;
  background: var(--r-ink-2);
  opacity: 0.28;
  transition: width 0.25s ease;
}
.topbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 8px;
  height: calc(44px + var(--safe-top));
  padding: var(--safe-top) 6px 0;
  background: linear-gradient(180deg, var(--r-panel) 40%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.tb-btn {
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  color: var(--r-ink);
  transition: background 0.15s ease;
}
.tb-btn:active {
  background: var(--r-line);
}
.tb-title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  line-height: 1.3;
}
.tb-title strong {
  font-size: 14.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tb-title span {
  font-size: 11px;
  color: var(--r-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tb-actions {
  display: flex;
  gap: 2px;
  flex: 0 0 auto;
}
.footbar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 14px calc(8px + var(--safe-bottom));
  font-size: 11.5px;
  color: var(--r-muted);
  background: linear-gradient(0deg, var(--r-panel) 45%, transparent);
  pointer-events: none;
}
.footbar > * {
  pointer-events: auto;
}
.fb-label {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
}
.fb-dot {
  opacity: 0.5;
}
.fb-btn {
  height: 30px;
  min-width: 44px;
  padding: 0 10px;
  border-radius: 9px;
  font-size: 12.5px;
  color: var(--r-ink-2);
  background: color-mix(in srgb, var(--r-ink) 8%, transparent);
}
.fb-btn.small {
  min-width: 40px;
  font-size: 12px;
}
.fb-btn:active {
  background: color-mix(in srgb, var(--r-ink) 16%, transparent);
}
.fatal {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  padding: 30px;
  text-align: center;
  color: var(--r-ink-2);
}
.fatal p {
  margin: 0;
  font-size: 15px;
}
.ring {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2.5px solid var(--r-line);
  border-top-color: var(--r-ink-2);
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
