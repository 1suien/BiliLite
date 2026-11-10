<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  db,
  DEFAULT_SETTINGS,
  HL_COLORS,
  loadAiSettings,
  loadSettings,
  saveAiSettings,
  listAnnotations,
  savePos,
  saveSession,
  addReadMs,
  saveSettings,
  type AiSettings,
  type Annotation,
  type Book,
  type HlColor,
  type ReaderPos,
  type ReaderSettings,
} from '@/db'
import { uid } from '@/lib/util'
import ReflowReader, { type ReaderState } from '@/readers/ReflowReader.vue'
import PdfReader from '@/readers/PdfReader.vue'
import ComicReader from '@/readers/ComicReader.vue'
import SettingsSheet from '@/components/SettingsSheet.vue'
import TocSheet, { type TocItem } from '@/components/TocSheet.vue'
import NotesSheet from '@/components/NotesSheet.vue'
import AiSheet from '@/components/AiSheet.vue'

const route = useRoute()
const router = useRouter()

interface Sel {
  start: number
  end: number
  quote: string
  top: number
  bottom: number
  left: number
  right: number
}

const book = shallowRef<Book | null>(null)
const settings = ref<ReaderSettings>({ ...DEFAULT_SETTINGS })
const aiSettings = ref<AiSettings>({ baseUrl: '', apiKey: '', model: '' })
const readerRef = ref<any>()
const tocItems = ref<TocItem[]>([])
const annotations = ref<Annotation[]>([])
const error = ref('')
const ready = ref(false)

const state = ref<ReaderState>({
  chapterTitle: '',
  page: 0,
  pages: 1,
  percent: 0,
  chapter: 0,
  chapters: 0,
  loading: true,
  sentenceIndex: 0,
  sentences: 0,
  chapterChars: 0,
  remainMin: 0,
})
const pdfLabel = ref('')

const chromeVisible = ref(true)
const sheet = ref<'settings' | 'toc' | 'notes' | 'ai' | 'menu' | null>(null)
const sel = ref<Sel | null>(null)
const markMenu = ref<{ id: string; top: number; bottom: number; left: number } | null>(null)
const toastMsg = ref('')
const chipAlt = ref(false)
const noteEdit = ref<{ id?: string; quote: string; start: number; end: number; color: HlColor; chapter: number; chapterTitle: string } | null>(null)
const noteText = ref('')
const aiQuote = ref('')

const isReflow = computed(() => !!book.value && ['txt', 'epub', 'fb2'].includes(book.value.format))
const isPdf = computed(() => book.value?.format === 'pdf')
const isComic = computed(() => book.value?.format === 'cbz')
const pct = computed(() => clampPct(Math.round(state.value.percent * 100)))
const chapterPct = computed(() => `${Math.round(state.value.percent * 100)}%`)

function clampPct(n: number) {
  return Math.max(0, Math.min(100, n))
}

// ---------------- 会话计时 ----------------
let sessionStart = 0
let activeStarted = 0
let activeMs = 0
let pagesTurned = 0
let lastPage = -1
const elapsed = ref(0)
let tickTimer = 0

function startSession() {
  sessionStart = Date.now()
  activeStarted = Date.now()
  activeMs = 0
  pagesTurned = 0
  lastPage = -1
  window.clearInterval(tickTimer)
  tickTimer = window.setInterval(() => {
    elapsed.value = activeMs + (document.visibilityState === 'visible' ? Date.now() - activeStarted : 0)
  }, 1000)
}

function flushTick() {
  const now = Date.now()
  if (document.visibilityState === 'visible') activeMs += now - activeStarted
  activeStarted = now
  elapsed.value = activeMs
}

async function flushSession() {
  flushTick()
  const b = book.value
  if (!b || activeMs < 3000) return
  const start = sessionStart
  sessionStart = Date.now()
  await saveSession({
    id: uid(),
    bookId: b.id,
    bookTitle: b.title,
    start,
    end: start + activeMs,
    pages: pagesTurned,
  }).catch(() => undefined)
  await addReadMs(b.id, activeMs).catch(() => undefined)
  activeMs = 0
  pagesTurned = 0
}

const clock = computed(() => {
  const s = Math.floor(elapsed.value / 1000)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
})

const chipMain = computed(() => {
  if (settings.value.focusMode && state.value.sentences > 0) {
    return `${state.value.sentenceIndex + 1} / ${state.value.sentences} 句`
  }
  return `${Math.min(state.value.page + 1, Math.max(1, state.value.pages))} / ${Math.max(1, state.value.pages)}`
})
const chipSub = computed(() => (chipAlt.value ? `${pct.value}%` : clock.value))

// ---------------- chrome ----------------
let hideTimer = 0
function scheduleChromeHide(delay = 3600) {
  window.clearTimeout(hideTimer)
  if (sheet.value || noteEdit.value || sel.value) return
  hideTimer = window.setTimeout(() => (chromeVisible.value = false), delay)
}
function toggleChrome() {
  if (chromeVisible.value) {
    chromeVisible.value = false
    window.clearTimeout(hideTimer)
  } else {
    chromeVisible.value = true
    scheduleChromeHide()
  }
}
function openSheet(s: 'settings' | 'toc' | 'notes' | 'ai' | 'menu') {
  sheet.value = s
  chromeVisible.value = true
  window.clearTimeout(hideTimer)
}
function closeSheet() {
  sheet.value = null
  if (!noteEdit.value) scheduleChromeHide()
}

// ---------------- 进度保存 ----------------
let saveTimer = 0
let pendingPos: ReaderPos | null = null
function flushPos() {
  window.clearTimeout(saveTimer)
  saveTimer = 0
  if (!pendingPos || !book.value) return
  const pos = pendingPos
  pendingPos = null
  void savePos(book.value.id, pos).catch(() => undefined)
}

function onState(s: ReaderState) {
  const prevPage = state.value.page
  state.value = s
  if (s.loading) return
  if (lastPage < 0) lastPage = s.page
  else if (s.page !== lastPage) {
    pagesTurned += Math.abs(s.page - lastPage)
    lastPage = s.page
  }
  void prevPage
  pendingPos = { chapter: s.chapter, page: s.page, percent: s.percent }
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(flushPos, 600)
}

function onPdfState(s: { page: number; pages: number; percent: number; label: string; loading: boolean }) {
  pdfLabel.value = s.label
  onState({
    ...state.value,
    chapterTitle: '',
    page: s.page,
    pages: s.pages,
    percent: s.percent,
    chapter: s.page,
    chapters: s.pages,
    loading: s.loading,
    sentences: 0,
  })
}

function onComicState(s: { page: number; pages: number; percent: number; loading: boolean }) {
  onState({
    ...state.value,
    chapterTitle: '',
    page: s.page,
    pages: s.pages,
    percent: s.percent,
    chapter: s.page,
    chapters: s.pages,
    loading: s.loading,
    sentences: 0,
  })
}

function onPdfOutline(items: TocItem[]) {
  tocItems.value = items
}

// ---------------- 设置 ----------------
async function applySettings(next: ReaderSettings) {
  settings.value = next
  await saveSettings(next).catch(() => undefined)
}
function toggleFocus() {
  const next = { ...settings.value, focusMode: !settings.value.focusMode }
  void applySettings(next)
  showToast(next.focusMode ? '逐句聚焦：点左右两侧逐句读' : '已退出逐句聚焦')
  scheduleChromeHide()
}

// ---------------- 书架交互 ----------------
function back() {
  flushPos()
  void flushSession()
  if (window.history.length > 1) router.back()
  else void router.push('/')
}

function buildToc(b: Book): TocItem[] {
  if (b.format === 'txt' || b.format === 'fb2') {
    return (b.chapters || []).map((c, i) => ({ title: c.title, level: 0, index: i }))
  }
  if (b.format === 'epub') {
    return (b.toc || [])
      .filter((t) => typeof t.spine === 'number')
      .map((t) => ({ title: t.title, level: t.level, index: t.spine as number }))
  }
  return []
}

function onTocSelect(index: number) {
  closeSheet()
  if (isPdf.value) void readerRef.value?.goPage?.(index)
  else if (!isComic.value) void readerRef.value?.goChapter?.(index)
  chromeVisible.value = false
}

// ---------------- 划线批注 ----------------
async function reloadAnnotations() {
  if (!book.value) return
  annotations.value = await listAnnotations(book.value.id)
}
function onSelection(v: Sel | null) {
  markMenu.value = null
  if (v && v.quote.trim()) {
    sel.value = v
    chromeVisible.value = true
    window.clearTimeout(hideTimer)
  } else {
    sel.value = null
  }
}
function clearSel() {
  sel.value = null
  readerRef.value?.clearSelection?.()
}
const selStyle = computed(() => {
  const s = sel.value
  if (!s) return {}
  const w = 344
  const cx = (s.left + s.right) / 2
  const left = Math.max(10, Math.min(window.innerWidth - w - 10, cx - w / 2))
  const top = Math.max(56, s.top - 58)
  return { left: left + 'px', top: top + 'px' }
})
const markStyle = computed(() => {
  const m = markMenu.value
  if (!m) return {}
  const w = 232
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, m.left - w / 2))
  return { left: left + 'px', top: Math.max(52, m.top - 54) + 'px' }
})

async function applyColor(color: HlColor) {
  const s = sel.value
  if (!s || !book.value || !isReflow.value) return
  await readerRef.value?.createHighlight?.({ start: s.start, end: s.end, quote: s.quote, color })
  clearSel()
  await reloadAnnotations()
  showToast('已划线')
  scheduleChromeHide()
}

function openNoteFromSel() {
  const s = sel.value
  if (!s) return
  noteEdit.value = {
    quote: s.quote,
    start: s.start,
    end: s.end,
    color: 'yellow',
    chapter: state.value.chapter,
    chapterTitle: state.value.chapterTitle,
  }
  noteText.value = ''
  sel.value = null
}
function openNoteFromEdit(a: Annotation) {
  noteEdit.value = {
    id: a.id,
    quote: a.quote,
    start: a.start,
    end: a.end,
    color: a.color,
    chapter: a.chapter,
    chapterTitle: a.chapterTitle,
  }
  noteText.value = a.note
  sheet.value = null
}
async function saveNote() {
  const e = noteEdit.value
  if (!e) return
  if (e.id) {
    const a = annotations.value.find((x) => x.id === e.id)
    if (a) {
      await readerRef.value?.updateAnnotation?.({ ...a, note: noteText.value.trim(), color: e.color })
    }
  } else {
    await readerRef.value?.createHighlight?.({
      start: e.start,
      end: e.end,
      quote: e.quote,
      color: e.color,
      note: noteText.value.trim(),
    })
  }
  noteEdit.value = null
  await reloadAnnotations()
  showToast('已保存')
  scheduleChromeHide()
}
function closeNote() {
  noteEdit.value = null
  if (noteText.value.trim() === '') clearSel()
  scheduleChromeHide()
}
async function delNote() {
  const e = noteEdit.value
  if (!e?.id) return
  await readerRef.value?.deleteAnnotation?.(e.id)
  noteEdit.value = null
  await reloadAnnotations()
  showToast('已删除')
}

function onMarkTap(m: { id: string; top: number; bottom: number; left: number }) {
  sel.value = null
  markMenu.value = m
  chromeVisible.value = true
  window.clearTimeout(hideTimer)
}
function markOf(id: string): Annotation | undefined {
  return annotations.value.find((a) => a.id === id)
}
async function recolorMark(color: HlColor) {
  const m = markMenu.value
  const a = m && markOf(m.id)
  if (!a) return
  await readerRef.value?.updateAnnotation?.({ ...a, color })
  markMenu.value = null
  await reloadAnnotations()
}
async function delMark() {
  const m = markMenu.value
  if (!m) return
  await readerRef.value?.deleteAnnotation?.(m.id)
  markMenu.value = null
  await reloadAnnotations()
  showToast('已删除划线')
}
function editMark() {
  const m = markMenu.value
  const a = m && markOf(m.id)
  if (!a) return
  markMenu.value = null
  openNoteFromEdit(a)
}

async function fromNotes(a: Annotation) {
  sheet.value = null
  if (isReflow.value) await readerRef.value?.focusAnnotation?.(a.id)
  else if (isPdf.value) void readerRef.value?.goPage?.(a.chapter)
  chromeVisible.value = false
}

async function onSaveAi(s: AiSettings) {
  aiSettings.value = s
  await saveAiSettings(s).catch(() => undefined)
}

async function delMarkById(a: Annotation) {
  await readerRef.value?.deleteAnnotation?.(a.id)
  await reloadAnnotations()
  showToast('已删除')
}

function openAI(quote = '') {
  aiQuote.value = quote
  sel.value = null
  openSheet('ai')
}

// ---------------- 剪贴板 ----------------
async function copySel() {
  const s = sel.value
  if (!s) return
  try {
    await navigator.clipboard.writeText(s.quote)
    showToast('已复制')
  } catch {
    showToast('复制失败，可长按文字手动复制')
  }
  clearSel()
  scheduleChromeHide()
}

// ---------------- toast ----------------
let toastTimer = 0
function showToast(msg: string) {
  toastMsg.value = msg
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toastMsg.value = ''), 1800)
}

// ---------------- PDF / 漫画工具 ----------------
function zoomIn() {
  readerRef.value?.zoomIn?.()
}
function zoomOut() {
  readerRef.value?.zoomOut?.()
}
function fitWidth() {
  readerRef.value?.fitWidth?.()
}

// ---------------- 常亮 ----------------
let wakeLock: any = null
async function acquireWakeLock() {
  if (!settings.value.keepAwake) return
  try {
    const nav = navigator as any
    if (nav.wakeLock?.request) wakeLock = await nav.wakeLock.request('screen')
  } catch {
    wakeLock = null
  }
}
function releaseWakeLock() {
  try {
    void wakeLock?.release?.()
  } catch {
    /* ignore */
  }
  wakeLock = null
}

function onVisibility() {
  if (document.visibilityState === 'hidden') {
    flushTick()
    flushPos()
    void flushSession()
  } else {
    activeStarted = Date.now()
    void acquireWakeLock()
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (noteEdit.value) closeNote()
    else if (sheet.value) closeSheet()
    else if (sel.value) clearSel()
    else if (markMenu.value) markMenu.value = null
    else if (chromeVisible.value) chromeVisible.value = false
  }
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
    aiSettings.value = await loadAiSettings()
    tocItems.value = buildToc(b)
    if (b.pos) {
      state.value = { ...state.value, chapter: b.pos.chapter, page: b.pos.page, percent: b.pos.percent }
    }
    document.title = b.title + ' · 墨读'
    ready.value = true
    startSession()
    await reloadAnnotations()
    void acquireWakeLock()
    scheduleChromeHide()
  } catch (e: any) {
    error.value = e?.message || String(e)
  }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  window.clearTimeout(hideTimer)
  window.clearInterval(tickTimer)
  window.clearTimeout(toastTimer)
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('keydown', onKey)
  flushPos()
  void flushSession()
  releaseWakeLock()
  document.title = '墨读'
})
</script>

<template>
  <div class="reader" :data-rtheme="settings.theme">
    <div v-if="error" class="fatal">
      <p>{{ error }}</p>
      <button class="solid" @click="back">回到书架</button>
    </div>

    <template v-else-if="book">
      <div class="stage" @click="markMenu = null">
        <ReflowReader
          v-if="isReflow"
          ref="readerRef"
          :key="book.id"
          :book="book"
          :settings="settings"
          :initial="book.pos || null"
          @state="onState"
          @tap-center="toggleChrome"
          @selection="onSelection"
          @mark-tap="onMarkTap"
          @annotations-changed="reloadAnnotations"
          @toast="showToast"
        />
        <PdfReader
          v-else-if="isPdf"
          ref="readerRef"
          :key="book.id"
          :book="book"
          :settings="settings"
          :initial="book.pos || null"
          @state="onPdfState"
          @outline="onPdfOutline"
          @tap-center="toggleChrome"
        />
        <ComicReader
          v-else
          ref="readerRef"
          :key="book.id"
          :book="book"
          :initial="book.pos || null"
          @state="onComicState"
          @tap-center="toggleChrome"
          @toast="showToast"
        />
      </div>

      <div class="progress-line"><i :style="{ width: pct + '%' }" /></div>

      <!-- 常驻阅读读数：页/句 + 百分比或本次用时 -->
      <button v-if="!state.loading" class="chip" :class="{ dim: !chromeVisible }" @click="chipAlt = !chipAlt">
        <span class="num">{{ chipMain }}</span>
        <i class="hair" />
        <span class="num sub">{{ chipSub }}</span>
      </button>

      <!-- 顶栏 -->
      <Transition name="fade">
        <header v-if="chromeVisible" class="topbar">
          <button class="tb" aria-label="返回" @click="back">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M15 5l-7 7 7 7" />
            </svg>
          </button>
          <div class="tb-title">
            <strong>{{ state.chapterTitle || book.title }}</strong>
            <span v-if="isReflow">
              第 {{ state.chapter + 1 }} / {{ Math.max(1, state.chapters) }} 章
              <template v-if="settings.focusMode && state.remainMin"> · 剩 {{ state.remainMin }} 分钟</template>
              <template v-else> · {{ chapterPct }}</template>
            </span>
            <span v-else>
              {{ book.format.toUpperCase() }} · {{ pct }}%
              <template v-if="pdfLabel"> · {{ pdfLabel }}</template>
            </span>
          </div>
          <button v-if="!isComic" class="tb" aria-label="笔记" @click="openSheet('notes')">
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 4h11l3 3v13H5z" />
              <path d="M8 9h8M8 13h8M8 17h5" />
            </svg>
          </button>
          <button class="tb" aria-label="更多" @click="openSheet('menu')">
            <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="5" cy="12" r="1.7" />
              <circle cx="12" cy="12" r="1.7" />
              <circle cx="19" cy="12" r="1.7" />
            </svg>
          </button>
        </header>
      </Transition>

      <!-- 底部浮动工具条 -->
      <Transition name="rise">
        <div v-if="chromeVisible && !state.loading" class="pill">
          <template v-if="isReflow">
            <button class="pb" aria-label="上一页" @click="readerRef?.prev?.()">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6l-6 6 6 6" /></svg>
            </button>
            <button class="pb" aria-label="下一页" @click="readerRef?.next?.()">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 6l6 6-6 6" /></svg>
            </button>
            <i class="divider" />
            <button class="pb" :class="{ on: settings.focusMode }" aria-label="逐句聚焦" @click="toggleFocus">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="6.5" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
              </svg>
            </button>
            <i class="divider" />
            <button class="pb" aria-label="目录" :disabled="!tocItems.length" @click="openSheet('toc')">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 6.5h9M4 12h12M4 17.5h7" />
                <path d="M18 8.5v-3l2 1" stroke-width="1.6" />
              </svg>
            </button>
            <button class="pb" aria-label="笔记" @click="openSheet('notes')">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 4h11l3 3v13H5z" />
                <path d="M8 9h8M8 13h8M8 17h5" />
              </svg>
            </button>
            <button class="pb" aria-label="阅读外观" @click="openSheet('settings')">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 19V7.5M4 19h16" />
                <path d="M8.4 15.5 12 6l3.6 9.5" />
                <path d="M9.7 12.5h4.6" />
              </svg>
            </button>
            <button class="pb" aria-label="阅读助手" @click="openAI()">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 5.5h16v11H9l-5 4z" />
                <path d="M9 11h6" />
              </svg>
            </button>
          </template>
          <template v-else-if="isPdf">
            <button class="pb" aria-label="缩小" @click="zoomOut">A−</button>
            <span class="plabel">{{ pdfLabel }}</span>
            <button class="pb" aria-label="放大" @click="zoomIn">A+</button>
            <i class="divider" />
            <button class="pb wide" @click="fitWidth">适宽</button>
            <button class="pb" aria-label="目录" :disabled="!tocItems.length" @click="openSheet('toc')">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 6.5h9M4 12h12M4 17.5h7" />
              </svg>
            </button>
          </template>
          <template v-else>
            <button class="pb" aria-label="上一页" @click="readerRef?.prev?.()">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6l-6 6 6 6" /></svg>
            </button>
            <span class="plabel">{{ Math.min(state.page + 1, state.pages) }} / {{ state.pages }}</span>
            <button class="pb" aria-label="下一页" @click="readerRef?.next?.()">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 6l6 6-6 6" /></svg>
            </button>
          </template>
        </div>
      </Transition>

      <!-- 选中文本工具条 -->
      <Transition name="pop">
        <div v-if="sel" class="sel-bar" :style="selStyle" @pointerdown.stop>
          <div class="colors">
            <button
              v-for="c in HL_COLORS"
              :key="c"
              class="dot"
              :class="'d-' + c"
              :aria-label="'划 ' + c"
              @click="applyColor(c)"
            />
          </div>
          <i class="divider" />
          <button class="sb" @click="openNoteFromSel">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z" /></svg>
            想法
          </button>
          <button class="sb" @click="copySel">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5h9" /></svg>
            复制
          </button>
          <button class="sb" @click="openAI(sel?.quote || '')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.4L19 10l-5.1 1.6L12 17l-1.9-5.4L5 10l5.1-1.6z" /></svg>
            问 AI
          </button>
        </div>
      </Transition>

      <!-- 划线菜单 -->
      <Transition name="pop">
        <div v-if="markMenu" class="mark-pop" :style="markStyle" @pointerdown.stop>
          <button
            v-for="c in HL_COLORS"
            :key="c"
            class="dot"
            :class="'d-' + c"
            @click="recolorMark(c)"
          />
          <i class="divider" />
          <button class="sb" @click="editMark">笔记</button>
          <button class="sb danger" @click="delMark">删除</button>
        </div>
      </Transition>

      <!-- 面板 -->
      <SettingsSheet
        v-if="sheet === 'settings'"
        :settings="settings"
        @update="applySettings"
        @close="closeSheet"
      />
      <TocSheet
        v-if="sheet === 'toc'"
        :items="tocItems"
        :current="state.chapter"
        @select="onTocSelect"
        @close="closeSheet"
      />
      <NotesSheet
        v-if="sheet === 'notes'"
        :annotations="annotations"
        :current-chapter="state.chapter"
        @select="fromNotes"
        @edit="openNoteFromEdit"
        @remove="delMarkById"
        @close="closeSheet"
      />
      <AiSheet
        v-if="sheet === 'ai'"
        :book-title="book.title"
        :chapter-title="state.chapterTitle || book.title"
        :quote="aiQuote"
        :ai="aiSettings"
        :get-context="() => readerRef?.getContextText?.(1800)"
        @save-ai="onSaveAi"
        @close="closeSheet"
      />

      <!-- 更多菜单 -->
      <Transition name="fade">
        <div v-if="sheet === 'menu'" class="scrim" @click="closeSheet" />
      </Transition>
      <Transition name="sheet">
        <div v-if="sheet === 'menu'" class="sheet menu-sheet" @click.stop>
          <button class="mrow" @click="openSheet('notes')">
            <span>书中笔记</span><span class="mcount">{{ annotations.length }}</span>
          </button>
          <button class="mrow" @click="openSheet('settings')"><span>阅读外观</span></button>
          <button class="mrow" @click="openSheet('ai')"><span>阅读助手</span></button>
          <button class="mrow" @click="back"><span>回到书架</span></button>
        </div>
      </Transition>

      <!-- 笔记编辑 -->
      <Transition name="fade">
        <div v-if="noteEdit" class="modal-scrim" @click="closeNote" />
      </Transition>
      <Transition name="pop">
        <div v-if="noteEdit" class="modal">
          <h3>写想法</h3>
          <p class="quote">{{ noteEdit.quote }}</p>
          <div class="colors">
            <button v-for="c in HL_COLORS" :key="c" class="dot large" :class="['d-' + c, { ring: noteEdit.color === c }]" @click="noteEdit && (noteEdit.color = c)" />
          </div>
          <textarea v-model="noteText" rows="4" placeholder="这句话让你想到什么？" />
          <div class="actions">
            <button class="ghost" @click="closeNote">取消</button>
            <button v-if="noteEdit.id" class="ghost danger" @click="delNote">删除</button>
            <span class="grow" />
            <button class="solid sm" @click="saveNote">保存</button>
          </div>
        </div>
      </Transition>

      <!-- toast -->
      <Transition name="fade">
        <div v-if="toastMsg" class="toast">{{ toastMsg }}</div>
      </Transition>
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
  transition: background 0.25s ease;
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
  pointer-events: none;
}
.progress-line i {
  display: block;
  height: 100%;
  background: var(--r-ink-2);
  opacity: 0.2;
  transition: width 0.3s ease;
}

/* 常驻读数胶囊 */
.chip {
  position: absolute;
  z-index: 26;
  top: calc(10px + var(--safe-top));
  right: 12px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 10px;
  border-radius: 9px;
  border: 1px solid color-mix(in srgb, var(--r-ink) 12%, transparent);
  background: color-mix(in srgb, var(--r-panel) 88%, transparent);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  color: var(--r-ink-2);
  box-shadow: 0 4px 16px -6px rgba(28, 25, 23, 0.25);
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.chip.dim {
  opacity: 0.72;
}
.chip .num {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.chip .sub {
  min-width: 30px;
  text-align: center;
  color: var(--r-muted);
}
.hair {
  width: 1px;
  height: 12px;
  background: color-mix(in srgb, var(--r-ink) 18%, transparent);
}

/* 顶栏 */
.topbar {
  position: absolute;
  z-index: 30;
  top: 0;
  left: 0;
  right: 0;
  height: calc(48px + var(--safe-top));
  padding: var(--safe-top) 6px 0;
  display: flex;
  align-items: center;
  gap: 2px;
  background: linear-gradient(180deg, var(--r-panel) 32%, color-mix(in srgb, var(--r-panel) 70%, transparent) 72%, transparent);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
}
.tb {
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
.tb:active {
  background: color-mix(in srgb, var(--r-ink) 9%, transparent);
}
.tb-title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-left: 2px;
}
.tb-title strong {
  font-family: var(--font-serif);
  font-size: 14.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tb-title span {
  font-size: 11px;
  color: var(--r-muted);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 浮动工具条 */
.pill {
  position: absolute;
  z-index: 32;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(18px + var(--safe-bottom));
  display: flex;
  align-items: center;
  gap: 1px;
  height: 46px;
  padding: 0 5px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--r-ink) 13%, transparent);
  background: color-mix(in srgb, var(--r-panel) 92%, transparent);
  -webkit-backdrop-filter: blur(14px);
  backdrop-filter: blur(14px);
  box-shadow: 0 6px 22px -8px rgba(28, 25, 23, 0.32);
  max-width: calc(100vw - 16px);
}
.pb {
  min-width: 38px;
  height: 36px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  color: var(--r-ink-2);
  font-size: 13px;
  font-weight: 500;
}
.pb.wide {
  min-width: 46px;
}
.pb:active {
  background: color-mix(in srgb, var(--r-ink) 10%, transparent);
}
.pb.on {
  background: color-mix(in srgb, var(--r-ink) 12%, transparent);
  color: var(--r-ink);
}
.pb:disabled {
  opacity: 0.34;
}
.divider {
  width: 1px;
  height: 18px;
  margin: 0 3px;
  background: color-mix(in srgb, var(--r-ink) 14%, transparent);
}
.plabel {
  font-size: 11.5px;
  color: var(--r-muted);
  font-variant-numeric: tabular-nums;
  padding: 0 3px;
  white-space: nowrap;
}

/* 选中 / 划线浮条 */
.sel-bar,
.mark-pop {
  position: fixed;
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 44px;
  padding: 0 6px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--r-ink) 12%, transparent);
  background: color-mix(in srgb, var(--r-panel) 96%, transparent);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  box-shadow: 0 8px 28px -8px rgba(28, 25, 23, 0.3);
}
.sel-bar {
  width: 344px;
  justify-content: space-between;
}
.mark-pop {
  height: 40px;
}
.colors {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 2px;
}
.dot {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, var(--r-ink) 16%, transparent);
}
.dot.large {
  width: 26px;
  height: 26px;
}
.dot.ring {
  box-shadow: 0 0 0 2px var(--r-panel), 0 0 0 3.5px var(--r-ink-2);
}
.d-yellow {
  background: #f2cd5e;
}
.d-green {
  background: #9ccf95;
}
.d-blue {
  background: #94bfe8;
}
.d-pink {
  background: #e9aeb6;
}
.sb {
  height: 32px;
  padding: 0 9px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 8px;
  font-size: 12.5px;
  color: var(--r-ink-2);
  white-space: nowrap;
}
.sb:active {
  background: color-mix(in srgb, var(--r-ink) 9%, transparent);
}
.sb.danger {
  color: var(--danger);
}

/* 菜单面板 */
.menu-sheet {
  padding-top: 14px;
}
.mrow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  height: 50px;
  padding: 0 4px;
  font-size: 15px;
  color: var(--ink);
  border-bottom: 1px solid var(--line);
}
.mrow:last-child {
  border-bottom: 0;
}
.mrow:active {
  opacity: 0.55;
}
.mcount {
  font-size: 12px;
  color: var(--muted);
}

/* 笔记编辑弹窗 */
.modal-scrim {
  position: fixed;
  inset: 0;
  z-index: 72;
  background: rgba(20, 16, 10, 0.42);
  -webkit-backdrop-filter: blur(2px);
  backdrop-filter: blur(2px);
}
.modal {
  position: fixed;
  z-index: 74;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(420px, calc(100vw - 32px));
  padding: 20px;
  border-radius: 20px;
  background: var(--surface);
  color: var(--ink);
  box-shadow: 0 18px 50px rgba(24, 18, 10, 0.28);
}
.modal h3 {
  margin: 0 0 12px;
  font-size: 16px;
}
.modal .quote {
  margin: 0 0 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--surface-2);
  font-family: var(--font-serif);
  font-size: 13px;
  line-height: 1.65;
  color: var(--ink-2);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.modal .colors {
  gap: 12px;
  margin-bottom: 12px;
}
.modal textarea {
  width: 100%;
  box-sizing: border-box;
  resize: none;
  border: 0;
  outline: none;
  border-radius: 12px;
  padding: 11px 12px;
  background: var(--surface-2);
  color: var(--ink);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.6;
}
.modal textarea::placeholder {
  color: var(--muted);
}
.actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 14px;
}
.grow {
  flex: 1;
}
.ghost {
  height: 38px;
  padding: 0 12px;
  border-radius: 10px;
  font-size: 13.5px;
  color: var(--ink-2);
}
.ghost:active {
  background: var(--surface-2);
}
.ghost.danger {
  color: var(--danger);
}
.solid {
  height: 44px;
  padding: 0 22px;
  border-radius: 13px;
  background: var(--accent);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
}
.solid.sm {
  height: 38px;
  padding: 0 20px;
  font-size: 13.5px;
}

/* toast */
.toast {
  position: fixed;
  z-index: 80;
  left: 50%;
  bottom: calc(80px + var(--safe-bottom));
  transform: translateX(-50%);
  max-width: 80vw;
  padding: 9px 16px;
  border-radius: 12px;
  background: rgba(28, 25, 23, 0.9);
  color: #f5f1e8;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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

/* 动效 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
.rise-enter-active,
.rise-leave-active {
  transition: opacity 0.22s ease, transform 0.26s cubic-bezier(0.32, 0.72, 0, 1);
}
.rise-enter-from,
.rise-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(14px);
}
.pop-enter-active,
.pop-leave-active {
  transition: opacity 0.16s ease, transform 0.18s cubic-bezier(0.32, 0.72, 0, 1);
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: scale(0.94);
}
</style>
