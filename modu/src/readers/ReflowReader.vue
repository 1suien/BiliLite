<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type JSZip from 'jszip'
import type { Annotation, Book, HlColor, ReaderPos, ReaderSettings, TxtChapter } from '@/db'
import { db, listAnnotationsForChapter, removeAnnotation, saveAnnotation } from '@/db'
import { decodeText, parseTxtChapters, textToHtml } from '@/lib/encoding'
import { loadEpubZip, readEpubChapter } from '@/lib/epub'
import { clamp, uid } from '@/lib/util'

const props = defineProps<{
  book: Book
  settings: ReaderSettings
  initial?: ReaderPos | null
}>()

export interface ReaderState {
  chapterTitle: string
  page: number
  pages: number
  /** 全书进度 0–1 */
  percent: number
  chapter: number
  chapters: number
  loading: boolean
  /** 逐句模式：当前句序号与总句数 */
  sentenceIndex: number
  sentences: number
  /** 本章总字数、剩余阅读时间估算（分钟） */
  chapterChars: number
  remainMin: number
}

const emit = defineEmits<{
  (e: 'state', s: ReaderState): void
  (e: 'tap-center'): void
  (
    e: 'selection',
    v: { start: number; end: number; quote: string; top: number; bottom: number; left: number; right: number } | null,
  ): void
  (e: 'mark-tap', v: { id: string; top: number; bottom: number; left: number }): void
  (e: 'annotations-changed'): void
  (e: 'toast', msg: string): void
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
const chapterChars = ref(0)
let loadToken = 0
let flipToken = 0

// ---------- 逐句 / 批注 ----------
interface Sentence {
  /** 一句可能跨多个内联节点（<em>、<a> 等），所以是一组 span */
  els: HTMLElement[]
  text: string
}
const sentences = shallowRef<Sentence[]>([])
const curSent = ref(-1)
const anns = shallowRef<Annotation[]>([])
/** 每句所在的页，延迟计算并随重排失效 */
let sentPages: number[] | null = null

const SENT_BLOCK_SEL = 'p, li, td, th'

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

// ---------- 排版（沿用 0.1.0 的 CSS 多列 + 横向位移翻页） ----------
function applyTypography() {
  const flow = flowEl.value
  if (!flow) return
  const m = margin()
  flow.style.fontSize = props.settings.fontSize + 'px'
  flow.style.lineHeight = String(props.settings.lineHeight)
  flow.style.fontFamily =
    props.settings.fontFamily === 'serif'
      ? "'EB Garamond', 'Noto Serif CJK SC', 'Source Han Serif SC', 'Songti SC', SimSun, Georgia, serif"
      : "'Noto Sans CJK SC', 'Source Han Sans SC', 'PingFang SC', system-ui, sans-serif"
  flow.style.paddingLeft = m + 'px'
  flow.style.paddingRight = m + 'px'
  flow.style.columnGap = m * 2 + 'px'
  flow.style.letterSpacing = (props.settings.letterSpacing || 0) + 'em'
  flow.style.textAlign = props.settings.align === 'left' ? 'left' : 'justify'
  flow.style.setProperty('--p-space', (props.settings.paraSpacing ?? 0.9) + 'em')
  flow.classList.toggle('no-indent', !props.settings.indent)
  setColumnWidth()
}

/** 列宽 = 可视宽 − 2×边距，列间距 = 2×边距 → 每页水平步长正好等于可视宽 */
function setColumnWidth() {
  const flow = flowEl.value
  if (!flow) return
  const W = pageWidth()
  flow.style.columnWidth = Math.max(60, W - margin() * 2) + 'px'
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
    const x = mark.offsetLeft
    n = Math.floor(Math.max(0, x - m) / W + 1e-4) + 1
  } else {
    n = Math.round((flow.scrollWidth + m) / W)
  }
  return Math.max(1, n)
}

let fadeSeq = 0
let dragging = false
let dragDx = 0
let dragAxis: 'x' | 'y' | null = null

function applyTransform(animate: boolean) {
  const flow = flowEl.value
  if (!flow) return
  const W = pageWidth()
  const tx = `translateX(${-page.value * W}px)`
  const seq = ++flipToken

  const anim = props.settings.pageAnim
  if (!animate || anim === 'none') {
    flow.style.transition = 'none'
    flow.style.opacity = '1'
    flow.style.transform = tx
    flow.style.filter = 'none'
    return
  }

  if (anim === 'slide') {
    flow.style.transition = 'transform 0.22s cubic-bezier(0.24, 0.7, 0.3, 1)'
    flow.style.opacity = '1'
    flow.style.transform = tx
    return
  }

  if (anim === 'cover') {
    // 像掀一页纸：轻微降亮 + 投影，再在新页上恢复，做出翻页的“厚度”
    const before = flow.style.transform
    flow.style.transition = 'transform 0.24s cubic-bezier(0.22, 0.68, 0.2, 1), filter 0.24s ease'
    flow.style.filter = 'brightness(0.93)'
    flow.style.transform = before || tx
    window.setTimeout(() => {
      flow.style.transform = tx
      flow.style.filter = 'brightness(1)'
    }, 16)
    return
  }

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

// ---------- 文本工具：按字符偏移包裹节点 ----------
function collectTextNodes(root: HTMLElement): { nodes: Text[]; starts: number[] } {
  const nodes: Text[] = []
  const starts: number[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let pos = 0
  let n: Node | null
  while ((n = walker.nextNode())) {
    const t = n as Text
    nodes.push(t)
    starts.push(pos)
    pos += t.data.length
  }
  return { nodes, starts }
}

/**
 * 把 root 内 [start, end) 的文本用 make() 生成的元素包起来（跨节点时每段包一个）。
 * 从后往前处理，避免偏移被 splitText 打乱。返回生成的包裹元素。
 */
function wrapRange(root: HTMLElement, start: number, end: number, make: () => HTMLElement): HTMLElement[] {
  const { nodes, starts } = collectTextNodes(root)
  const made: HTMLElement[] = []
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]
    const ns = starts[i]
    const len = node.data.length
    if (!len) continue
    const a = Math.max(0, start - ns)
    const b = Math.min(len, end - ns)
    if (b <= a) continue
    const wrap = make()
    let target: Text = node
    if (a > 0) target = target.splitText(a)
    if (b - a < target.data.length) target.splitText(b - a)
    target.parentNode?.insertBefore(wrap, target)
    wrap.appendChild(target)
    made.push(wrap)
  }
  return made
}

/** 当前文本在整章里的字符偏移（用于批注锚定） */
function offsetOf(node: Node, off: number): number {
  const flow = flowEl.value
  if (!flow) return 0
  const r = document.createRange()
  r.setStart(flow, 0)
  try {
    r.setEnd(node, off)
  } catch {
    return 0
  }
  return r.toString().length
}

// ---------- 断句 ----------
function splitSentences(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const Seg = (Intl as any).Segmenter
  if (typeof Seg === 'function') {
    const seg = new Seg(undefined, { granularity: 'sentence' })
    for (const s of seg.segment(text)) {
      const a = s.index as number
      const b = a + (s.segment as string).length
      if ((s.segment as string).trim()) out.push([a, b])
    }
    return out
  }
  // 兜底：中英文句末标点切分
  const re = /[^。！？!?…\n]+[。！？!?…]+[”’"'」』）)]*|[^。！？!?…\n]+$/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m[0].trim()) out.push([m.index, m.index + m[0].length])
  }
  return out
}

function wrapSentences(flow: HTMLElement): Sentence[] {
  const out: Sentence[] = []
  const blocks = Array.from(flow.querySelectorAll<HTMLElement>(SENT_BLOCK_SEL))
  let seq = 0
  for (const block of blocks) {
    if (block.closest('.ch-title')) continue
    // li > p 这类嵌套只处理最内层，避免重复切句
    if (block.querySelector('p, li')) continue
    const text = block.textContent || ''
    if (text.trim().length < 2) continue
    for (const [a, b] of splitSentences(text)) {
      const els = wrapRange(block, a, b, () => {
        const span = document.createElement('span')
        span.className = 'sent'
        span.setAttribute('data-si', String(seq))
        return span
      })
      if (!els.length) continue
      out.push({ els, text: text.slice(a, b).trim() })
      seq++
    }
  }
  out.sort((x, y) => {
    const a = x.els[0]
    const b = y.els[0]
    if (!a || !b || a === b) return 0
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  })
  out.forEach((s, i) => s.els.forEach((el) => el.setAttribute('data-si', String(i))))
  return out
}

// ---------- 逐句渲染 ----------
function paintSentences() {
  const flow = flowEl.value
  if (!flow) return
  flow.querySelectorAll<HTMLElement>('.sent.is-current').forEach((el) => el.classList.remove('is-current'))
  const active = !!props.settings.focusMode
  flow.classList.toggle('is-focus', active)
  if (!active) return
  const s = sentences.value[curSent.value]
  if (s) for (const el of s.els) el.classList.add('is-current')
}

/** 元素在整章排版坐标里的水平位置 → 页号 */
function pageOfEl(el: HTMLElement): number {
  const flow = flowEl.value
  if (!flow) return 0
  const W = pageWidth()
  const m = margin()
  let x = 0
  let n: HTMLElement | null = el
  while (n && n !== flow) {
    x += n.offsetLeft
    n = n.offsetParent as HTMLElement | null
  }
  return clamp(Math.floor((x - m) / W + 1e-4), 0, Math.max(0, pages.value - 1))
}

function ensureSentPages() {
  if (sentPages && sentPages.length === sentences.value.length) return
  sentPages = sentences.value.map((s) => (s.els[0] ? pageOfEl(s.els[0]) : 0))
}

function firstSentenceOnPage(p: number): number {
  const list = sentences.value
  if (!list.length) return -1
  ensureSentPages()
  const sp = sentPages!
  for (let i = 0; i < sp.length; i++) if (sp[i] >= p) return i
  return sp.length - 1
}

function focusSentence(idx: number, turn = true) {
  const list = sentences.value
  if (!list.length) return
  const i = clamp(idx, 0, list.length - 1)
  curSent.value = i
  paintSentences()
  if (turn) {
    ensureSentPages()
    const p = sentPages![i] ?? page.value
    if (p !== page.value) {
      page.value = clamp(p, 0, pages.value - 1)
      applyTransform(false)
    }
  }
  emitState()
}

function syncSentenceToPage() {
  if (!props.settings.focusMode) return
  if (!sentences.value.length) return
  ensureSentPages()
  const i = firstSentenceOnPage(page.value)
  if (i >= 0) {
    curSent.value = i
    paintSentences()
  }
}

function goSentence(delta: number) {
  if (loading.value) return
  const list = sentences.value
  if (!list.length) {
    void (delta > 0 ? next() : prev())
    return
  }
  ensureSentPages()
  let i = curSent.value
  if (i < 0) i = firstSentenceOnPage(page.value)
  const target = i + delta
  if (target >= 0 && target < list.length) {
    focusSentence(target)
    return
  }
  if (target >= list.length) {
    if (chapter.value < chaptersCount() - 1) {
      void openChapter(chapter.value + 1, 0, true)
      emit('toast', '下一章')
    } else {
      emit('toast', '读到全书末尾了')
    }
  } else {
    if (chapter.value > 0) {
      void openChapter(chapter.value - 1, -1, true)
      emit('toast', '上一章')
    } else {
      emit('toast', '已经是开头了')
    }
  }
}

function nextSentence() {
  goSentence(1)
}

function prevSentence() {
  goSentence(-1)
}

// ---------- 批注渲染 ----------
function markEl(a: Annotation): HTMLElement {
  const m = document.createElement('mark')
  m.className = `hl hl-${a.color}${a.note ? ' has-note' : ''}`
  m.setAttribute('data-aid', a.id)
  return m
}

function paintAnnotation(a: Annotation) {
  const flow = flowEl.value
  if (!flow) return
  wrapRange(flow, a.start, a.end, () => markEl(a))
}

function unwrapMark(m: HTMLElement) {
  const parent = m.parentNode
  if (!parent) return
  while (m.firstChild) parent.insertBefore(m.firstChild, m)
  parent.removeChild(m)
  const p = parent as HTMLElement
  if (p.normalize) p.normalize()
}

function unpaintAid(aid: string) {
  const flow = flowEl.value
  if (!flow) return
  flow.querySelectorAll<HTMLElement>(`mark[data-aid="${aid}"]`).forEach(unwrapMark)
}

function unpaintAll() {
  const flow = flowEl.value
  if (!flow) return
  flow.querySelectorAll<HTMLElement>('mark[data-aid]').forEach(unwrapMark)
}

async function loadAnnotations() {
  anns.value = await listAnnotationsForChapter(props.book.id, chapter.value)
}

function paintAllAnnotations() {
  for (const a of anns.value) paintAnnotation(a)
}

async function refreshAnnotations() {
  unpaintAll()
  await loadAnnotations()
  paintAllAnnotations()
}

async function createHighlight(p: {
  start: number
  end: number
  quote: string
  color: HlColor
  note?: string
}): Promise<Annotation | null> {
  if (p.end <= p.start) return null
  const now = Date.now()
  const a: Annotation = {
    id: uid(),
    bookId: props.book.id,
    chapter: chapter.value,
    chapterTitle: chapterTitle.value,
    start: p.start,
    end: p.end,
    quote: p.quote.slice(0, 500),
    color: p.color,
    note: (p.note || '').trim(),
    createdAt: now,
    updatedAt: now,
  }
  await saveAnnotation(a)
  anns.value = [...anns.value, a]
  paintAnnotation(a)
  emit('annotations-changed')
  return a
}

async function updateAnnotation(a: Annotation) {
  a.updatedAt = Date.now()
  await saveAnnotation(a)
  anns.value = anns.value.map((x) => (x.id === a.id ? a : x))
  unpaintAid(a.id)
  paintAnnotation(a)
  emit('annotations-changed')
}

async function deleteAnnotation(id: string) {
  await removeAnnotation(id)
  anns.value = anns.value.filter((x) => x.id !== id)
  unpaintAid(id)
  emit('annotations-changed')
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
  const frac = pages.value > 1 ? page.value / (pages.value - 1) : 1
  const remainMin = Math.max(0, Math.round(((1 - frac) * chapterChars.value) / 380))
  emit('state', {
    chapterTitle: chapterTitle.value,
    page: page.value,
    pages: pages.value,
    percent: clamp(percent, 0, 1),
    chapter: chapter.value,
    chapters: total,
    loading: loading.value,
    sentenceIndex: curSent.value,
    sentences: sentences.value.length,
    chapterChars: chapterChars.value,
    remainMin,
  })
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

function decorate(flow: HTMLElement) {
  // 首段首字下沉：仅当开头是拉丁字母时启用（中文下沉观感差）
  const firstP = flow.querySelector<HTMLElement>('p')
  if (!firstP) return
  const t = (firstP.textContent || '').trimStart()
  if (/^[A-Za-z“"'(]/.test(t)) firstP.classList.add('dropcap')
}

async function openChapter(idx: number, targetPage = 0, startAtSentence = false) {
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
  emit('selection', null)

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
  flow.classList.remove('is-focus')
  applyTypography()
  decorate(flow)

  // 先断句（包 span），再叠加批注 —— 两者都只改 DOM 结构，不改文本内容
  sentences.value = wrapSentences(flow)
  curSent.value = -1
  sentPages = null
  chapterChars.value = (flow.textContent || '').length

  try {
    await loadAnnotations()
    paintAllAnnotations()
  } catch (e) {
    console.warn('批注加载失败', e)
  }

  paintSentences()
  placeEndMark()
  await waitImages(flow)
  await nextTick()
  if (token !== loadToken) return

  pages.value = computePages()
  page.value = targetPage < 0 ? pages.value - 1 : clamp(targetPage, 0, pages.value - 1)
  applyTransform(false)
  loading.value = false

  if (props.settings.focusMode && sentences.value.length) {
    ensureSentPages()
    curSent.value = firstSentenceOnPage(page.value)
    paintSentences()
  } else if (startAtSentence && sentences.value.length) {
    curSent.value = 0
    paintSentences()
  }
  emitState()
}

// ---------- 翻页 ----------
function turnTo(n: number, animate = true) {
  const max = pages.value - 1
  const target = clamp(n, 0, max)
  if (target === page.value && animate) return
  page.value = target
  applyTransform(animate)
  syncSentenceToPage()
  emitState()
}

export interface FlipResult {
  atStart: boolean
  atEnd: boolean
}

async function next(): Promise<FlipResult> {
  if (loading.value) return { atStart: false, atEnd: false }
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

async function prev(): Promise<FlipResult> {
  if (loading.value) return { atStart: false, atEnd: false }
  if (page.value > 0) {
    turnTo(page.value - 1)
    return { atStart: false, atEnd: false }
  }
  if (chapter.value > 0) {
    await openChapter(chapter.value - 1, -1)
    return { atStart: true, atEnd: false }
  }
  return { atStart: true, atEnd: false }
}

async function goChapter(idx: number) {
  await openChapter(idx, 0)
}

function jumpToPercent(p: number) {
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
  sentPages = null
  if (props.settings.focusMode) syncSentenceToPage()
  emitState()
}

// ---------- 选中文字 → 浮动操作条 ----------
let selTimer = 0
let lastSelKey = ''

function clearBubble() {
  lastSelKey = ''
  emit('selection', null)
}

function checkSelection() {
  const flow = flowEl.value
  const view = viewEl.value
  if (!flow || !view) return
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    if (lastSelKey) clearBubble()
    return
  }
  const range = sel.getRangeAt(0)
  if (!flow.contains(range.startContainer) || !flow.contains(range.endContainer)) {
    if (lastSelKey) clearBubble()
    return
  }
  const quote = sel.toString().replace(/\s+/g, ' ').trim()
  if (!quote) {
    if (lastSelKey) clearBubble()
    return
  }
  const start = offsetOf(range.startContainer, range.startOffset)
  const end = offsetOf(range.endContainer, range.endOffset)
  if (end - start < 1) return
  const key = `${start}:${end}`
  if (key === lastSelKey) return
  lastSelKey = key
  const rect = range.getBoundingClientRect()
  emit('selection', {
    start,
    end: Math.min(start + 500, end),
    quote: quote.slice(0, 500),
    top: rect.top,
    bottom: rect.bottom,
    left: rect.left,
    right: rect.right,
  })
}

function onSelectionChange() {
  window.clearTimeout(selTimer)
  selTimer = window.setTimeout(checkSelection, 140)
}

function clearSelection() {
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed) sel.removeAllRanges()
  clearBubble()
}

// ---------- 手势 ----------
let touchStartX = 0
let touchStartY = 0
let touchStartT = 0
let swiped = false

function onTouchStart(e: TouchEvent) {
  if (e.touches.length !== 1) {
    touchStartT = 0
    dragging = false
    return
  }
  const t = e.touches[0]
  touchStartX = t.clientX
  touchStartY = t.clientY
  touchStartT = Date.now()
  swiped = false
  dragging = false
  dragDx = 0
  dragAxis = null
}

/** 跟手翻页：按住左右拖动时页面跟着手指走，松手再决定翻页还是弹回 */
function onTouchMove(e: TouchEvent) {
  if (!touchStartT || e.touches.length !== 1) return
  const t = e.touches[0]
  const dx = t.clientX - touchStartX
  const dy = t.clientY - touchStartY
  if (!dragAxis) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
    dragAxis = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y'
  }
  if (dragAxis !== 'x') return
  if (props.settings.pageAnim !== 'slide') return
  if (window.getSelection()?.toString()) return
  const flow = flowEl.value
  if (!flow) return
  const W = pageWidth()
  let d = dx
  // 到首尾页时给一点阻尼，拖不动太多
  if ((page.value === 0 && dx > 0) || (page.value >= pages.value - 1 && dx < 0)) d = dx * 0.22
  dragging = true
  dragDx = d
  flow.style.transition = 'none'
  flow.style.transform = `translateX(${-page.value * W + d}px)`
}

function onTouchEnd(e: TouchEvent) {
  if (!touchStartT) return
  const t = e.changedTouches[0]
  const dx = t.clientX - touchStartX
  const dy = t.clientY - touchStartY
  const dt = Date.now() - touchStartT
  touchStartT = 0
  dragAxis = null
  if (dragging) {
    dragging = false
    const W = pageWidth()
    const d = dragDx
    if (Math.abs(d) > Math.min(120, W * 0.2) || (Math.abs(d) > 34 && dt < 260)) {
      swiped = true
      if (d < 0) void next()
      else void prev()
    } else {
      swiped = true
      applyTransform(true)
    }
    return
  }
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
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed) return
  const view = viewEl.value
  if (!view) return
  const target = e.target as HTMLElement

  // 点批注 → 交给父组件弹出操作
  const mark = target.closest?.('mark[data-aid]') as HTMLElement | null
  if (mark) {
    const id = mark.getAttribute('data-aid') || ''
    const r = mark.getBoundingClientRect()
    // 阻止冒泡：父级 stage 的 click 会立刻把操作浮条清掉
    e.stopPropagation()
    emit('mark-tap', { id, top: r.top, bottom: r.bottom, left: r.left + r.width / 2 })
    return
  }

  const rect = view.getBoundingClientRect()
  const x = (e.clientX - rect.left) / rect.width
  if (props.settings.focusMode) {
    if (x < 0.26) {
      prevSentence()
      return
    }
    if (x > 0.74) {
      nextSentence()
      return
    }
    const sent = target.closest?.('.sent') as HTMLElement | null
    if (sent) {
      const si = Number(sent.getAttribute('data-si'))
      if (Number.isFinite(si) && si >= 0) {
        focusSentence(si, false)
        return
      }
    }
    emit('tap-center')
    return
  }
  if (x < 0.28) void prev()
  else if (x > 0.72) void next()
  else emit('tap-center')
}

function onKey(e: KeyboardEvent) {
  const focus = props.settings.focusMode
  if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
    e.preventDefault()
    if (focus) nextSentence()
    else void next()
  } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
    e.preventDefault()
    if (focus) prevSentence()
    else void prev()
  } else if (e.key === 'Escape') {
    emit('tap-center')
  }
}

function onWheel(e: WheelEvent) {
  if (Math.abs(e.deltaY) < 12) return
  if (props.settings.focusMode) {
    if (e.deltaY > 0) nextSentence()
    else prevSentence()
    return
  }
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
  await openChapter(pos?.chapter ?? 0, pos?.page ?? 0)

  ro = new ResizeObserver(() => relayout(true))
  if (viewEl.value) ro.observe(viewEl.value)
  window.addEventListener('keydown', onKey)
  viewEl.value?.addEventListener('wheel', onWheel, { passive: true })
  document.addEventListener('selectionchange', onSelectionChange)
})

onBeforeUnmount(() => {
  loadToken++
  releaseBlobs()
  zip = null
  zipLoading = null
  ro?.disconnect()
  window.removeEventListener('keydown', onKey)
  viewEl.value?.removeEventListener('wheel', onWheel)
  document.removeEventListener('selectionchange', onSelectionChange)
  window.clearTimeout(selTimer)
})

watch(
  () => props.settings,
  () => {
    if (loading.value) return
    applyTypography()
    paintSentences()
    nextTick(() => relayout(true))
  },
  { deep: true },
)

// ---------- 给父组件用的读取接口 ----------
function getContextText(limit = 1800): { title: string; excerpt: string; sentence: string } {
  const flow = flowEl.value
  const chapterText = flow ? flow.textContent || '' : ''
  const list = sentences.value
  const cur = curSent.value
  let excerpt = chapterText.slice(0, limit)
  if (cur >= 0 && list.length) {
    const around = list.slice(Math.max(0, cur - 8), Math.min(list.length, cur + 9))
    excerpt = around.map((s) => s.text).join('')
    if (excerpt.length > limit) excerpt = excerpt.slice(0, limit)
  }
  return {
    title: chapterTitle.value,
    excerpt,
    sentence: list[cur]?.text || '',
  }
}

function currentSentence(): string {
  return sentences.value[curSent.value]?.text || ''
}

/** 从笔记列表点进来：切到那一章并翻到划线所在的页，闪一下让它自己现形 */
async function focusAnnotation(id: string) {
  const a = await db.annotations.get(id)
  if (!a) return
  if (a.chapter !== chapter.value) await openChapter(a.chapter, 0)
  await nextTick()
  await nextTick()
  const mark = flowEl.value?.querySelector<HTMLElement>(`mark[data-aid="${id}"]`)
  if (!mark) return
  page.value = clamp(pageOfEl(mark), 0, Math.max(0, pages.value - 1))
  applyTransform(false)
  mark.classList.add('flash')
  window.setTimeout(() => mark.classList.remove('flash'), 1200)
}

defineExpose({
  focusAnnotation,
  next,
  prev,
  goChapter,
  jumpToPercent,
  nextSentence,
  prevSentence,
  focusSentence,
  getContextText,
  currentSentence,
  createHighlight,
  updateAnnotation,
  deleteAnnotation,
  refreshAnnotations,
  clearSelection,
})
</script>

<template>
  <div class="reflow">
    <div
      ref="viewEl"
      class="reflow-view"
      @click="onClick"
      @touchstart.passive="onTouchStart"
      @touchmove.passive="onTouchMove"
      @touchend.passive="onTouchEnd"
    >
      <div class="reflow-window">
        <div ref="flowEl" class="reflow-flow" />
      </div>
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
.reflow-window {
  width: 100%;
  max-width: 760px;
  height: 100%;
  margin: 0 auto;
  overflow: hidden;
}
.reflow-flow {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  /* 顶部/底部给浮层留白，正文不被工具条遮挡 */
  padding-top: calc(58px + var(--safe-top));
  padding-bottom: calc(92px + var(--safe-bottom));
  column-fill: auto;
  text-align: justify;
  -webkit-hyphens: auto;
  hyphens: auto;
  font-kerning: normal;
  text-rendering: optimizeLegibility;
  transform: translateX(0);
  will-change: transform;
  color: var(--r-ink);
  outline: none;
  user-select: text;
  -webkit-user-select: text;
  -webkit-touch-callout: default;
}
.reflow-flow :deep(p) {
  margin: 0 0 var(--p-space, 0.9em);
  text-indent: 2em;
  text-align: inherit;
  word-break: break-word;
  line-break: strict;
  hanging-punctuation: allow-end;
}
.reflow-flow.no-indent :deep(p) {
  text-indent: 0;
}
.reflow-flow :deep(em),
.reflow-flow :deep(i) {
  font-style: italic;
}
.reflow-flow :deep(.ch-title) {
  margin: 0.1em 0 1.35em;
  font-size: 1.5em;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-align: center;
  text-indent: 0;
  line-height: 1.5;
  break-after: avoid;
}
.reflow-flow :deep(.ch-title::after) {
  content: '';
  display: block;
  width: 30px;
  height: 1px;
  margin: 14px auto 0;
  background: var(--r-line-strong);
}
.reflow-flow :deep(h1),
.reflow-flow :deep(h2),
.reflow-flow :deep(h3) {
  margin: 1.05em 0 0.75em;
  font-size: 1.22em;
  font-weight: 600;
  text-indent: 0;
  text-align: center;
  letter-spacing: 0.05em;
  line-height: 1.5;
  break-after: avoid;
}
.reflow-flow :deep(h1):first-child,
.reflow-flow :deep(h2):first-child,
.reflow-flow :deep(h3):first-child {
  margin-top: 0.25em;
}
.reflow-flow :deep(h4),
.reflow-flow :deep(h5),
.reflow-flow :deep(h6) {
  margin: 0.7em 0 0.55em;
  font-size: 1.06em;
  font-weight: 600;
  text-indent: 0;
  line-height: 1.5;
  break-after: avoid;
}
.reflow-flow :deep(img) {
  max-height: 82vh;
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

/* ---------- 首字下沉 ---------- */
.reflow-flow :deep(p.dropcap)::first-letter {
  float: left;
  font-size: 3.1em;
  line-height: 0.86;
  padding: 0.06em 0.1em 0 0;
  font-weight: 500;
  color: var(--r-ink);
}

/* ---------- 逐句聚焦 ---------- */
.sent {
  transition: opacity 0.18s ease, background-color 0.18s ease;
  border-radius: 4px;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}
.reflow-flow.is-focus :deep(.sent) {
  opacity: 0.3;
}
.reflow-flow.is-focus :deep(.sent.is-current) {
  opacity: 1;
  background: var(--r-sent);
}
.reflow-flow.is-focus :deep(p),
.reflow-flow.is-focus :deep(li) {
  transition: opacity 0.18s ease;
}

/* ---------- 批注 ---------- */
.reflow-flow :deep(mark.hl) {
  background: transparent;
  color: inherit;
  padding: 0;
  border-radius: 3px;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
  cursor: pointer;
}
.reflow-flow :deep(mark.hl-yellow) {
  background: var(--hl-yellow);
}
.reflow-flow :deep(mark.hl-green) {
  background: var(--hl-green);
}
.reflow-flow :deep(mark.hl-blue) {
  background: var(--hl-blue);
}
.reflow-flow :deep(mark.hl-pink) {
  background: var(--hl-pink);
}
.reflow-flow :deep(mark.hl.has-note) {
  box-shadow: inset 0 -0.55em 0 var(--hl-note);
}
.reflow-flow :deep(mark.hl.flash) {
  animation: mark-flash 0.42s ease-in-out 3;
}
@keyframes mark-flash {
  50% {
    box-shadow: 0 0 0 3px var(--r-ink-2);
  }
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
