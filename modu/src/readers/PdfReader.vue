<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Book, ReaderPos, ReaderSettings } from '@/db'
import { db } from '@/db'
import { loadPdfDocument } from '@/lib/pdf'
import { clamp } from '@/lib/util'

const props = defineProps<{
  book: Book
  settings: ReaderSettings
  initial?: ReaderPos | null
}>()

const emit = defineEmits<{
  (
    e: 'state',
    s: { page: number; pages: number; percent: number; label: string; loading: boolean },
  ): void
  (e: 'tap-center'): void
  (e: 'outline', items: { title: string; level: number; index: number }[]): void
}>()

interface PageBox {
  num: number
  ratio: number
  rendered: boolean
  el: HTMLDivElement | null
  rendering: boolean
}

const scrollEl = ref<HTMLDivElement>()
const pageBoxes = ref<PageBox[]>([])
const loading = ref(true)
const error = ref('')
const zoom = ref(1)
const current = ref(0)
const numPages = ref(0)

// PDF 与阅读设置无关，zoom 单独记住
const ZOOM_KEY = 'readawre.pdf.zoom'

let doc: any = null
let observer: IntersectionObserver | null = null
let dpr = Math.min(2, window.devicePixelRatio || 1)
let scrollRaf = 0

function containerWidth(): number {
  const el = scrollEl.value
  if (!el) return 360
  const w = el.clientWidth
  return Math.max(240, w - 24)
}

function pageWidth(): number {
  return Math.round(containerWidth() * zoom.value)
}

function emitState() {
  emit('state', {
    page: current.value,
    pages: numPages.value,
    percent: numPages.value ? (current.value + 1) / numPages.value : 0,
    label: numPages.value ? `第 ${current.value + 1} / ${numPages.value} 页` : '',
    loading: loading.value,
  })
}

function setPageEl(box: PageBox, el: any) {
  box.el = el as HTMLDivElement | null
  if (box.el && observer) observer.observe(box.el)
}

function updateSizes() {
  for (const box of pageBoxes.value) {
    if (!box.el) continue
    const w = pageWidth()
    box.el.style.width = w + 'px'
    box.el.style.height = Math.round(w * box.ratio) + 'px'
  }
}

function clearRendered() {
  for (const box of pageBoxes.value) {
    box.rendered = false
    box.rendering = false
    if (box.el) {
      box.el.innerHTML = ''
      box.el.classList.remove('ready')
    }
  }
}

async function renderPage(box: PageBox) {
  if (!doc || box.rendered || box.rendering) return
  box.rendering = true
  try {
    const page = await doc.getPage(box.num)
    const vp1 = page.getViewport({ scale: 1 })
    const ratio = vp1.height / vp1.width
    const cssW = pageWidth()
    const scale = cssW / vp1.width
    const viewport = page.getViewport({ scale: scale * dpr })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(viewport.width))
    canvas.height = Math.max(1, Math.round(viewport.height))
    canvas.style.width = '100%'
    canvas.style.height = 'auto'
    canvas.style.display = 'block'
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 不可用')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx, viewport }).promise

    const el = box.el
    if (!el) return
    el.innerHTML = ''
    el.appendChild(canvas)
    el.style.height = Math.round(cssW * ratio) + 'px'
    el.classList.add('ready')
    box.ratio = ratio
    box.rendered = true
    page.cleanup?.()
  } catch (e) {
    box.rendered = false
  } finally {
    box.rendering = false
  }
}

function releaseFarPages() {
  for (const box of pageBoxes.value) {
    if (!box.rendered) continue
    if (Math.abs(box.num - 1 - current.value) > 8) {
      box.rendered = false
      if (box.el) {
        box.el.innerHTML = ''
        box.el.classList.remove('ready')
      }
    }
  }
}

function onScroll() {
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    const scroller = scrollEl.value
    if (!scroller) return
    const anchor = scroller.scrollTop + scroller.clientHeight * 0.3
    let idx = 0
    for (let i = 0; i < pageBoxes.value.length; i++) {
      const el = pageBoxes.value[i].el
      if (!el) continue
      if (el.offsetTop <= anchor) idx = i
      else break
    }
    if (idx !== current.value) {
      current.value = idx
      emitState()
      releaseFarPages()
    }
  })
}

function goPage(index: number, smooth = false) {
  const box = pageBoxes.value[clamp(index, 0, pageBoxes.value.length - 1)]
  if (!box?.el || !scrollEl.value) return
  scrollEl.value.scrollTo({ top: Math.max(0, box.el.offsetTop - 6), behavior: smooth ? 'smooth' : 'auto' })
  current.value = clamp(index, 0, pageBoxes.value.length - 1)
  emitState()
}

function setZoom(next: number) {
  zoom.value = clamp(Math.round(next * 100) / 100, 0.6, 2.4)
  try {
    localStorage.setItem(ZOOM_KEY, String(zoom.value))
  } catch {
    /* 忽略 */
  }
  const keep = current.value
  clearRendered()
  updateSizes()
  nextTick(() => {
    goPage(keep)
    renderVisible()
  })
}

function zoomIn() {
  setZoom(zoom.value + 0.15)
}
function zoomOut() {
  setZoom(zoom.value - 0.15)
}
function fitWidth() {
  setZoom(1)
}

// ---------- 双指捏合缩放 ----------
// 捏合过程中只改页面盒子的宽高（canvas 由 CSS 拉伸，够快）；松手后再按新比例重绘清晰版。
let pinch: { d0: number; z0: number; cy: number; top: number } | null = null
let justPinched = 0

function touchDist(a: Touch, b: Touch) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

function onTouchStart(e: TouchEvent) {
  const el = scrollEl.value
  if (!el || e.touches.length !== 2) return
  const rect = el.getBoundingClientRect()
  pinch = {
    d0: Math.max(24, touchDist(e.touches[0], e.touches[1])),
    z0: zoom.value,
    cy: (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top,
    top: el.scrollTop,
  }
}

function onTouchMove(e: TouchEvent) {
  const el = scrollEl.value
  if (!pinch || !el || e.touches.length !== 2) return
  e.preventDefault()
  const z = clamp(pinch.z0 * (touchDist(e.touches[0], e.touches[1]) / pinch.d0), 0.6, 2.4)
  if (Math.abs(z - zoom.value) < 0.004) return
  zoom.value = Math.round(z * 100) / 100
  updateSizes()
  // 让捏合中心底下的那一段内容待在原地
  el.scrollTop = Math.max(0, (pinch.top + pinch.cy) * (zoom.value / pinch.z0) - pinch.cy)
}

function onTouchEnd() {
  const wasPinching = pinch !== null
  pinch = null
  if (!wasPinching) return
  justPinched = Date.now()
  try {
    localStorage.setItem(ZOOM_KEY, String(zoom.value))
  } catch {
    /* 忽略 */
  }
  clearRendered()
  updateSizes()
  onScroll()
  renderVisible()
}

function renderVisible() {
  const scroller = scrollEl.value
  if (!scroller) return
  const top = scroller.scrollTop - scroller.clientHeight
  const bottom = scroller.scrollTop + scroller.clientHeight * 2
  for (const box of pageBoxes.value) {
    const el = box.el
    if (!el) continue
    if (el.offsetTop + el.offsetHeight >= top && el.offsetTop <= bottom) void renderPage(box)
  }
}

function onClick(e: MouseEvent) {
  if (Date.now() - justPinched < 450) return
  const el = scrollEl.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const x = (e.clientX - rect.left) / rect.width
  const y = (e.clientY - rect.top) / rect.height
  if (x > 0.3 && x < 0.7 && y > 0.2 && y < 0.8) emit('tap-center')
}

async function loadOutline() {
  try {
    const outline = await doc.getOutline()
    if (!outline?.length) return
    const items: { title: string; level: number; index: number }[] = []
    const walk = async (nodes: any[], level: number) => {
      for (const node of nodes) {
        if (items.length >= 300) return
        try {
          let dest = node.dest
          if (typeof dest === 'string') dest = await doc.getDestination(dest)
          if (Array.isArray(dest) && dest[0]) {
            const pageIndex = await doc.getPageIndex(dest[0])
            items.push({ title: String(node.title || '').trim(), level, index: pageIndex })
          }
        } catch {
          /* 单个目录项解析失败就跳过 */
        }
        if (node.items?.length) await walk(node.items, level + 1)
      }
    }
    await walk(outline, 0)
    if (items.length) emit('outline', items)
  } catch {
    /* 没有目录就算了 */
  }
}

onMounted(async () => {
  try {
    try {
      const saved = Number(localStorage.getItem(ZOOM_KEY))
      if (saved >= 0.6 && saved <= 2.4) zoom.value = saved
    } catch {
      /* 忽略 */
    }

    const row = await db.files.get(props.book.id)
    if (!row) throw new Error('书的数据丢了（IndexedDB 里找不到）')
    doc = await loadPdfDocument(row.data)
    numPages.value = doc.numPages

    // 先用 A4 比例占位，渲染时再校正真实尺寸
    pageBoxes.value = Array.from({ length: numPages.value }, (_, i) => ({
      num: i + 1,
      ratio: 1.414,
      rendered: false,
      rendering: false,
      el: null,
    }))
    loading.value = false
    emitState()
    await nextTick()

    if (scrollEl.value) {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue
            const idx = Number((entry.target as HTMLElement).dataset.idx)
            const box = pageBoxes.value[idx]
            if (box) void renderPage(box)
          }
        },
        { root: scrollEl.value, rootMargin: '200% 0px' },
      )
      for (const box of pageBoxes.value) if (box.el) observer.observe(box.el)
      scrollEl.value.addEventListener('scroll', onScroll, { passive: true })
    }

    await loadOutline()

    const start = props.initial?.page ?? 0
    goPage(clamp(start, 0, numPages.value - 1))
    renderVisible()
  } catch (e: any) {
    error.value = e?.message || String(e)
    loading.value = false
    emitState()
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  scrollEl.value?.removeEventListener('scroll', onScroll)
  if (scrollRaf) cancelAnimationFrame(scrollRaf)
  doc?.destroy?.()
  doc = null
})

defineExpose({ goPage, zoomIn, zoomOut, fitWidth })
</script>

<template>
  <div class="pdf-reader">
    <div
      ref="scrollEl"
      class="pdf-scroll"
      @click="onClick"
      @touchstart="onTouchStart"
      @touchmove="onTouchMove"
      @touchend="onTouchEnd"
      @touchcancel="onTouchEnd"
    >
      <div class="pdf-pages" :style="{ width: pageWidth() + 'px' }">
        <div
          v-for="(box, i) in pageBoxes"
          :key="box.num"
          :ref="(el) => setPageEl(box, el)"
          :data-idx="i"
          class="pdf-page"
          :style="{ width: pageWidth() + 'px', height: Math.round(pageWidth() * box.ratio) + 'px' }"
        >
          <span class="pdf-page-no">{{ box.num }}</span>
        </div>
      </div>
      <div v-if="loading" class="pdf-mask">
        <span class="spinner" />
        <p>正在打开 PDF…</p>
      </div>
      <div v-else-if="error" class="pdf-mask err">
        <p>打不开这个 PDF</p>
        <span>{{ error }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pdf-reader {
  position: absolute;
  inset: 0;
  background: var(--r-bg-2);
}
.pdf-scroll {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  touch-action: pan-y;
  padding: calc(44px + var(--safe-top)) 12px calc(30px + var(--safe-bottom));
  display: block;
}
.pdf-pages {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  /* 用 margin auto 居中：放大到比屏幕宽时还能横向滚动到左边缘（flex 居中会把左侧裁掉） */
  margin: 0 auto;
}
.pdf-page {
  position: relative;
  background: #fff;
  border-radius: 4px;
  box-shadow: 0 2px 12px rgba(40, 32, 20, 0.16);
  overflow: hidden;
  flex: 0 0 auto;
}
.pdf-page:not(.ready)::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(100deg, #f6f2ea 30%, #ece6da 50%, #f6f2ea 70%);
  background-size: 200% 100%;
  animation: shimmer 1.2s linear infinite;
}
.pdf-page.ready::after {
  content: none;
}
.pdf-page-no {
  position: absolute;
  right: 8px;
  bottom: 6px;
  font-size: 11px;
  color: #b0a892;
  z-index: 1;
}
@keyframes shimmer {
  from {
    background-position: 120% 0;
  }
  to {
    background-position: -80% 0;
  }
}
.pdf-mask {
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
  z-index: 5;
}
.pdf-mask.err {
  color: var(--r-ink-2);
}
.pdf-mask.err p {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--r-ink);
}
.pdf-mask.err span {
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
