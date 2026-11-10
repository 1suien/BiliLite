<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { db, type Book, type ReaderPos } from '@/db'
import { openCbz, type CbzBook } from '@/lib/cbz'

const props = defineProps<{
  book: Book
  initial?: ReaderPos | null
}>()

const emit = defineEmits<{
  (e: 'state', s: { page: number; pages: number; percent: number; loading: boolean }): void
  (e: 'tap-center'): void
  (e: 'toast', msg: string): void
}>()

const page = ref(0)
const pageCount = ref(props.book.pageCount || 0)
const url = ref('')
const loading = ref(true)
const error = ref('')
const zoomed = ref(false)
let cbz: CbzBook | null = null
let token = 0

function emitState() {
  emit('state', {
    page: page.value,
    pages: Math.max(1, pageCount.value),
    percent: pageCount.value ? (page.value + 1) / pageCount.value : 0,
    loading: loading.value,
  })
}

async function show(i: number, animate = false) {
  if (!cbz) return
  const next = Math.max(0, Math.min(pageCount.value - 1, i))
  const t = ++token
  page.value = next
  try {
    const u = await cbz.pageUrl(next)
    if (t !== token) return
    url.value = u
    loading.value = false
    error.value = ''
    emitState()
    // 预取下一页，翻页时不闪白
    if (next + 1 < pageCount.value) void cbz.pageUrl(next + 1).catch(() => undefined)
  } catch (e: any) {
    if (t !== token) return
    error.value = e?.message || String(e)
    loading.value = false
    emitState()
  }
  void animate
}

function next() {
  if (page.value >= pageCount.value - 1) {
    emit('toast', '已经是最后一页了')
    return
  }
  void show(page.value + 1, true)
}
function prev() {
  if (page.value <= 0) {
    emit('toast', '已经是第一页了')
    return
  }
  void show(page.value - 1, true)
}
function goPage(i: number) {
  void show(i, true)
}

let sx = 0
let sy = 0
let st = 0
function onTouchStart(e: TouchEvent) {
  if (e.touches.length !== 1) return
  sx = e.touches[0].clientX
  sy = e.touches[0].clientY
  st = Date.now()
}
function onTouchEnd(e: TouchEvent) {
  const t = e.changedTouches[0]
  if (!t) return
  const dx = t.clientX - sx
  const dy = t.clientY - sy
  if (Date.now() - st > 700) return
  if (Math.abs(dx) > 46 && Math.abs(dx) > Math.abs(dy) * 1.2) {
    if (dx < 0) next()
    else prev()
    return
  }
  if (Math.abs(dx) > 10 || Math.abs(dy) > 10) return
  const w = window.innerWidth
  if (t.clientX < w * 0.3) prev()
  else if (t.clientX > w * 0.7) next()
  else emit('tap-center')
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
    e.preventDefault()
    next()
  } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
    e.preventDefault()
    prev()
  }
}

onMounted(async () => {
  try {
    const f = await db.files.get(props.book.id)
    if (!f) throw new Error('漫画文件不在设备上了')
    cbz = await openCbz(f.data)
    pageCount.value = cbz.pageCount
    loading.value = false
    const start = Math.max(0, Math.min(pageCount.value - 1, props.initial?.page || 0))
    await show(start)
  } catch (e: any) {
    error.value = e?.message || String(e)
    loading.value = false
    emitState()
  }
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
})

defineExpose({ next, prev, goPage })
</script>

<template>
  <div
    class="comic"
    @touchstart.passive="onTouchStart"
    @touchend.passive="onTouchEnd"
  >
    <img v-if="url" :src="url" class="page" :class="{ zoom: zoomed }" alt="" @click="zoomed = !zoomed" />
    <div v-if="loading || error" class="mask">
      <template v-if="error">
        <p>打不开这本漫画</p>
        <span>{{ error }}</span>
      </template>
      <span v-else class="spinner" />
    </div>
  </div>
</template>

<style scoped>
.comic {
  position: absolute;
  inset: 0;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--r-bg);
  touch-action: pan-y;
}
.page {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  user-select: none;
  -webkit-user-drag: none;
}
.page.zoom {
  max-width: none;
  max-height: none;
  width: 170%;
  cursor: zoom-out;
}
.mask {
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
.mask p {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--r-ink);
}
.mask span {
  max-width: 80%;
  text-align: center;
  font-size: 12px;
}
.spinner {
  width: 24px;
  height: 24px;
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
