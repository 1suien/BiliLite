import type { ReadingSession } from '@/db'

/** 一天的阅读汇总 */
export interface DayStat {
  /** 本地日期键，如 2026-11-10 */
  date: string
  /** 图表上的短标签：「今天」「昨天」或「周几」 */
  label: string
  ms: number
}

export interface BookStat {
  bookId: string
  title: string
  ms: number
  sessions: number
}

export interface StatsSummary {
  todayMs: number
  weekMs: number
  totalMs: number
  sessions: number
  /** 连续阅读天数（以今天或昨天结束的一段连续记录计算） */
  streakDays: number
  /** 最近 7 天，从旧到新 */
  days: DayStat[]
  topBooks: BookStat[]
  /** 最近 7 天里读得最多的一天 */
  bestDayMs: number
}

const DAY = 86_400_000
const WEEK_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 本地时区的日期键 YYYY-MM-DD */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 取某天本地 0 点的时间戳 */
function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function durationOf(s: ReadingSession): number {
  return Math.max(0, (s.end || 0) - (s.start || 0))
}

/**
 * 把原始会话记录汇总成统计页需要的数据。
 * pure 函数，方便单测；now 可注入。
 */
export function summarize(sessions: ReadingSession[], now: number = Date.now()): StatsSummary {
  const todayStart = startOfDay(now)
  const todayKey = dayKey(now)
  const byDay = new Map<string, number>()
  const byBook = new Map<string, BookStat>()
  let totalMs = 0
  let todayMs = 0
  let weekMs = 0

  // 最近 7 天（含今天）的日期键，从旧到新
  const dayKeys: string[] = []
  for (let i = 6; i >= 0; i--) dayKeys.push(dayKey(todayStart - i * DAY))
  const weekKeySet = new Set(dayKeys)

  for (const s of sessions) {
    const ms = durationOf(s)
    if (!ms) continue
    totalMs += ms
    const key = dayKey(s.start)
    byDay.set(key, (byDay.get(key) || 0) + ms)
    if (key === todayKey) todayMs += ms
    if (weekKeySet.has(key)) weekMs += ms

    const cur = byBook.get(s.bookId) || { bookId: s.bookId, title: s.bookTitle || '未知书籍', ms: 0, sessions: 0 }
    cur.ms += ms
    cur.sessions += 1
    if (s.bookTitle) cur.title = s.bookTitle
    byBook.set(s.bookId, cur)
  }

  // 连续天数：从今天往前数；今天还没读就从昨天开始数
  let streakDays = 0
  const hasToday = (byDay.get(todayKey) || 0) > 0
  let cursor = hasToday ? todayStart : todayStart - DAY
  while ((byDay.get(dayKey(cursor)) || 0) > 0) {
    streakDays += 1
    cursor -= DAY
  }

  const days: DayStat[] = dayKeys.map((key) => {
    const ms = byDay.get(key) || 0
    const date = new Date(`${key}T00:00:00`)
    const isToday = key === todayKey
    const label = isToday ? '今天' : WEEK_LABELS[date.getDay()]
    return { date: key, label, ms }
  })

  const topBooks = Array.from(byBook.values())
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5)

  const bestDayMs = days.reduce((max, d) => Math.max(max, d.ms), 0)

  return {
    todayMs,
    weekMs,
    totalMs,
    sessions: sessions.length,
    streakDays,
    days,
    topBooks,
    bestDayMs,
  }
}

/** 人类可读的时长：<1 分钟、N 分钟、N 小时 M 分 */
export function fmtDuration(ms: number, style: 'short' | 'long' = 'long'): string {
  const totalMin = Math.floor(Math.max(0, ms) / 60_000)
  if (style === 'short') {
    if (ms <= 0) return '0 分'
    if (totalMin < 1) return '<1 分'
    if (totalMin < 60) return `${totalMin} 分`
    const h = Math.floor(totalMin / 60)
    const m = totalMin % 60
    return m ? `${h} 小时 ${m} 分` : `${h} 小时`
  }
  if (ms <= 0) return '还没有记录'
  if (totalMin < 1) return '不到 1 分钟'
  if (totalMin < 60) return `${totalMin} 分钟`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`
}

/** 生成一句鼓励语，按连续天数递进 */
export function encourage(streak: number, todayMs: number): string {
  if (todayMs <= 0) return '今天还没翻开书，读一页也好。'
  if (streak >= 30) return `连续阅读 ${streak} 天，这个习惯已经很结实了。`
  if (streak >= 7) return `连续 ${streak} 天，稳住节奏。`
  if (streak >= 3) return `连续 ${streak} 天，正在进入状态。`
  return '开卷有益，今天读一会儿吧。'
}
