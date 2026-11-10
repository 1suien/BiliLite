<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type JSZip from 'jszip'
import type { Book, ReaderPos, ReaderSettings, TxtChapter } from '@/db'
import { db } from '@/db'
import { decodeText, parseTxtChapters, textToHtml } from '@/lib/encoding'
import { loadEpubZip, readEpubChapter } from '@/lib/epub'
import { clamp } from '@/lib/util'

const props = defineProps<{
  book: Book
  settings: ReaderSettings
  initial?: ReaderPos | null
}>()

const emit = defineEmits<{
  (
    e: 'state',
    s: {
      chapterTitle: string
      page: number
      pages: number
      percent: number
      chapter: number
      chapters: number
      loading: boolean
    },
  ): void
  (e: 'tap-center'): void
}>()

const viewEl = ref<HTMLDivElement>()
const flowEl = ref<HTMLDivElement>()
const loading = ref(true)
const error = ref('')

// ---------- 内容缓存 ----------
let txtText = ''
let txtChapters: TxtChapter[] = []
let zip: JSZip | null = null
let zipLoading: Promise<JSZip> | null = null
let blobUrls: string[] = []

const chapter = ref(0)
const page = ref(0)
const pages = ref(0)
const chapterTitle = ref('')
let loadToken = 0
let flipToken = 0

function chaptersCount(): number {
  return props.book.format === 'epub' ? props.book.spine?.length || 0 : txtChapters.length
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function margin(): number {
  return props.settings.margin
}

function pageWidth(): number {
  return flowEl.value?.clientWidth || viewEl.value?.clientWidth || 1
}

// ---------- 排版 ----------
function applyTypography() {
  const flow = flowEl.value
  if (!flow) return
  const m = margin()
  flow.style.fontSize = props.settings.fontSize + 'px'
  flow.style.lineHeight = String(props.settings.lineHeight)
  flow.style.fontFamily =
    props.settings.fontFamily === 'serif'
      ? "'Noto Serif CJK SC', 'Source Han Serif SC', 'Songti SC', SimSun, Georgia, serif"
      : "'Noto Sans CJK SC', 'Source Han Sans SC', 'PingFang SC', system-ui, sans-serif"
  flow.style.paddingLeft = m + 'px'
  flow.style.paddingRight = m + 'px'
  flow.style.columnGap = m * 2 + 'px'
  setColumnWidth()
}

/** 列宽 = 可视宽 − 2×边距，列间距 = 2×边距 → 每页水平步长正好等于可视宽 */
function setColumnWidth() {
  const flow = flowEl.value
  if (!flow) return
  const W = pageWidth()
  const m = margin()
  flow.style.columnWidth = Math.max(60, W - m * 2) + 'px'
}

function placeEndMark() {
  const flow = flowEl.value
  if (!flow) return
  flow.querySelectorAll('[data-end]').forEach((el) => el.remove())
  const mark = document.createElement('span')
  mark.setAttribute('data-end', '')
  mark.style.cssText = 'display:inline-block;width:0;height:0;overflow:hidden;padding:0;margin:0'
  const last = flow.lastElementChild
  if (last) last.appendChild(mark)
  else flow.appendChild(mark)
}

function computePages(): number {
  const flow = flowEl.value
  if (!flow) return 1
  const W = pageWidth()
  const m = margin()
  const mark = flow.querySelector('[data-end]') as HTMLElement | null
  let n: number
  if (mark && mark.offsetWidth === 0) {
    // 文末标记在哪一列，就是最后一页；比 scrollWidth 更可靠（不会被多出来的空列骗到）
    const x = mark.offsetLeft
    n = Math.floor(Math.max(0, x - m) / W + 1e-4) + 1
  } else {
    n = Math.round((flow.scrollWidth + m) / W)
  }
  return Math.max(1, n)
}

let fadeSeq = 0

function applyTransform(animate: boolean) {
  const flow = flowEl.value
  if (!flow) return
  const W = pageWidth()
  const tx = `translateX(${-page.value * W}px)`
  const seq = ++flipToken

  if (!animate || props.settings.pageAnim === 'slide') {
    flow.style.transition = animate ? 'transform 0.22s cubic-bezier(0.24, 0.7, 0.3, 1)' : 'none'
    flow.style.opacity = '1'
    flow.style.transform = tx
    return
  }

  // 淡入：淡出 → 跳页 → 淡入；期间又翻页就只保留最后一次
  const my = ++fadeSeq
  flow.style.transition = 'opacity 0.1s ease'
  flow.style.opacity = '0'
  window.setTimeout(() => {
    if (my !== fadeSeq || seq !== flipToken) return
    const f = flowEl.value
    if (!f) return
    f.style.transition = 'none'
    f.style.transform = tx
    void f.offsetHeight
    f.style.transition = 'opacity 0.16s ease'
    f.style.opacity = '1'
  }, 100)
}

function waitImages(flow: HTMLElement): Promise<void> {
  const pending = Array.from(flow.querySelectorAll('img')).filter((img) => !img.complete)
  if (!pending.length) return Promise.resolve()
  return Promise.race([
    Promise.all(
      pending.map(
        (img) =>
          new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true })
            img.addEventListener('error', () => resolve(), { once: true })
          }),
      ),
    ).then(() => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, 1500)),
  ])
}

// ---------- 进度 ----------
function emitState() {
  let percent = 0
  const total = chaptersCount()
  if (props.book.format === 'epub') {
    percent = total ? (chapter.value + (pages.value > 1 ? page.value / (pages.value - 1) : 1)) / total : 0
  } else {
    const totalChars = txtChapters.length ? txtChapters[txtChapters.length - 1].end : 1
    const ch = txtChapters[chapter.value]
    const offset = ch ? ch.start + (pages.value > 1 ? page.value / (pages.value - 1) : 1) * (ch.end - ch.start) : 0
    percent = totalChars ? offset / totalChars : 0
  }
  emit('state', {
    chapterTitle: chapterTitle.value,
    page: page.value,
    pages: pages.value,
    percent: clamp(percent, 0, 1),
    chapter: chapter.value,
    chapters: total,
    loading: loading.value,
  })
}

function emitWithProgress() {
  emitState()
}

// ---------- 打开章节 ----------
function releaseBlobs() {
  for (const u of blobUrls) URL.revokeObjectURL(u)
  blobUrls = []
}

async function ensureZip(): Promise<JSZip> {
  if (zip) return zip
  if (zipLoading) return zipLoading
  zipLoading = (async () => {
    const row = await db.files.get(props.book.id)
    if (!row) throw new Error('书的数据丢了（IndexedDB 里找不到）')
    const z = await loadEpubZip(row.data)
    zip = z
    return z
  })()
  return zipLoading
}

async function openChapter(idx: number, targetPage = 0) {
  const flow = flowEl.value
  if (!flow) return
  const token = ++loadToken
  const total = chaptersCount()
  if (!total) {
    error.value = '这本书没有可读内容'
    loading.value = false
    return
  }
  chapter.value = clamp(idx, 0, total - 1)
  loading.value = true
  error.value = ''

  let html = ''
  try {
    if (props.book.format === 'epub') {
      const z = await ensureZip()
      const item = props.book.spine![chapter.value]
      if (!item) throw new Error('章节索引越界')
      chapterTitle.value = item.title || `第 ${chapter.value + 1} 节`
      releaseBlobs()
      const res = await readEpubChapter(z, item.href, (u) => blobUrls.push(u))
      html = res.html
    } else {
      const ch = txtChapters[chapter.value]
      if (!ch) throw new Error('章节索引越界')
      chapterTitle.value = ch.title || props.book.title
      let body = txtText.slice(ch.start, ch.end)
      const nl = body.indexOf('\n')
      const firstLine = (nl >= 0 ? body.slice(0, nl) : body).trim()
      const showHeading = firstLine && firstLine === ch.title && ch.title !== props.book.title
      if (showHeading) body = nl >= 0 ? body.slice(nl + 1) : ''
      html = showHeading ? `<h2 class="ch-title">${escapeHtml(ch.title)}</h2>` : ''
      html += textToHtml(body)
    }
  } catch (e: any) {
    if (token !== loadToken) return
    error.value = e?.message || String(e)
    loading.value = false
    emitState()
    return
  }
  if (token !== loadToken) return

  flow.style.transition = 'none'
  flow.style.opacity = '1'
  flow.innerHTML = html
  applyTypography()
  placeEndMark()
  await waitImages(flow)
  await nextTick()
  if (token !== loadToken) return

  pages.value = computePages()
  page.value = targetPage < 0 ? pages.value - 1 : clamp(targetPage, 0, pages.value - 1)
  applyTransform(false)
  loading.value = false
  emitWithProgress()
}

// ---------- 翻页 ----------
function turnTo(n: number, animate = true) {
  const max = pages.value - 1
  const target = clamp(n, 0, max)
  if (target === page.value && animate) return
  page.value = target
  applyTransform(animate)
  emitWithProgress()
}

export interface FlipResult {
  atStart: boolean
  atEnd: boolean
}

async function next() {
  if (loading.value) return
  if (page.value < pages.value - 1) {
    turnTo(page.value + 1)
    return { atStart: false, atEnd: false }
  }
  if (chapter.value < chaptersCount() - 1) {
    await openChapter(chapter.value + 1, 0)
    return { atStart: false, atEnd: false }
  }
  return { atStart: false, atEnd: true }
}

async function prev() {
  if (loading.value) return
  if (page.value > 0) {
    turnTo(page.value - 1)
    return { atStart: false, atEnd: false }
  }
  if (chapter.value > 0) {
    await openChapter(chapter.value - 1, -1)
    return { atStart: false, atEnd: false }
  }
  return { atStart: true, atEnd: false }
}

async function goChapter(idx: number) {
  await openChapter(idx, 0)
}

function jumpToPercent(p: number) {
  // 目前只用于「恢复阅读位置」，按章节 + 页处理
  void p
}

function relayout(keepFraction: boolean) {
  const flow = flowEl.value
  if (!flow || loading.value) return
  setColumnWidth()
  const oldPages = pages.value
  const frac = oldPages > 1 ? page.value / (oldPages - 1) : 0
  pages.value = computePages()
  const target = keepFraction && oldPages > 1 ? Math.round(frac * (pages.value - 1)) : page.value
  page.value = clamp(target, 0, pages.value - 1)
  applyTransform(false)
  emitState()
}

// ---------- 手势 ----------
let touchStartX = 0
let touchStartY = 0
let touchStartT = 0
let swiped = false

function onTouchStart(e: TouchEvent) {
  // 双指是捏合（缩放），不当作翻页手势
  if (e.touches.length !== 1) {
    touchStartT = 0
    return
  }
  const t = e.touches[0]
  touchStartX = t.clientX
  touchStartY = t.clientY
  touchStartT = Date.now()
  swiped = false
}

function onTouchEnd(e: TouchEvent) {
  if (!touchStartT) return
  const t = e.changedTouches[0]
  const dx = t.clientX - touchStartX
  const dy = t.clientY - touchStartY
  const dt = Date.now() - touchStartT
  if (Math.abs(dx) > 46 && Math.abs(dx) > Math.abs(dy) * 1.3 && dt < 800) {
    swiped = true
    if (dx < 0) void next()
    else void prev()
  }
}

function onClick(e: MouseEvent) {
  if (swiped) {
    swiped = false
    return
  }
  const el = viewEl.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const x = (e.clientX - rect.left) / rect.width
  if (x < 0.28) void prev()
  else if (x > 0.72) void next()
  else emit('tap-center')
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
    e.preventDefault()
    void next()
  } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
    e.preventDefault()
    void prev()
  } else if (e.key === 'Escape') {
    emit('tap-center')
  }
}

function onWheel(e: WheelEvent) {
  if (Math.abs(e.deltaY) < 12) return
  if (e.deltaY > 0) void next()
  else void prev()
}

// ---------- 生命周期 ----------
let ro: ResizeObserver | null = null

onMounted(async () => {
  try {
    if (props.book.format === 'epub') {
      if (!props.book.spine?.length) throw new Error('EPUB 缺少书脊信息，请重新导入')
    } else {
      const row = await db.files.get(props.book.id)
      if (!row) throw new Error('书的数据丢了（IndexedDB 里找不到）')
      txtText = decodeText(row.data)
      txtChapters = props.book.chapters?.length ? props.book.chapters : parseTxtChapters(txtText, props.book.title)
    }
  } catch (e: any) {
    error.value = e?.message || String(e)
    loading.value = false
    emitState()
    return
  }

  await document.fonts?.ready?.catch?.(() => undefined)
  await nextTick()

  const pos = props.initial
  const ch = pos?.chapter ?? 0
  const pg = pos?.page ?? 0
  await openChapter(ch, pg)

  ro = new ResizeObserver(() => relayout(true))
  if (viewEl.value) ro.observe(viewEl.value)
  window.addEventListener('keydown', onKey)
  viewEl.value?.addEventListener('wheel', onWheel, { passive: true })
})

onBeforeUnmount(() => {
  loadToken++
  releaseBlobs()
  zip = null
  zipLoading = null
  ro?.disconnect()
  window.removeEventListener('keydown', onKey)
  viewEl.value?.removeEventListener('wheel', onWheel)
})

watch(
  () => props.settings,
  () => {
    if (loading.value) return
    applyTypography()
    nextTick(() => relayout(true))
  },
  { deep: true },
)

defineExpose({ next, prev, goChapter, jumpToPercent })
</script>

<template>
  <div class="reflow">
    <div
      ref="viewEl"
      class="reflow-view"
      @click="onClick"
      @touchstart.passive="onTouchStart"
      @touchend.passive="onTouchEnd"
    >
      <div ref="flowEl" class="reflow-flow" />
    </div>

    <div v-if="loading" class="reflow-mask">
      <span class="spinner" />
      <p>排版中…</p>
    </div>
    <div v-else-if="error" class="reflow-mask err">
      <p>打不开这本书</p>
      <span>{{ error }}</span>
    </div>
  </div>
</template>

<style scoped>
.reflow {
  position: absolute;
  inset: 0;
}
.reflow-view {
  position: absolute;
  inset: 0;
  overflow: hidden;
  touch-action: pan-y;
}
.reflow-flow {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  /* 给顶栏/底栏留出固定空间，正文不被浮层遮挡 */
  padding-top: calc(44px + var(--safe-top));
  padding-bottom: calc(30px + var(--safe-bottom));
  column-fill: auto;
  text-align: justify;
  -webkit-hyphens: auto;
  hyphens: auto;
  transform: translateX(0);
  will-change: transform;
  color: var(--r-ink);
  outline: none;
}
.reflow-flow :deep(p) {
  margin: 0 0 0.9em;
  text-indent: 2em;
  text-align: justify;
  word-break: break-word;
}
.reflow-flow :deep(h1),
.reflow-flow :deep(h2),
.reflow-flow :deep(h3),
.reflow-flow :deep(h4) {
  margin: 0.35em 0 0.7em;
  font-size: 1.22em;
  font-weight: 600;
  text-indent: 0;
  line-height: 1.5;
  break-after: avoid;
}
.reflow-flow :deep(img) {
  max-width: 100% !important;
  height: auto !important;
  display: block;
  margin: 0.6em auto;
  border-radius: 6px;
}
.reflow-flow :deep(blockquote) {
  margin: 0.8em 0;
  padding-left: 0.9em;
  border-left: 2px solid var(--r-line);
  color: var(--r-ink-2);
}
.reflow-flow :deep(ul),
.reflow-flow :deep(ol) {
  padding-left: 1.4em;
  margin: 0.6em 0;
}
.reflow-flow :deep(li) {
  margin-bottom: 0.35em;
}
.reflow-flow :deep(hr) {
  border: 0;
  border-top: 1px solid var(--r-line);
  margin: 1em 0;
}
.reflow-flow :deep(table) {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9em;
}
.reflow-flow :deep(td),
.reflow-flow :deep(th) {
  border: 1px solid var(--r-line);
  padding: 4px 6px;
}
.reflow-mask {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: var(--r-bg);
  color: var(--r-muted);
  font-size: 14px;
}
.reflow-mask.err {
  color: var(--r-ink-2);
}
.reflow-mask.err p {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--r-ink);
}
.reflow-mask.err span {
  font-size: 12px;
  max-width: 80%;
  text-align: center;
  word-break: break-all;
}
.spinner {
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
