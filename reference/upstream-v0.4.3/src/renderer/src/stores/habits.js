import { defineStore } from 'pinia'
import { listHabits, putHabit, removeHabit, listHabitLogs, setHabitLog, clearHabits } from '../db'
import { todayKey } from '../utils/format'
import { useUiStore } from './ui'

/** 已提醒过的习惯（key = 日期，value = 习惯 id 数组），本机存一份免得同一天重复弹 */
const LS_FIRED = 'study-bili-habit-remind'
/** 提醒巡检间隔：后台也被 backgroundThrottling:false 保住，30 秒够用 */
const TICK_MS = 30000
export const WEEK_HEAD = ['一', '二', '三', '四', '五', '六', '日']

function pad(n) {
  return String(n).padStart(2, '0')
}

/** 'YYYY-MM-DD' → 当地时间那天的 0 点 */
function dayToDate(day) {
  const [y, m, d] = String(day || '').split('-').map(Number)
  return new Date(y || 1970, (m || 1) - 1, d || 1)
}

/** 日期加减天数 → 'YYYY-MM-DD' */
export function shiftDay(day, delta) {
  const d = dayToDate(day)
  d.setDate(d.getDate() + delta)
  return todayKey(d)
}

/** 当前连续天数：今天打了从今天数，今天还没打但昨天打了也算连续（跟学习页签到一个口径） */
export function streakOf(set, today = todayKey()) {
  let n = 0
  let d = set.has(today) ? today : shiftDay(today, -1)
  while (set.has(d)) {
    n++
    d = shiftDay(d, -1)
  }
  return n
}

/** 历史最长连续 */
export function bestStreakOf(set) {
  let best = 0
  let run = 0
  let prev = ''
  for (const d of [...set].sort()) {
    run = prev && shiftDay(prev, 1) === d ? run + 1 : 1
    if (run > best) best = run
    prev = d
  }
  return best
}

/** 某月「已经过去」的天数（算月度完成率用；未来的月份算 0，历史月份算整月） */
export function elapsedDaysOf(ym, today = todayKey()) {
  const [y, m] = String(ym || '').split('-').map(Number)
  if (!y || !m) return 0
  const total = new Date(y, m, 0).getDate()
  const curYm = String(today).slice(0, 7)
  if (ym < curYm) return total
  if (ym > curYm) return 0
  return Number(String(today).slice(8, 10)) || total
}

/** 把一份日期集合铺成整月日历（周一起始，固定 6 行 42 格） */
export function buildMonth(set, ym, today = todayKey()) {
  const [y, m] = String(ym || '').split('-').map(Number)
  if (!y || !m) return { ym, weeks: [], label: '' }
  const first = new Date(y, m - 1, 1)
  const lead = (first.getDay() + 6) % 7 // 周一 = 0
  const total = new Date(y, m, 0).getDate()
  const cells = []
  for (let i = 0; i < lead; i++) cells.push(null)
  for (let d = 1; d <= total; d++) {
    const day = `${y}-${pad(m)}-${pad(d)}`
    cells.push({ day, num: d, done: set.has(day), today: day === today, future: day > today })
  }
  while (cells.length % 7) cells.push(null)
  while (cells.length < 42) cells.push(null)
  const weeks = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return { ym, weeks, label: `${y}年${m}月` }
}

function nowHHMM(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 系统通知（跟番茄钟同一套写法：没授权就顺手要一次） */
function pushNotify(title, body) {
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
    /** 习惯定义 */
    habits: [],
    /** 全部打卡记录 { key, habitId, date, at, note } */
    logs: [],
    /** 'active' | 'archived' */
    tab: 'active',
    /** 当前选中的习惯 id（右栏详情） */
    selectedId: 0,
    /** 右栏日历显示哪个月 'YYYY-MM' */
    viewMonth: String(todayKey()).slice(0, 7),
    timer: null,
    /** 最近一次提醒巡检的结果（排查用） */
    lastReminder: null
  }),
  getters: {
    /** habitId → 打卡日期集合 */
    dayMap: (s) => {
      const m = new Map()
      for (const l of s.logs) {
        const id = Number(l.habitId) || 0
        const day = String(l.date || '').slice(0, 10)
        if (!id || !day) continue
        if (!m.has(id)) m.set(id, new Set())
        m.get(id).add(day)
      }
      return m
    },
    daysOf() {
      return (id) => this.dayMap.get(Number(id) || 0) || new Set()
    },
    isDone() {
      return (id, day = todayKey()) => this.daysOf(id).has(day)
    },
    activeHabits: (s) => s.habits.filter((h) => !Number(h.archived)),
    archivedHabits: (s) => s.habits.filter((h) => Number(h.archived)),
    list() {
      return this.tab === 'archived' ? this.archivedHabits : this.activeHabits
    },
    selected() {
      const l = this.list
      return l.find((h) => Number(h.id) === Number(this.selectedId)) || l[0] || null
    },
    /** 今天要打的（坚持中）习惯，学习页卡片用 */
    todayList() {
      const day = todayKey()
      return this.activeHabits.map((h) => ({ ...h, done: this.daysOf(h.id).has(day) }))
    },
    todayDone() {
      const day = todayKey()
      return this.activeHabits.filter((h) => this.daysOf(h.id).has(day)).length
    },
    /** 选中的习惯 + 它的统计（累计/连续/本月完成率/近 7 天） */
    selectedStats() {
      const h = this.selected
      if (!h) return null
      return this.statsOf(h.id)
    },
    statsOf() {
      return (id) => {
        const habit = this.habits.find((x) => Number(x.id) === Number(id)) || {}
        const set = this.daysOf(id)
        const today = todayKey()
        const ym = String(today).slice(0, 7)
        const monthDone = [...set].filter((d) => d.startsWith(ym)).length
        const monthElapsed = elapsedDaysOf(ym, today)
        const total = set.size
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
          streak: streakOf(set, today),
          best: bestStreakOf(set),
          achieved: total >= target,
          todayDone: set.has(today),
          last7: Array.from({ length: 7 }, (_, i) => {
            const day = shiftDay(today, i - 6)
            return { day, done: set.has(day), today: day === today }
          })
        }
      }
    },
    /** 右栏月历（按选中习惯） */
    calendar() {
      return (ym = this.viewMonth) => buildMonth(this.selected ? this.daysOf(this.selected.id) : new Set(), ym)
    },
    /** 打卡日志：按日期倒序分组 */
    logGroups: (s) => {
      const names = new Map(s.habits.map((h) => [Number(h.id), h.name]))
      const byDay = new Map()
      for (const l of s.logs) {
        const day = String(l.date || '').slice(0, 10)
        if (!day) continue
        if (!byDay.has(day)) byDay.set(day, [])
        byDay.get(day).push({
          id: Number(l.habitId) || 0,
          name: names.get(Number(l.habitId)) || '（已删除的习惯）',
          at: Number(l.at) || 0
        })
      }
      return [...byDay.entries()]
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .map(([date, items]) => ({ date, items: items.sort((a, b) => (b.at || 0) - (a.at || 0)) }))
    },
    logCount: (s) => s.logs.length
  },
  actions: {
    async init(force = false) {
      if (this.loaded && !force) return
      await this.reload()
      this.loaded = true
    },
    async reload() {
      this.habits = await listHabits()
      this.logs = await listHabitLogs()
      const l = this.list
      if (!l.some((h) => Number(h.id) === Number(this.selectedId))) this.selectedId = l[0] ? Number(l[0].id) : 0
    },
    setTab(t) {
      this.tab = t === 'archived' ? 'archived' : 'active'
      const l = this.list
      if (!l.some((h) => Number(h.id) === Number(this.selectedId))) this.selectedId = l[0] ? Number(l[0].id) : 0
    },
    select(id) {
      this.selectedId = Number(id) || 0
    },
    setMonth(ym) {
      if (/^\d{4}-\d{2}$/.test(String(ym || ''))) this.viewMonth = ym
    },
    monthMove(delta) {
      const [y, m] = String(this.viewMonth).split('-').map(Number)
      const d = new Date(y || 2026, (m || 1) - 1 + Number(delta || 0), 1)
      this.viewMonth = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
    },
    /** 右栏整体月份（含选中的那一天所在月） */
    focusMonthOf(day) {
      this.setMonth(String(day || todayKey()).slice(0, 7))
    },
    async create(rec = {}) {
      const ui = useUiStore()
      const row = await putHabit(rec)
      if (!row) {
        ui.err('习惯名不能为空')
        return null
      }
      await this.reload()
      this.setTab('active')
      this.selectedId = Number(row.id)
      this.focusMonthOf(todayKey())
      ui.ok(`已添加习惯「${row.name}」`)
      return row
    },
    async update(id, patch = {}) {
      const ui = useUiStore()
      const row = await putHabit({ ...patch, id })
      if (!row) {
        ui.err('习惯名不能为空')
        return null
      }
      await this.reload()
      ui.ok('已保存')
      return row
    },
    /** 打卡 / 取消打卡；返回打卡后是否已打 */
    async toggle(id, day = todayKey()) {
      const on = !this.isDone(id, day)
      await setHabitLog(id, day, on)
      await this.reload()
      const ui = useUiStore()
      if (on) {
        const st = this.statsOf(id)
        ui.ok(st.streak > 1 ? `已打卡 · 连续 ${st.streak} 天` : '已打卡')
      } else {
        ui.toast('已取消打卡')
      }
      return on
    },
    async setDay(id, day, on) {
      await setHabitLog(id, day, on)
      await this.reload()
    },
    /** 归档 / 恢复（归档只是不提醒、不进今日，记录都留着） */
    async archive(id, on = true) {
      const ui = useUiStore()
      const row = await putHabit({ id, archived: on ? Date.now() : 0 })
      if (!row) return null
      await this.reload()
      ui.ok(on ? '已归档，不再提醒' : '已恢复')
      return row
    },
    async remove(id) {
      const ui = useUiStore()
      const h = this.habits.find((x) => Number(x.id) === Number(id))
      const yes = await ui.confirm(`删除习惯「${h ? h.name : ''}」？`, '它的打卡记录也会一起删掉，删了不能恢复。', '删除')
      if (!yes) return false
      await removeHabit(id)
      await this.reload()
      ui.ok('已删除')
      return true
    },
    async clearAll() {
      const ui = useUiStore()
      const yes = await ui.confirm('清空所有习惯打卡？', '习惯和全部打卡记录都会删除，删了不能恢复。', '清空')
      if (!yes) return false
      await clearHabits()
      this.selectedId = 0
      this.viewMonth = String(todayKey()).slice(0, 7)
      await this.reload()
      ui.ok('已清空')
      return true
    },
    // ---------------- 到点提醒 ----------------
    /** 今天已经提醒过哪些习惯 */
    firedFor(day = todayKey()) {
      try {
        const o = JSON.parse(localStorage.getItem(LS_FIRED) || '{}')
        return Array.isArray(o && o[day]) ? o[day].map(String) : []
      } catch (err) {
        return []
      }
    },
    markFired(day, ids = []) {
      try {
        const list = [...new Set([...this.firedFor(day), ...ids.map(String)])]
        // 只留今天这一份，不然一年下来 localStorage 里会堆 365 行
        localStorage.setItem(LS_FIRED, JSON.stringify({ [day]: list }))
        return list
      } catch (err) {
        return []
      }
    },
    /**
     * 到点该提醒谁（纯函数，不改状态、不发通知）：
     * 坚持中 + 开了提醒 + 提醒时间已到 + 今天还没打 + 今天还没提醒过
     */
    dueReminders(hhmm = nowHHMM(), day = todayKey()) {
      const fired = this.firedFor(day)
      const at = /^\d{2}:\d{2}$/.test(String(hhmm)) ? String(hhmm) : '23:59'
      return this.habits.filter(
        (h) =>
          !Number(h.archived) &&
          h.remindOn &&
          /^\d{2}:\d{2}$/.test(String(h.remindAt || '')) &&
          String(h.remindAt) <= at &&
          !fired.includes(String(h.id)) &&
          !this.daysOf(h.id).has(day)
      )
    },
    /** 真跑一次巡检：发通知 + 记下今天已提醒 */
    async runReminders(hhmm = nowHHMM(), day = todayKey(), opts = {}) {
      const due = this.dueReminders(hhmm, day)
      if (!due.length) {
        this.lastReminder = { day, at: hhmm, due: [], notified: 0, pushed: false }
        return this.lastReminder
      }
      this.markFired(day, due.map((h) => String(h.id)))
      const names = due.map((h) => h.name)
      let pushed = false
      if (opts.notify !== false) {
        pushed = pushNotify(names.length === 1 ? `该打卡了 · ${names[0]}` : `该打卡了 · ${names.length} 个习惯`, names.join('、'))
        useUiStore().toast(`该打卡了：${names.join('、')}`, 'info', 6000)
      }
      // notified 数的是「这一轮提醒了几个习惯」（落盘口径，跟系统通知有没有真弹出去无关 ——
      // 没授权时 Notification 会静默失败，那时候仍算提醒过，不然同一天会反复提醒）；
      // pushed 才是「系统通知真的发出去了」。
      this.lastReminder = { day, at: hhmm, due: names, notified: names.length, pushed }
      return this.lastReminder
    },
    startReminders() {
      if (this.timer) return
      this.runReminders().catch(() => {})
      this.timer = setInterval(() => {
        this.runReminders().catch(() => {})
      }, TICK_MS)
    },
    stopReminders() {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    },
    /** 供冒烟/排查用的一次性巡检（返回结果，不发通知） */
    checkReminders(hhmm = nowHHMM(), day = todayKey()) {
      return { day, at: hhmm, due: this.dueReminders(hhmm, day).map((h) => h.name) }
    }
  }
})
