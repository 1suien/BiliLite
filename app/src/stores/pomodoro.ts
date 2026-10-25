/**
 * 专注计时（番茄钟）store（pinia id: 'pomodoro'）
 *
 * 原始构建里这个 store 定义在 LearnView chunk 顶部，被「学习」页的
 * LearnView / FocusPanel / FocusTargets / FocusOverview / FocusRecords 共用。
 * 为保持目录整洁，还原时单独成文件（逻辑与原 chunk 逐行等价）。
 */
import { defineStore } from 'pinia'
import {
  db,
  addFocusSession,
  allFocusSessions,
  listFocusSessions,
  clearFocusSessions,
} from '@/db'
import { todayStr, formatClock, formatDuration } from '@/utils/format'
import { useUiStore } from '@/stores/ui'
import { useLearnStore } from '@/stores/learn'
import type { FocusSession } from '@/types'

const STORAGE_KEY = 'study-bili-pomodoro'
/** 默认番茄参数 */
const DEFAULT_DURATIONS = { focusMin: 25, breakMin: 5 }
/** 一轮专注少于 30 秒不记进统计 */
const MIN_RECORD_SECONDS = 30

/** 从 localStorage 读上次的番茄设置 */
function loadPomodoroConfig() {
  const fallback = { ...DEFAULT_DURATIONS, day: todayStr(), lastTask: null as string | null }
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    const num = (v: any, d: number) => {
      const n = Number(v)
      return Number.isFinite(n) && n >= 1 && n <= 180 ? Math.round(n) : d
    }
    return {
      day: raw.day || todayStr(),
      focusMin: num(raw.focusMin, DEFAULT_DURATIONS.focusMin),
      // 兼容旧版本的 shortMin 字段
      breakMin: num(raw.breakMin != null ? raw.breakMin : raw.shortMin, DEFAULT_DURATIONS.breakMin),
      lastTask: typeof raw.lastTask === 'string' ? raw.lastTask : null,
    }
  } catch {
    return fallback
  }
}

/** 用 WebAudio 敲一下提示音（不依赖音频文件） */
function beep(times = 2) {
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    let at = ctx.currentTime
    for (let i = 0; i < times; i++) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = i % 2 ? 660 : 880
      gain.gain.setValueAtTime(1e-4, at)
      gain.gain.exponentialRampToValueAtTime(0.2, at + 0.02)
      gain.gain.exponentialRampToValueAtTime(1e-4, at + 0.3)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(at)
      osc.stop(at + 0.32)
      at += 0.4
    }
    setTimeout(() => {
      try {
        ctx.close()
      } catch {}
    }, 1600)
  } catch {}
}

/** 系统通知（Capacitor 里也能用；不支持就静默跳过） */
function notify(title: string, body: string) {
  try {
    if (typeof Notification === 'undefined') return
    if (Notification.permission === 'granted') {
      new Notification(title, { body, silent: true })
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((p) => {
        if (p === 'granted') new Notification(title, { body, silent: true })
      })
    }
  } catch {}
}

/** 最近 n 天（YYYY-MM-DD），最新在前 */
function recentDays(n: number) {
  const out: string[] = []
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - (n - 1))
  for (let i = 0; i < n; i++) {
    out.push(todayStr(d))
    d.setDate(d.getDate() + 1)
  }
  return out.reverse()
}

/** 一条专注记录 -> 列表行（用于 FocusRecords 的时间轴） */
function toSessionRow(s: FocusSession) {
  const p = (n: number) => String(n).padStart(2, '0')
  const hm = (d: Date) => `${p(d.getHours())}:${p(d.getMinutes())}`
  const start = Number(s.startedAt) || Number(s.at) || Date.now()
  const seconds = Math.max(0, Number(s.seconds) || 0)
  const from = new Date(start)
  const to = new Date(start + seconds * 1e3)
  return {
    id: s.id,
    task: s.task || '',
    cover: s.cover || '',
    seconds,
    completed: !!s.completed,
    from: hm(from),
    to: hm(to),
    range: `${hm(from)} - ${hm(to)}`,
    dur: formatDuration(seconds),
  }
}

export const usePomodoroStore = defineStore('pomodoro', {
  state: () => {
    const cfg = loadPomodoroConfig()
    return {
      day: cfg.day as string,
      focusMin: cfg.focusMin,
      breakMin: cfg.breakMin,
      /** 'focus' | 'break' */
      mode: 'focus' as 'focus' | 'break',
      running: false,
      remain: cfg.focusMin * 60,
      endAt: 0,
      rounds: 0,
      timer: null as any,
      visibilityHooked: false,
      runStart: null as number | null,
      focusedSeconds: 0,
      startedAt: 0,
      recordedAt: 0,
      /** 本轮绑定的任务：{ name, bvid, cover } */
      task: cfg.lastTask
        ? ({ name: cfg.lastTask, bvid: null, cover: '' } as any)
        : (null as any),
      sessions: [] as FocusSession[],
      recentSessions: [] as FocusSession[],
      statsLoaded: false,
    }
  },
  getters: {
    minutesOf: (s) => (s.mode === 'focus' ? s.focusMin : s.breakMin),
    totalSeconds(): number {
      return this.minutesOf * 60
    },
    progress(): number {
      const total = this.totalSeconds
      return total ? Math.min(1, Math.max(0, 1 - this.remain / total)) : 0
    },
    clock: (s) => {
      const m = Math.floor(s.remain / 60)
      const sec = s.remain % 60
      return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    },
    modeLabel: (s) => (s.mode === 'focus' ? '专注' : '休息'),
    /** 本轮已经过的秒数（暂停时不会继续涨） */
    elapsedSeconds(s): number {
      // 依赖 remain，保证计时器跳动时重新计算
      s.remain
      const live = s.running && s.runStart ? Math.floor((Date.now() - s.runStart) / 1e3) : 0
      return Math.max(0, Math.round(s.focusedSeconds + live))
    },
    taskLabel(s) {
      return s.task && s.task.name ? s.task.name : '未绑定任务'
    },
    todaySeconds(s) {
      const day = todayStr()
      return s.sessions.reduce((n, r) => n + ((r.day === day && r.seconds) || 0), 0)
    },
    todayCount(s) {
      const day = todayStr()
      return s.sessions.filter((r) => r.day === day).length
    },
    weekSeconds(s) {
      const days = new Set(recentDays(7))
      return s.sessions.reduce((n, r) => n + ((days.has(r.day) && r.seconds) || 0), 0)
    },
    weekCount(s) {
      const days = new Set(recentDays(7))
      return s.sessions.filter((r) => days.has(r.day)).length
    },
    avgSessionSeconds(s) {
      if (!s.sessions.length) return 0
      const total = s.sessions.reduce((n, r) => n + (r.seconds || 0), 0)
      return Math.round(total / s.sessions.length)
    },
    /** 连续专注天数（今天没记就往前找一天） */
    streakDays(s) {
      const days = new Set(s.sessions.map((r) => r.day))
      if (!days.size) return 0
      const d = new Date()
      const key = (x: Date) => todayStr(x)
      if (!days.has(key(d))) {
        d.setDate(d.getDate() - 1)
        if (!days.has(key(d))) return 0
      }
      let n = 0
      while (days.has(key(d))) {
        n += 1
        d.setDate(d.getDate() - 1)
      }
      return n
    },
    /** 最近 7 天柱状图数据（旧 -> 新） */
    weekBars(s) {
      const days = recentDays(7)
      const map = new Map(days.map((d) => [d, 0]))
      for (const r of s.sessions) {
        if (map.has(r.day)) map.set(r.day, (map.get(r.day) || 0) + (r.seconds || 0))
      }
      return days.reverse().map((date) => ({ date, seconds: map.get(date) || 0 }))
    },
    allSeconds(s) {
      return s.sessions.reduce((n, r) => n + (r.seconds || 0), 0)
    },
    allCount: (s) => s.sessions.length,
    /** 按任务聚合 */
    byTarget(s) {
      const out: Record<string, { seconds: number; count: number }> = {}
      for (const r of s.sessions) {
        const key = r.task || '未绑定任务'
        if (!out[key]) out[key] = { seconds: 0, count: 0 }
        out[key].seconds += Number(r.seconds) || 0
        out[key].count += 1
      }
      return out
    },
    todayByTarget(s) {
      const day = todayStr()
      const out: Record<string, { seconds: number; count: number }> = {}
      for (const r of s.sessions) {
        if (r.day !== day) continue
        const key = r.task || '未绑定任务'
        if (!out[key]) out[key] = { seconds: 0, count: 0 }
        out[key].seconds += Number(r.seconds) || 0
        out[key].count += 1
      }
      return out
    },
    /** 专注记录按天分组（最多 60 条，最新在前） */
    byDay(s) {
      const groups: any[] = []
      const index = new Map<string, any>()
      const today = todayStr()
      const y = new Date()
      y.setDate(y.getDate() - 1)
      const yesterday = todayStr(y)
      const rows = s.sessions
        .slice()
        .sort((a, b) => (b.startedAt || b.at || 0) - (a.startedAt || a.at || 0))
        .slice(0, 60)
      for (const r of rows) {
        const day = r.day || today
        let group = index.get(day)
        if (!group) {
          const d = new Date(`${day}T00:00:00`)
          const label =
            day === today
              ? '今天'
              : day === yesterday
                ? '昨天'
                : `${d.getMonth() + 1}月${d.getDate()}日`
          group = { day, label, seconds: 0, rows: [] }
          index.set(day, group)
          groups.push(group)
        }
        group.seconds += Number(r.seconds) || 0
        group.rows.push(toSessionRow(r))
      }
      return groups
    },
    /** 主按钮文案 */
    primaryLabel(s) {
      return s.running ? (s.mode === 'break' ? '跳过休息' : '结束专注') : '开始专注'
    },
  },
  actions: {
    async init() {
      const day = todayStr()
      if (this.day !== day) this.day = day
      if (!this.running && !this.focusedSeconds) {
        this.remain = this.totalSeconds
        this.recordedAt = 0
      }
      this.persist()
      // 从后台切回来时补一次 tick（手机息屏后 setInterval 会被节流）
      if (!this.visibilityHooked && typeof document !== 'undefined') {
        this.visibilityHooked = true
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) this.tick()
        })
      }
      await this.loadStats()
    },
    persist() {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            day: this.day,
            focusMin: this.focusMin,
            breakMin: this.breakMin,
            lastTask: this.task ? this.task.name : '',
          }),
        )
      } catch {}
    },
    stopTick() {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    },
    /** 把正在跑的这段时间结算进 focusedSeconds */
    accrue() {
      if (this.runStart) {
        this.focusedSeconds += Math.max(0, Math.floor((Date.now() - this.runStart) / 1e3))
        this.runStart = null
      }
    },
    setDurations(patch: { focusMin?: number; breakMin?: number }) {
      const clamp = (v: any, d: number) => {
        const n = Number(v)
        return Number.isFinite(n) && n >= 1 && n <= 180 ? Math.round(n) : d
      }
      if (patch.focusMin != null) this.focusMin = clamp(patch.focusMin, this.focusMin)
      if (patch.breakMin != null) this.breakMin = clamp(patch.breakMin, this.breakMin)
      this.persist()
      if (!this.running && !this.focusedSeconds) this.remain = this.totalSeconds
    },
    setMode(mode: 'focus' | 'break') {
      if (['focus', 'break'].includes(mode)) {
        this.stopTick()
        this.accrue()
        this.running = false
        this.mode = mode
        if (mode === 'focus') {
          this.focusedSeconds = 0
          this.startedAt = 0
          this.recordedAt = 0
        }
        this.remain = this.totalSeconds
      }
    },
    setTask(task: any) {
      const name = task && String(task.name || '').trim()
      if (name) {
        this.task = { name, bvid: task.bvid || null, cover: task.cover || '' }
      } else {
        this.task = null
      }
      this.persist()
    },
    clearTask() {
      this.setTask(null)
    },
    start() {
      if (this.running) return
      if (this.remain <= 0) this.remain = this.totalSeconds
      const now = Date.now()
      this.endAt = now + this.remain * 1e3
      // 新的一轮：清空统计
      if (this.remain >= this.totalSeconds || !this.startedAt) {
        this.focusedSeconds = 0
        this.recordedAt = 0
        this.startedAt = now
      }
      this.runStart = now
      this.running = true
      this.tick()
      this.timer = setInterval(() => this.tick(), 250)
    },
    pause() {
      if (!this.running) return
      this.accrue()
      this.remain = Math.max(0, Math.round((this.endAt - Date.now()) / 1e3))
      this.running = false
      this.stopTick()
    },
    toggle() {
      this.running ? this.pause() : this.start()
    },
    reset() {
      this.stopTick()
      this.accrue()
      this.running = false
      this.focusedSeconds = 0
      this.startedAt = 0
      this.recordedAt = 0
      this.remain = this.totalSeconds
    },
    tick() {
      if (!this.running) return
      const left = Math.round((this.endAt - Date.now()) / 1e3)
      if (left <= 0) {
        this.remain = 0
        this.finish(true)
      } else {
        this.remain = left
      }
    },
    /**
     * 结束当前这一轮。
     * @param natural true = 计时自然走完（番茄钟完成），false = 手动结束
     */
    async finish(natural: boolean) {
      this.stopTick()
      this.accrue()
      const elapsed = this.elapsedSeconds
      const isFocus = this.mode === 'focus'
      const focusSec = isFocus ? elapsed : 0
      if (natural && isFocus) {
        this.rounds += 1
        this.persist()
        const seconds = focusSec > 0 ? focusSec : this.focusMin * 60
        const minutes = Math.max(1, Math.round(seconds / 60))
        const saved = seconds >= MIN_RECORD_SECONDS
          ? await this.record({ seconds, completed: true })
          : null
        if (saved) {
          try {
            const learn = useLearnStore()
            Promise.resolve(learn.addSeconds(seconds)).catch(() => {})
          } catch {}
        }
        const msg =
          !saved && seconds < MIN_RECORD_SECONDS
            ? '番茄钟完成：不足 30 秒，这次不计入统计'
            : `番茄钟完成：专注 ${minutes} 分钟已计入学习时长`
        try {
          useUiStore().ok(msg)
        } catch {}
        notify('🍅 番茄钟完成', `已专注 ${minutes} 分钟，休息一下吧`)
        beep(2)
        // 自动进入休息
        this.running = false
        this.mode = 'break'
        this.remain = this.totalSeconds
        this.start()
        return
      }
      if (natural) {
        // 休息结束
        notify('休息结束', '准备开始下一个番茄钟')
        beep(3)
      } else if (isFocus) {
        if (focusSec >= MIN_RECORD_SECONDS) {
          this.record({ seconds: focusSec, completed: false })
          try {
            useUiStore().ok(`已按「部分完成」记下 ${formatClock(focusSec)} 专注`)
          } catch {}
        } else {
          try {
            useUiStore().toast('这轮不到 30 秒，没有记进专注记录')
          } catch {}
        }
      }
      this.running = false
      this.mode = 'focus'
      this.focusedSeconds = 0
      this.startedAt = 0
      this.recordedAt = 0
      this.remain = this.totalSeconds
    },
    /** 主按钮：开始 / 结束（结束前会确认） */
    async primaryAction() {
      if (!this.running) {
        if (this.mode === 'break') this.setMode('focus')
        this.start()
        return
      }
      if (this.mode === 'focus') {
        const elapsed = this.elapsedSeconds
        const sub =
          elapsed >= 30
            ? `已专注 ${formatClock(elapsed)}，会按「部分完成」记进专注记录。`
            : `这一轮只走了 ${formatClock(elapsed)}，不到 30 秒不会记进专注记录。`
        let ok = true
        try {
          ok = await useUiStore().confirm('结束这次专注？', sub, '结束专注')
        } catch {
          ok = true
        }
        if (!ok) return
      }
      await this.finish(false)
    },
    /** 落库一条专注记录 */
    async record({ seconds, completed }: { seconds: number; completed: boolean }) {
      const stamp = this.startedAt || Date.now()
      if (this.recordedAt === stamp) return null
      this.recordedAt = stamp
      const sec = Math.max(0, Math.round(Number(seconds) || 0))
      if (sec < MIN_RECORD_SECONDS) return null
      const saved = await addFocusSession({
        day: todayStr(),
        startedAt: this.startedAt || Date.now(),
        seconds: sec,
        completed: !!completed,
        task: this.task ? this.task.name : '',
        bvid: this.task ? this.task.bvid : null,
        cover: this.task ? this.task.cover : '',
        mode: 'focus',
        focusMin: this.focusMin,
      })
      if (saved) await this.loadStats()
      return saved
    },
    async loadStats() {
      this.sessions = await allFocusSessions()
      this.recentSessions = await listFocusSessions({ limit: 30 })
      this.statsLoaded = true
    },
    async removeSession(id: number) {
      await db.focus.delete(id)
      await this.loadStats()
    },
    /** 目标改名时把历史记录一起改掉，返回改了几条 */
    async renameTask(from: string, to: string) {
      const a = String(from || '').trim()
      const b = String(to || '').trim()
      if (!a || !b || a === b) return 0
      let n = 0
      try {
        n = await db.focus.where('task').equals(a).modify({ task: b })
      } catch (e: any) {
        console.warn('[focus] 改名历史记录失败：', e && e.message)
      }
      if (this.task && this.task.name === a) this.setTask({ ...this.task, name: b })
      if (n) await this.loadStats()
      return n
    },
    /** 手动补记一条 */
    async addManualSession({ date, time, minutes, task }: { date: string; time?: string; minutes: number; task?: string }) {
      const min = Math.max(1, Math.min(600, Math.round(Number(minutes) || 0)))
      const start = new Date(`${date}T${time || '00:00'}:00`)
      if (Number.isNaN(start.getTime())) return null
      const saved = await addFocusSession({
        day: todayStr(start),
        startedAt: start.getTime(),
        seconds: min * 60,
        completed: true,
        task: String(task || ''),
        mode: 'focus',
        focusMin: min,
      })
      if (saved) await this.loadStats()
      return saved
    },
    async clearSessions() {
      await clearFocusSessions()
      await this.loadStats()
    },
  },
})
