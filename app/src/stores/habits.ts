/**
 * 习惯打卡：习惯 CRUD、日历、连续天数、提醒
 * 还原自 habits-C8Z8S-qa.js
 */
import { defineStore } from 'pinia'
import * as db from '@/db'
import { todayStr, pad2, parseDay, addDays, hhmm } from '@/utils/format'
import { useUiStore } from '@/stores/ui'
import type { Habit } from '@/types'

/** 星期文案（周一为一周开始） */
export const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

const REMIND_KEY = 'study-bili-habit-remind'
const REMIND_INTERVAL = 30 * 1000

function dayKey(d: Date) {
  return todayStr(d)
}

/** 以 start 结尾的连续打卡天数 */
function streakOf(days: Set<string>, end = dayKey(new Date())): number {
  let n = 0
  let cur = days.has(end) ? end : addDays(end, -1)
  while (days.has(cur)) {
    n++
    cur = addDays(cur, -1)
  }
  return n
}

/** 历史最长连续天数 */
function bestStreakOf(days: Set<string>): number {
  let best = 0
  let run = 0
  let prev = ''
  for (const day of [...days].sort()) {
    run = prev && addDays(prev, 1) === day ? run + 1 : 1
    if (run > best) best = run
    prev = day
  }
  return best
}

/** 某月已经过去的天数（用于算本月完成率） */
function elapsedDaysInMonth(ym: string, today = dayKey(new Date())): number {
  const [y, m] = String(ym || '').split('-').map(Number)
  if (!y || !m) return 0
  const total = new Date(y, m, 0).getDate()
  const thisYm = String(today).slice(0, 7)
  if (ym < thisYm) return total
  if (ym > thisYm) return 0
  return Number(String(today).slice(8, 10)) || total
}

/** 生成月历（6 行 × 7 列，空位 null） */
export function buildCalendar(days: Set<string>, ym: string, today = dayKey(new Date())) {
  const [y, m] = String(ym || '').split('-').map(Number)
  if (!y || !m) return { ym, weeks: [] as any[], label: '' }
  const firstWeekday = (new Date(y, m - 1, 1).getDay() + 6) % 7
  const total = new Date(y, m, 0).getDate()
  const cells: any[] = []
  for (let i = 0; i < firstWeekday; i++) cells.push(null)
  for (let d = 1; d <= total; d++) {
    const day = `${y}-${pad2(m)}-${pad2(d)}`
    cells.push({ day, num: d, done: days.has(day), today: day === today, future: day > today })
  }
  while (cells.length % 7) cells.push(null)
  while (cells.length < 42) cells.push(null)
  const weeks = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return { ym, weeks, label: `${y}年${m}月` }
}

/** 系统通知（权限不足时静默失败） */
function notify(title: string, body: string): boolean {
  if (typeof Notification === 'undefined') return false
  if (Notification.permission === 'granted') {
    new Notification(title, { body, silent: true })
    return true
  }
  if (Notification.permission !== 'denied') {
    Notification.requestPermission().then((p) => {
      if (p === 'granted') new Notification(title, { body, silent: true })
    })
    return true
  }
  return false
}

export const useHabitsStore = defineStore('habits', {
  state: () => ({
    loaded: false,
    habits: [] as Habit[],
    logs: [] as any[],
    tab: 'active' as 'active' | 'archived',
    selectedId: 0,
    viewMonth: String(dayKey(new Date())).slice(0, 7),
    timer: null as any,
    lastReminder: null as any,
  }),
  getters: {
    /** habitId -> Set<date> */
    dayMap: (s) => {
      const map = new Map<number, Set<string>>()
      for (const log of s.logs) {
        const id = Number(log.habitId) || 0
        const date = String(log.date || '').slice(0, 10)
        if (!id || !date) continue
        if (!map.has(id)) map.set(id, new Set())
        map.get(id)!.add(date)
      }
      return map
    },
    daysOf() {
      return (id: number | string) => this.dayMap.get(Number(id) || 0) || new Set<string>()
    },
    isDone() {
      return (id: number | string, date = dayKey(new Date())) => this.daysOf(id).has(date)
    },
    activeHabits: (s) => s.habits.filter((h) => !Number(h.archived)),
    archivedHabits: (s) => s.habits.filter((h) => Number(h.archived)),
    list(): Habit[] {
      return this.tab === 'archived' ? this.archivedHabits : this.activeHabits
    },
    selected(): Habit | null {
      const list = this.list
      return list.find((h) => Number(h.id) === Number(this.selectedId)) || list[0] || null
    },
    todayList(): (Habit & { done: boolean })[] {
      const today = dayKey(new Date())
      return this.activeHabits.map((h) => ({ ...h, done: this.daysOf(h.id as number).has(today) }))
    },
    todayDone(): number {
      const today = dayKey(new Date())
      return this.activeHabits.filter((h) => this.daysOf(h.id as number).has(today)).length
    },
    selectedStats(): any {
      return this.selected ? this.statsOf(this.selected.id as number) : null
    },
    statsOf() {
      return (id: number | string) => {
        const habit: any = this.habits.find((h) => Number(h.id) === Number(id)) || {}
        const days = this.daysOf(id)
        const today = dayKey(new Date())
        const ym = String(today).slice(0, 7)
        const monthDone = [...days].filter((d) => d.startsWith(ym)).length
        const monthElapsed = elapsedDaysInMonth(ym, today)
        const total = days.size
        const target = Math.max(1, Number(habit.targetDays) || 100)
        return {
          id: Number(id),
          name: habit.name || '',
          target,
          total,
          monthDone,
          monthElapsed,
          monthRate: monthElapsed ? Math.min(1, monthDone / monthElapsed) : 0,
          dayRate: Math.min(1, total / target),
          streak: streakOf(days, today),
          best: bestStreakOf(days),
          achieved: total >= target,
          todayDone: days.has(today),
          last7: Array.from({ length: 7 }, (_v, i) => {
            const day = addDays(today, i - 6)
            return { day, done: days.has(day), today: day === today }
          }),
        }
      }
    },
    calendar() {
      return (ym = this.viewMonth) =>
        buildCalendar(this.selected ? this.daysOf(this.selected.id as number) : new Set(), ym)
    },
    /** 打卡记录按天分组（倒序），给「记录」页用 */
    logGroups: (s) => {
      const names = new Map(s.habits.map((h) => [Number(h.id), h.name]))
      const groups = new Map<string, any[]>()
      for (const log of s.logs) {
        const date = String(log.date || '').slice(0, 10)
        if (!date) continue
        if (!groups.has(date)) groups.set(date, [])
        groups.get(date)!.push({
          id: Number(log.habitId) || 0,
          name: names.get(Number(log.habitId)) || '（已删除的习惯）',
          at: Number(log.at) || 0,
        })
      }
      return [...groups.entries()]
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .map(([date, items]) => ({ date, items: items.sort((a, b) => (b.at || 0) - (a.at || 0)) }))
    },
    logCount: (s) => s.logs.length,
  },
  actions: {
    async init(force = false) {
      if (this.loaded && !force) return
      await this.reload()
      this.loaded = true
    },
    async reload() {
      this.habits = await db.listHabits()
      this.logs = await db.listHabitLogs({})
      const list = this.list
      if (!list.some((h) => Number(h.id) === Number(this.selectedId))) {
        this.selectedId = list[0] ? Number(list[0].id) : 0
      }
    },
    setTab(tab: 'active' | 'archived') {
      this.tab = tab === 'archived' ? 'archived' : 'active'
      const list = this.list
      if (!list.some((h) => Number(h.id) === Number(this.selectedId))) {
        this.selectedId = list[0] ? Number(list[0].id) : 0
      }
    },
    select(id: number | string) {
      this.selectedId = Number(id) || 0
    },
    setMonth(ym: string) {
      if (/^\d{4}-\d{2}$/.test(String(ym || ''))) this.viewMonth = ym
    },
    monthMove(delta: number) {
      const [y, m] = String(this.viewMonth).split('-').map(Number)
      const d = new Date(y || 2026, (m || 1) - 1 + Number(delta || 0), 1)
      this.viewMonth = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
    },
    focusMonthOf(day: string) {
      this.setMonth(String(day || dayKey(new Date())).slice(0, 7))
    },
    async create(patch: Partial<Habit> = {}) {
      const ui = useUiStore()
      const rec = await db.putHabit(patch)
      if (!rec) {
        ui.err('习惯名不能为空')
        return null
      }
      await this.reload()
      this.setTab('active')
      this.selectedId = Number(rec.id)
      this.focusMonthOf(dayKey(new Date()))
      ui.ok(`已添加习惯「${rec.name}」`)
      return rec
    },
    async update(id: number, patch: Partial<Habit> = {}) {
      const ui = useUiStore()
      const rec = await db.putHabit({ ...patch, id })
      if (!rec) {
        ui.err('习惯名不能为空')
        return null
      }
      await this.reload()
      ui.ok('已保存')
      return rec
    },
    /** 切换今天（或指定日）打卡 */
    async toggle(id: number | string, date = dayKey(new Date())) {
      const done = !this.isDone(id, date)
      await db.setHabitLog(Number(id), date, done)
      await this.reload()
      const ui = useUiStore()
      if (done) {
        const stats = this.statsOf(id)
        ui.ok(stats.streak > 1 ? `已打卡 · 连续 ${stats.streak} 天` : '已打卡')
      } else {
        ui.toast('已取消打卡')
      }
      return done
    },
    async setDay(id: number | string, date: string, done: boolean) {
      await db.setHabitLog(Number(id), date, done)
      await this.reload()
    },
    async archive(id: number, archived = true) {
      const ui = useUiStore()
      const rec = await db.putHabit({ id, archived: archived ? Date.now() : 0 })
      if (!rec) return null
      await this.reload()
      ui.ok(archived ? '已归档，不再提醒' : '已恢复')
      return rec
    },
    async remove(id: number) {
      const ui = useUiStore()
      const hit = this.habits.find((h) => Number(h.id) === Number(id))
      const ok = await ui.confirm(
        `删除习惯「${hit ? hit.name : ''}」？`,
        '它的打卡记录也会一起删掉，删了不能恢复。',
        '删除',
      )
      if (!ok) return false
      await db.removeHabit(id)
      await this.reload()
      ui.ok('已删除')
      return true
    },
    async clearAll() {
      const ui = useUiStore()
      const ok = await ui.confirm('清空所有习惯打卡？', '习惯和全部打卡记录都会删除，删了不能恢复。', '清空')
      if (!ok) return false
      await db.clearHabits()
      this.selectedId = 0
      this.viewMonth = String(dayKey(new Date())).slice(0, 7)
      await this.reload()
      ui.ok('已清空')
      return true
    },
    /* ------------------------------ 提醒 ------------------------------ */
    firedFor(day = dayKey(new Date())): string[] {
      try {
        const raw = JSON.parse(localStorage.getItem(REMIND_KEY) || '{}')
        return Array.isArray(raw && raw[day]) ? raw[day].map(String) : []
      } catch {
        return []
      }
    },
    markFired(day: string, ids: string[] = []) {
      try {
        const next = [...new Set([...this.firedFor(day), ...ids.map(String)])]
        localStorage.setItem(REMIND_KEY, JSON.stringify({ [day]: next }))
        return next
      } catch {
        return []
      }
    },
    /** 到点且今天还没打卡的习惯 */
    dueReminders(now = hhmm(), day = dayKey(new Date())) {
      const fired = this.firedFor(day)
      const at = /^\d{2}:\d{2}$/.test(String(now)) ? String(now) : '23:59'
      return this.habits.filter(
        (h) =>
          !Number(h.archived) &&
          h.remindOn &&
          /^\d{2}:\d{2}$/.test(String(h.remindAt || '')) &&
          String(h.remindAt) <= at &&
          !fired.includes(String(h.id)) &&
          !this.daysOf(h.id as number).has(day),
      )
    },
    async runReminders(now = hhmm(), day = dayKey(new Date()), opts: { notify?: boolean } = {}) {
      const due = this.dueReminders(now, day)
      if (!due.length) {
        this.lastReminder = { day, at: now, due: [], notified: 0, pushed: false }
        return this.lastReminder
      }
      this.markFired(day, due.map((h) => String(h.id)))
      const names = due.map((h) => h.name)
      let pushed = false
      if (opts.notify !== false) {
        pushed = notify(
          names.length === 1 ? `该打卡了 · ${names[0]}` : `该打卡了 · ${names.length} 个习惯`,
          names.join('、'),
        )
        useUiStore().toast(`该打卡了：${names.join('、')}`, 'info', 6000)
      }
      this.lastReminder = { day, at: now, due: names, notified: names.length, pushed }
      return this.lastReminder
    },
    startReminders() {
      if (this.timer) return
      this.runReminders().catch(() => {})
      this.timer = setInterval(() => {
        this.runReminders().catch(() => {})
      }, REMIND_INTERVAL)
    },
    stopReminders() {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    },
    checkReminders(now = hhmm(), day = dayKey(new Date())) {
      return { day, at: now, due: this.dueReminders(now, day).map((h) => h.name) }
    },
  },
})
