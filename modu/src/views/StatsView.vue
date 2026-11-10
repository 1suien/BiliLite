<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { db, listSessions, type Book, type ReadingSession } from '@/db'
import { dayKey, fmtDuration, summarize } from '@/lib/stats'

const router = useRouter()
const sessions = ref<ReadingSession[]>([])
const books = ref<Book[]>([])
const covers = ref<Record<string, string>>({})
const ready = ref(false)

const summary = computed(() => summarize(sessions.value))
const maxDay = computed(() => Math.max(1, ...summary.value.days.map((d) => d.ms)))

/** 有阅读记录的天数（不只是最近 7 天） */
const dayCount = computed(() => {
  const set = new Set<string>()
  for (const s of sessions.value) if (s.end > s.start) set.add(dayKey(s.start))
  return set.size
})

const totalHours = computed(() => summary.value.totalMs / 3600_000)
const MILESTONES = [1, 5, 10, 25, 50, 100]
const nextMilestone = computed(() => MILESTONES.find((m) => m > totalHours.value) || null)
const milestoneProgress = computed(() => {
  const next = nextMilestone.value
  if (!next) return 1
  const prev = MILESTONES[MILESTONES.indexOf(next) - 1] || 0
  return Math.max(0.02, Math.min(1, (totalHours.value - prev) / (next - prev)))
})

function bookOf(id: string): Book | undefined {
  return books.value.find((b) => b.id === id)
}

function barHeight(ms: number): string {
  if (!ms) return '3px'
  return Math.max(6, Math.round((ms / maxDay.value) * 100)) + '%'
}

function minutes(ms: number): string {
  return Math.max(1, Math.round(ms / 60_000)) + ''
}

async function reset() {
  if (!confirm('清空全部阅读统计？书架上的书和进度不会删。')) return
  await db.sessions.clear()
  sessions.value = []
  // 书的累计时长也归零
  for (const b of books.value) await db.books.update(b.id, { readMs: 0 })
}

onMounted(async () => {
  sessions.value = await listSessions(0)
  books.value = await db.books.toArray()
  const cs = await db.covers.toArray()
  const map: Record<string, string> = {}
  for (const c of cs) if (c.dataUrl) map[c.id] = c.dataUrl
  covers.value = map
  ready.value = true
})
</script>

<template>
  <div class="stats">
    <header class="head">
      <button class="icon" aria-label="返回" @click="router.back()">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
      </button>
      <h1>阅读统计</h1>
      <button class="icon" aria-label="清空" @click="reset">
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />
        </svg>
      </button>
    </header>

    <main class="body">
      <section class="hero">
        <span class="eyebrow">总阅读时长</span>
        <p class="big">{{ summary.totalMs ? fmtDuration(summary.totalMs) : '还没有记录' }}</p>
        <p class="hero-sub">
          <template v-if="summary.streakDays">连续 {{ summary.streakDays }} 天</template>
          <template v-else-if="summary.totalMs">今天读一会儿，重新开始连续</template>
          <template v-else>打开一本书，这里就会开始记录</template>
          <template v-if="summary.totalMs"> · 共 {{ summary.sessions }} 次阅读</template>
        </p>
        <div v-if="nextMilestone" class="milestone">
          <div class="ms-bar"><i :style="{ width: milestoneProgress * 100 + '%' }" /></div>
          <span>下一档 {{ nextMilestone }} 小时</span>
        </div>
      </section>

      <section class="tiles">
        <div class="tile">
          <span>今日</span>
          <strong>{{ summary.todayMs ? fmtDuration(summary.todayMs, 'short') : '0 分' }}</strong>
        </div>
        <div class="tile">
          <span>本周</span>
          <strong>{{ summary.weekMs ? fmtDuration(summary.weekMs, 'short') : '0 分' }}</strong>
        </div>
        <div class="tile">
          <span>已读天数</span>
          <strong>{{ dayCount }} 天</strong>
        </div>
        <div class="tile">
          <span>平均每天</span>
          <strong>{{ dayCount ? fmtDuration(summary.totalMs / dayCount, 'short') : '—' }}</strong>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>最近 7 天</h2>
          <span v-if="summary.bestDayMs">最高 {{ minutes(summary.bestDayMs) }} 分钟</span>
        </div>
        <div class="chart">
          <div v-for="d in summary.days" :key="d.date" class="col">
            <span class="val">{{ d.ms ? minutes(d.ms) : '' }}</span>
            <div class="track">
              <i :class="{ today: d.label === '今天' }" :style="{ height: barHeight(d.ms) }" />
            </div>
            <span class="lab" :class="{ today: d.label === '今天' }">{{ d.label }}</span>
          </div>
        </div>
      </section>

      <section v-if="summary.topBooks.length" class="card">
        <div class="card-head">
          <h2>按书籍</h2>
          <span>{{ summary.topBooks.length }} 本</span>
        </div>
        <div class="book-list">
          <div v-for="t in summary.topBooks" :key="t.bookId" class="brow">
            <div class="bcover">
              <img v-if="covers[t.bookId]" :src="covers[t.bookId]" alt="" />
              <div v-else class="bgen" :style="{ background: `hsl(${bookOf(t.bookId)?.hue ?? 40}, 22%, 30%)` }" />
            </div>
            <div class="binfo">
              <p class="btitle">{{ t.title }}</p>
              <div class="bbar">
                <i :style="{ width: Math.round(bookOf(t.bookId)?.percent ? bookOf(t.bookId)!.percent * 100 : 0) + '%' }" />
              </div>
              <p class="bmeta">{{ fmtDuration(t.ms, 'short') }} · {{ t.sessions }} 次 · 读了 {{ Math.round((bookOf(t.bookId)?.percent || 0) * 100) }}%</p>
            </div>
          </div>
        </div>
      </section>

      <p class="hint">时长按在阅读页实际停留的时间统计，切到别的应用会自动暂停。</p>
    </main>
  </div>
</template>

<style scoped>
.stats {
  position: fixed;
  inset: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  background: var(--shelf-bg);
  color: var(--ink);
}
.head {
  position: sticky;
  top: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: calc(10px + var(--safe-top)) 14px 8px;
  background: color-mix(in srgb, var(--shelf-bg) 88%, transparent);
  -webkit-backdrop-filter: blur(14px);
  backdrop-filter: blur(14px);
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 7%, transparent);
}
.head h1 {
  flex: 1;
  margin: 0;
  text-align: center;
  font-family: var(--font-serif);
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.08em;
}
.icon {
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  color: var(--ink-2);
}
.icon:active {
  background: color-mix(in srgb, var(--ink) 8%, transparent);
}
.body {
  padding: 16px 16px calc(34px + var(--safe-bottom));
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 620px;
  margin: 0 auto;
}
.hero {
  padding: 4px 2px 2px;
}
.eyebrow {
  font-size: 11px;
  letter-spacing: 0.14em;
  color: var(--muted);
}
.hero .big {
  margin: 6px 0 4px;
  font-family: var(--font-serif);
  font-size: 34px;
  font-weight: 600;
  letter-spacing: 0.01em;
  line-height: 1.15;
}
.hero-sub {
  margin: 0;
  font-size: 12.5px;
  color: var(--muted);
}
.milestone {
  margin-top: 14px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.ms-bar {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--ink) 9%, transparent);
  overflow: hidden;
}
.ms-bar i {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
}
.milestone span {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}
.tiles {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1px;
  background: color-mix(in srgb, var(--ink) 8%, transparent);
  border-radius: 14px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--ink) 7%, transparent);
}
.tile {
  background: var(--shelf-bg);
  padding: 13px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.tile span {
  font-size: 11px;
  color: var(--muted);
}
.tile strong {
  font-size: 19px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-serif);
}
.card {
  padding: 14px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid color-mix(in srgb, var(--ink) 6%, transparent);
}
.card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 12px;
}
.card-head h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.06em;
}
.card-head span {
  font-size: 11px;
  color: var(--muted);
}
.chart {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 132px;
}
.col {
  flex: 1;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.val {
  font-size: 9.5px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  height: 12px;
}
.track {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.track i {
  display: block;
  width: min(100%, 22px);
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 22%, transparent);
  transition: height 0.4s cubic-bezier(0.25, 1, 0.5, 1);
}
.track i.today {
  background: var(--accent);
}
.lab {
  font-size: 10px;
  color: var(--muted);
}
.lab.today {
  color: var(--ink);
  font-weight: 600;
}
.book-list {
  display: flex;
  flex-direction: column;
  gap: 13px;
}
.brow {
  display: flex;
  gap: 11px;
  align-items: center;
}
.bcover {
  width: 34px;
  height: 46px;
  flex: 0 0 auto;
  border-radius: 3px;
  overflow: hidden;
  background: var(--surface-2);
  box-shadow: 0 4px 10px -7px rgba(28, 25, 23, 0.6);
}
.bcover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.bgen {
  width: 100%;
  height: 100%;
}
.binfo {
  flex: 1;
  min-width: 0;
}
.btitle {
  margin: 0 0 5px;
  font-family: var(--font-serif);
  font-size: 13.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bbar {
  height: 2.5px;
  border-radius: 2px;
  background: var(--line);
  overflow: hidden;
}
.bbar i {
  display: block;
  height: 100%;
  background: var(--accent);
}
.bmeta {
  margin: 5px 0 0;
  font-size: 10.5px;
  color: var(--muted);
}
.hint {
  margin: 2px 2px 0;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--muted);
  text-align: center;
}
</style>
