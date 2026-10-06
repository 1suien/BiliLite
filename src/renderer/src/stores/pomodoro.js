import { defineStore } from 'pinia'
import { useLearnStore } from './learn'
import { useUiStore } from './ui'
import { todayKey } from '../utils/format'

/* ── 番茄钟 ────────────────────────────────────────────────────────────
   计时放在 store 里（而不是组件里）：这样切到别的页面计时也不会断，
   回到「学习」页继续显示同一个倒计时。倒计时用「结束时间戳」推算，
   不依赖 setInterval 的精度，长时间挂机也不会走偏。            */

const LS_KEY = 'study-bili-pomodoro'
const DEFAULTS = { focusMin: 25, shortMin: 5, longMin: 15 }

function loadPrefs() {
  const fallback = { ...DEFAULTS, day: todayKey(), doneToday: 0 }
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
    const num = (v, d) => {
      const n = Number(v)
      return Number.isFinite(n) && n >= 1 && n <= 180 ? Math.round(n) : d
    }
    return {
      day: raw.day || todayKey(),
      doneToday: Number(raw.doneToday) || 0,
      focusMin: num(raw.focusMin, DEFAULTS.focusMin),
      shortMin: num(raw.shortMin, DEFAULTS.shortMin),
      longMin: num(raw.longMin, DEFAULTS.longMin)
    }
  } catch {
    return fallback
  }
}

/** 两短促提示音（Web Audio，不需要任何素材文件） */
function beep(times = 2) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    let t = ctx.currentTime
    for (let i = 0; i < times; i++) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = i % 2 ? 660 : 880
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.2, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.32)
      t += 0.4
    }
    setTimeout(() => {
      try {
        ctx.close()
      } catch {
        /* ignore */
      }
    }, 1600)
  } catch {
    /* 没有音频权限就算了 */
  }
}

function notify(title, body) {
  try {
    if (typeof Notification === 'undefined') return
    if (Notification.permission === 'granted') new Notification(title, { body, silent: true })
    else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((p) => {
        if (p === 'granted') new Notification(title, { body, silent: true })
      })
    }
  } catch {
    /* ignore */
  }
}

export const usePomodoroStore = defineStore('pomodoro', {
  state: () => {
    const p = loadPrefs()
    return {
      ...p,
      mode: 'focus',
      running: false,
      remain: p.focusMin * 60,
      endAt: 0,
      rounds: 0,
      timer: null,
      visibilityHooked: false
    }
  },
  getters: {
    minutesOf: (s) =>
      s.mode === 'focus' ? s.focusMin : s.mode === 'short' ? s.shortMin : s.longMin,
    totalSeconds() {
      return this.minutesOf * 60
    },
    progress() {
      const total = this.totalSeconds
      if (!total) return 0
      return Math.min(1, Math.max(0, 1 - this.remain / total))
    },
    clock: (s) => {
      const m = Math.floor(s.remain / 60)
      const sec = s.remain % 60
      return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    },
    modeLabel: (s) => (s.mode === 'focus' ? '专注' : s.mode === 'short' ? '短休息' : '长休息')
  },
  actions: {
    init() {
      const key = todayKey()
      if (this.day !== key) {
        this.day = key
        this.doneToday = 0
      }
      if (!this.running) this.remain = this.totalSeconds
      this.persist()
      // 定时器可能被系统/Chromium 限流（窗口被挡住、最小化、休眠回来）：回到前台立刻补算一次，
      // 免得「该结束的一轮」一直卡在倒计时里不动。
      if (!this.visibilityHooked && typeof document !== 'undefined') {
        this.visibilityHooked = true
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) this.tick()
        })
      }
    },
    persist() {
      try {
        localStorage.setItem(
          LS_KEY,
          JSON.stringify({
            day: this.day,
            doneToday: this.doneToday,
            focusMin: this.focusMin,
            shortMin: this.shortMin,
            longMin: this.longMin
          })
        )
      } catch {
        /* ignore */
      }
    },
    stopTick() {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    },
    setDurations(patch) {
      const num = (v, d) => {
        const n = Number(v)
        return Number.isFinite(n) && n >= 1 && n <= 180 ? Math.round(n) : d
      }
      if (patch.focusMin != null) this.focusMin = num(patch.focusMin, this.focusMin)
      if (patch.shortMin != null) this.shortMin = num(patch.shortMin, this.shortMin)
      if (patch.longMin != null) this.longMin = num(patch.longMin, this.longMin)
      this.persist()
      if (!this.running) this.remain = this.totalSeconds
    },
    setMode(mode) {
      if (!['focus', 'short', 'long'].includes(mode)) return
      this.stopTick()
      this.running = false
      this.mode = mode
      this.remain = this.totalSeconds
    },
    start() {
      if (this.running) return
      if (this.remain <= 0) this.remain = this.totalSeconds
      this.endAt = Date.now() + this.remain * 1000
      this.running = true
      this.tick()
      this.timer = setInterval(() => this.tick(), 250)
    },
    pause() {
      if (!this.running) return
      this.remain = Math.max(0, Math.round((this.endAt - Date.now()) / 1000))
      this.running = false
      this.stopTick()
    },
    toggle() {
      if (this.running) this.pause()
      else this.start()
    },
    reset() {
      this.stopTick()
      this.running = false
      this.remain = this.totalSeconds
    },
    tick() {
      if (!this.running) return
      const left = Math.round((this.endAt - Date.now()) / 1000)
      if (left <= 0) {
        this.remain = 0
        this.finish(true)
      } else {
        this.remain = left
      }
    },
    /** 一个阶段结束（completed=false 表示用户点了「跳过」） */
    finish(completed) {
      this.stopTick()
      this.running = false
      const wasFocus = this.mode === 'focus'
      if (completed && wasFocus) {
        this.doneToday += 1
        this.rounds += 1
        this.persist()
        const minutes = this.focusMin
        try {
          const learn = useLearnStore()
          Promise.resolve(learn.addSeconds(minutes * 60)).catch(() => {})
        } catch {
          /* store 还没就绪 */
        }
        try {
          useUiStore().ok(`番茄钟完成：专注 ${minutes} 分钟已计入学习时长`)
        } catch {
          /* ignore */
        }
        notify('🍅 番茄钟完成', `已专注 ${minutes} 分钟，休息一下吧`)
        beep(2)
        this.mode = this.rounds % 4 === 0 ? 'long' : 'short'
        // 休息自动开始，方便离开屏幕一会儿
        this.remain = this.totalSeconds
        this.start()
        return
      }
      if (completed) {
        notify('休息结束', '准备开始下一个番茄钟')
        beep(3)
      }
      this.mode = 'focus'
      this.remain = this.totalSeconds
    }
  }
})
