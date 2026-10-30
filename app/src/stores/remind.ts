/**
 * 应用内提醒中心（本机定制 0.4.12）
 *
 * 安卓 WebView 里 `Notification` 拿不到权限，所以习惯 / 专注 / 课表的到点提醒统一走
 * 右下角的常驻卡片（见 components/ReminderCards.vue），点卡片上的按钮直接去处理。
 *
 * - 习惯提醒仍由 stores/habits.ts 的 runReminders() 扫描（它本来就有 30s 定时器），
 *   这里只负责「把提醒变成卡片」+ 去重；
 * - 专注目标的多时间点提醒、课表提醒由本 store 的 30s 定时器扫描。
 * - 已提醒过的记录存在 localStorage（按天），同一天同一项不会重复弹。
 */
import { defineStore } from 'pinia'
import { useSettingsStore } from '@/stores/settings'
import { useHabitsStore } from '@/stores/habits'
import { useSlotsStore, weekdayOf, minutesOf } from '@/stores/slots'
import { todayStr, hhmm, addDays } from '@/utils/format'
import {
  nativeNotifySupported,
  syncNativeReminders,
  nativePendingCount,
  type NativeReminderItem,
} from '@/bridge/notify'

const FIRED_KEY = 'study-bili-remind-fired'
const TICK = 30 * 1000

export type ReminderKind = 'habit' | 'focus' | 'slot'

export interface ReminderAction {
  label: string
  /** vue-router 目标（点按钮直接跳过去） */
  to?: any
}

export interface ReminderCard {
  key: string
  kind: ReminderKind
  title: string
  body: string
  at: number
  actions: ReminderAction[]
}

function readFired(): Record<string, string[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(FIRED_KEY) || '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

export const useRemindStore = defineStore('remind', {
  state: () => ({
    cards: [] as ReminderCard[],
    timer: null as any,
    lastCheck: { at: '', day: '', cards: 0 },
    /** 系统通知同步状态（本机构建 0.4.13） */
    native: { supported: false, scheduled: 0, error: '', at: '' } as {
      supported: boolean
      scheduled: number
      error: string
      at: string
    },
  }),
  getters: {
    count: (s) => s.cards.length,
  },
  actions: {
    /* ------------------------------ 卡片队列 ------------------------------ */
    push(card: ReminderCard) {
      if (!card || !card.key) return false
      if (this.cards.some((c) => c.key === card.key)) return false
      this.cards.unshift({ ...card, at: Number(card.at) || Date.now() })
      // 同时最多留 3 张，避免糊满屏幕
      if (this.cards.length > 3) this.cards.length = 3
      return true
    },
    dismiss(key: string) {
      this.cards = this.cards.filter((c) => c.key !== key)
    },
    clear() {
      this.cards = []
    },

    /* ------------------------------ 去重记录 ------------------------------ */
    firedFor(day = todayStr()): string[] {
      const raw = readFired()
      return Array.isArray(raw[day]) ? raw[day].map(String) : []
    },
    markFired(day: string, keys: string[] = []) {
      try {
        const raw = readFired()
        const next = [...new Set([...this.firedFor(day), ...keys.map(String)])]
        // 只留最近 7 天，别把 localStorage 撑大
        const days = Object.keys(raw).sort().slice(-6)
        const kept: Record<string, string[]> = {}
        for (const d of days) kept[d] = raw[d]
        kept[day] = next
        localStorage.setItem(FIRED_KEY, JSON.stringify(kept))
        return next
      } catch {
        return []
      }
    },

    /* ------------------------------ 扫描到点提醒 ------------------------------ */
    /** 专注目标：每个目标可以设多个提醒时间 */
    dueFocus(now = hhmm(), day = todayStr()): ReminderCard[] {
      const settings = useSettingsStore()
      const targets = (Array.isArray(settings.settings.focusTargets) ? settings.settings.focusTargets : [])
        .filter((t: any) => t && !t.archived)
      const fired = this.firedFor(day)
      const at = /^\d{2}:\d{2}$/.test(String(now)) ? String(now) : '00:00'
      const out: ReminderCard[] = []
      for (const t of targets as any[]) {
        const times = (Array.isArray(t.reminders) ? t.reminders : [])
          .map(String)
          .filter((x: string) => /^\d{2}:\d{2}$/.test(x))
        for (const time of times) {
          const key = `focus:${t.name}:${day}:${time}`
          if (fired.includes(key)) continue
          if (time > at) continue
          out.push({
            key,
            kind: 'focus',
            title: `该专注「${t.name}」了`,
            body: `设的提醒时间 ${time}，去开一轮专注？`,
            at: Date.now(),
            actions: [{ label: '去专注', to: { path: '/learn' } }],
          })
        }
      }
      return out
    },

    /** 课表：今天某个时段开始前提醒（提前量每条自己设，默认 5 分钟） */
    dueSlots(now = hhmm(), day = todayStr()): ReminderCard[] {
      const slots = useSlotsStore()
      const wd = weekdayOf(day)
      const fired = this.firedFor(day)
      const at = /^\d{2}:\d{2}$/.test(String(now)) ? String(now) : '00:00'
      const out: ReminderCard[] = []
      for (const s of slots.list) {
        if (!Array.isArray(s.days) || !s.days.includes(wd) || !s.remindOn) continue
        const start = /^\d{2}:\d{2}$/.test(String(s.start || '')) ? String(s.start) : ''
        if (!start) continue
        const lead = Math.max(0, Math.min(60, Number(s.remindLead) || 0))
        const remindAt = shift(start, -lead)
        if (at < remindAt) continue
        // 提醒时刻之后 10 分钟就不再弹，免得下午才提醒上午的事
        if (at > shift(remindAt, 10)) continue
        const key = `slot:${s.id}:${day}`
        if (fired.includes(key)) continue
        const mins = Math.max(0, minutesOf(s.end) - minutesOf(s.start))
        out.push({
          key,
          kind: 'slot',
          title: lead ? `${lead} 分钟后 · ${s.name}` : `该开始「${s.name}」了`,
          body: `${s.start}–${s.end} · ${s.kind === 'break' ? '休息' : '学习'} ${mins} 分钟`,
          at: Date.now(),
          actions: [
            s.bvid
              ? { label: '去看关联视频', to: { path: `/video/${s.bvid}` } }
              : { label: '去课表', to: { path: '/schedule' } },
          ],
        })
      }
      return out
    },

    /** 习惯提醒：stores/habits.ts 的 runReminders() 扫到之后交给这里弹卡片 */
    pushHabits(due: any[] = [], day = todayStr()) {
      for (const h of due) {
        this.push({
          key: `habit:${h.id}:${day}`,
          kind: 'habit',
          title: `该打卡了 · ${h.name}`,
          body: String(h.remindAt || '') ? `每天 ${h.remindAt} 提醒` : '到点提醒',
          at: Date.now(),
          actions: [{ label: '去打卡', to: { path: '/habit', query: { h: String(h.id) } } }],
        })
      }
    },

    /** 扫一轮：专注目标 + 课表 */
    check(now?: string, day?: string) {
      const nd = day || todayStr()
      const na = now || hhmm()
      const focus = this.dueFocus(na, nd)
      const slot = this.dueSlots(na, nd)
      const all = [...focus, ...slot]
      for (const card of all) this.push(card)
      if (all.length) this.markFired(nd, all.map((c) => c.key))
      this.lastCheck = { at: na, day: nd, cards: all.length }
      return { focus: focus.map((c) => c.key), slot: slot.map((c) => c.key) }
    },

    /* ---------------------- 系统通知（软件外也能看到 + 提示音） ---------------------- */
    /** 把专注目标 / 习惯（每天重复）和课表（最近 7 天的一次性）整理成通知清单 */
    nativeItems(): NativeReminderItem[] {
      const settings = useSettingsStore()
      const habits = useHabitsStore()
      const out: NativeReminderItem[] = []

      // 专注目标：每个目标的多个提醒时间，每天重复
      const targets = (Array.isArray(settings.settings.focusTargets) ? settings.settings.focusTargets : []).filter(
        (t: any) => t && !t.archived,
      )
      for (const t of targets as any[]) {
        const times = (Array.isArray(t.reminders) ? t.reminders : [])
          .map(String)
          .filter((x: string) => /^\d{2}:\d{2}$/.test(x))
        for (const time of times) {
          const [hour, minute] = time.split(':').map(Number)
          out.push({
            key: `focus:${t.name}:${time}`,
            hour,
            minute,
            title: `该专注「${t.name}」了`,
            body: `设的提醒时间 ${time}，去开一轮专注？`,
            path: '/learn',
          })
        }
      }

      // 习惯：每天到点提醒（已打卡就不再提示，由应用内逻辑负责；系统通知只负责到点响）
      for (const h of habits.habits as any[]) {
        if (!h || Number(h.archived) || !h.remindOn) continue
        const at = String(h.remindAt || '')
        if (!/^\d{2}:\d{2}$/.test(at)) continue
        const [hour, minute] = at.split(':').map(Number)
        out.push({
          key: `habit:${h.id}:${at}`,
          hour,
          minute,
          title: `该打卡了 · ${h.name}`,
          body: `每天 ${at} 提醒，去打个卡？`,
          path: `/habit?h=${h.id}`,
        })
      }

      // 课表：每个时段按自己的星期重复，提前量换算成通知时间
      const slots = useSlotsStore()
      const base = new Date()
      for (const s of slots.list as any[]) {
        if (!s || !s.remindOn) continue
        const start = String(s.start || '')
        if (!/^\d{2}:\d{2}$/.test(start)) continue
        const lead = Math.max(0, Math.min(60, Number(s.remindLead) || 0))
        const at = shift(start, -lead)
        const [hour, minute] = at.split(':').map(Number)
        const days = Array.isArray(s.days) ? s.days : []
        for (let i = 0; i < 8; i++) {
          const d = addDays(todayStr(base), i)
          if (!days.includes(weekdayOf(d))) continue
          if (i === 0 && at <= hhmm(base)) continue
          const parts = d.split('-').map(Number)
          out.push({
            key: `slot:${s.id}:${d}`,
            hour,
            minute,
            title: lead ? `${lead} 分钟后 · ${s.name}` : `该开始「${s.name}」了`,
            body: `${s.start}–${s.end}`,
            path: s.bvid ? `/video/${s.bvid}` : '/schedule',
            date: { year: parts[0], month: parts[1], day: parts[2] },
          })
        }
      }
      return out.slice(0, 40)
    },

    /** 同步到系统通知（安卓原生；浏览器里是 no-op） */
    async syncNative() {
      const supported = nativeNotifySupported()
      if (!supported) {
        this.native = { supported: false, scheduled: 0, error: 'unsupported', at: hhmm() }
        return this.native
      }
      const res = await syncNativeReminders(this.nativeItems())
      const pending = await nativePendingCount()
      this.native = {
        supported: true,
        scheduled: res.ok ? pending : 0,
        error: res.error || '',
        at: hhmm(),
      }
      return this.native
    },

    start() {
      if (this.timer) return
      // 等各 store 初始化完再扫第一轮
      Promise.all([
        useSettingsStore().init?.(),
        useHabitsStore().init?.(),
        useSlotsStore().init?.(),
      ])
        .then(() => {
          this.check()
          // 本机构建 0.4.13：把同一批提醒交给系统通知（软件在后台也能看到 + 提示音）
          this.syncNative().catch(() => {})
        })
        .catch(() => {})
      this.timer = setInterval(() => {
        this.check()
      }, TICK)
    },
    stop() {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    },
  },
})

/** HH:MM 平移分钟（负数往前） */
export function shift(hhmmStr: string, minutes: number): string {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmmStr || ''))
  if (!m) return hhmmStr
  let total = Number(m[1]) * 60 + Number(m[2]) + Number(minutes || 0)
  total = ((total % 1440) + 1440) % 1440
  const h = Math.floor(total / 60)
  const mm = total % 60
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}
