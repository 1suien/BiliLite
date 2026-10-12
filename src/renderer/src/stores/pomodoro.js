import { defineStore } from 'pinia'
import { useLearnStore } from './learn'
import { useUiStore } from './ui'
import { todayKey, fmtDuration, fmtMin } from '../utils/format'
import { addFocusSession, allFocusSessions, clearFocusSessions, db, listFocusSessions } from '../db'

/* ── 番茄钟 / 专注 ──────────────────────────────────────────────────────
   计时放在 store 里（而不是组件里）：这样切到别的页面计时也不会断，
   回到「学习」页继续显示同一个倒计时。倒计时用「结束时间戳」推算，
   不依赖 setInterval 的精度，长时间挂机也不会走偏。

   每个阶段开始前可以让用户绑定一个「任务」（学习清单里的视频，或者手
   输的名字）：一轮专注结束（自然走完或手动跳过）就写一行专注记录到
   IndexedDB，用来出「今日 / 本周专注」统计和历史列表。            */

const LS_KEY = 'study-bili-pomodoro'
/** 只有两段：专注 / 休息（休息不分长短，时长自己定） */
const DEFAULTS = { focusMin: 25, breakMin: 5 }
/** 一轮专注少于这个秒数就不落库：误触开始/立刻跳过不应该污染统计 */
const MIN_RECORD_SECONDS = 30

function loadPrefs() {
  const fallback = { ...DEFAULTS, day: todayKey() }
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
    const num = (v, d) => {
      const n = Number(v)
      return Number.isFinite(n) && n >= 1 && n <= 180 ? Math.round(n) : d
    }
    return {
      day: raw.day || todayKey(),
      focusMin: num(raw.focusMin, DEFAULTS.focusMin),
      // 老版本存的是 shortMin/longMin：读旧的 shortMin 当休息时长，别让用户设置白丢
      breakMin: num(raw.breakMin != null ? raw.breakMin : raw.shortMin, DEFAULTS.breakMin),
      lastTask: typeof raw.lastTask === 'string' ? raw.lastTask : null
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

/** 'YYYY-MM-DD' 最近 days 天（含今天），旧 → 新（最后一个元素是今天） */
function recentDayKeys(days) {
  const out = []
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - (days - 1))
  for (let i = 0; i < days; i++) {
    out.push(todayKey(d))
    d.setDate(d.getDate() + 1)
  }
  return out.reverse()
}

/**
 * 专注记录 → 界面用的行。
 * 时间区间靠 startedAt + seconds 现算（数据库里没有结束时刻那一列，也不需要加）：
 *   「20:45 - 21:30」+「45m」
 */
function focusRowView(r) {
  const p = (x) => String(x).padStart(2, '0')
  const hm = (d) => `${p(d.getHours())}:${p(d.getMinutes())}`
  const start = Number(r.startedAt) || Number(r.at) || Date.now()
  const seconds = Math.max(0, Number(r.seconds) || 0)
  const a = new Date(start)
  const b = new Date(start + seconds * 1000)
  return {
    id: r.id,
    task: r.task || '',
    cover: r.cover || '',
    seconds,
    completed: Boolean(r.completed),
    from: hm(a),
    to: hm(b),
    range: `${hm(a)} - ${hm(b)}`,
    dur: fmtMin(seconds)
  }
}


export const usePomodoroStore = defineStore('pomodoro', {
  state: () => {
    const p = loadPrefs()
    return {
      day: p.day,
      focusMin: p.focusMin,
      breakMin: p.breakMin,
      mode: 'focus',
      running: false,
      remain: p.focusMin * 60,
      endAt: 0,
      rounds: 0,
      timer: null,
      visibilityHooked: false,
      /** 本轮计时过程中「界面停留」的起点；null = 当前没在计时 */
      runStart: null,
      /** 本轮已累计的专注秒数（暂停时结算，结束时落库） */
      focusedSeconds: 0,
      /** 本轮实际开始的时刻（新的一轮点「开始」时刷新） */
      startedAt: 0,
      /** 已经落过库的这一轮，避免重复写入 */
      recordedAt: 0,
      /** 绑定的任务：{ name, bvid, cover } 或 null */
      task: p.lastTask ? { name: p.lastTask, bvid: null, cover: '' } : null,
      /** 全部专注记录（统计用） */
      sessions: [],
      /** 最近 30 条专注记录（历史列表用） */
      recentSessions: [],
      statsLoaded: false
    }
  },
  getters: {
    minutesOf: (s) => (s.mode === 'focus' ? s.focusMin : s.breakMin),
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
    modeLabel: (s) => (s.mode === 'focus' ? '专注' : '休息'),
    /**
     * 本轮实际已专注的秒数（计时中 = 已结算 + 正在跑的这段）。
     *
     * ⚠ 第一行必须读一下 s.remain，别删：Date.now() 不是响应式的，而 Pinia 的 getter 会被缓存，
     * 只有依赖的 state 变了才重算。不读 remain 的话这个值会永远停在「上一次 store 变化的那一刻」——
     * 计时中恒等于 0，也就是界面「本轮 0:00」一直不动、`elapsedSeconds >= 30` 永远不成立的根因。
     * remain 由 tick() 每 250ms 更新一次，正好当这个 getter 的时钟。
     */
    elapsedSeconds(s) {
      const clock = s.remain // 仅为建立响应式依赖
      void clock
      const live = s.running && s.runStart ? Math.floor((Date.now() - s.runStart) / 1000) : 0
      return Math.max(0, Math.round(s.focusedSeconds + live))
    },
    taskLabel(s) {
      return s.task && s.task.name ? s.task.name : '未绑定任务'
    },
    /** 今日专注：完成轮数 / 总秒数（含跳过的部分时长） */
    todaySeconds(s) {
      const key = todayKey()
      return s.sessions.reduce((acc, r) => acc + (r.day === key ? r.seconds || 0 : 0), 0)
    },
    todayCount(s) {
      const key = todayKey()
      return s.sessions.filter((r) => r.day === key).length
    },
    /** 本周（以今天结尾的最近 7 天） */
    weekSeconds(s) {
      const keys = new Set(recentDayKeys(7))
      return s.sessions.reduce((acc, r) => acc + (keys.has(r.day) ? r.seconds || 0 : 0), 0)
    },
    weekCount(s) {
      const keys = new Set(recentDayKeys(7))
      return s.sessions.filter((r) => keys.has(r.day)).length
    },
    /** 平均每轮专注时长（所有记录） */
    avgSessionSeconds(s) {
      if (!s.sessions.length) return 0
      const total = s.sessions.reduce((acc, r) => acc + (r.seconds || 0), 0)
      return Math.round(total / s.sessions.length)
    },
    /** 连续专注天数：从今天（今天还没练就从昨天）往回数，断了就停 */
    streakDays(s) {
      const days = new Set(s.sessions.map((r) => r.day))
      if (!days.size) return 0
      const d = new Date()
      const key = (x) => todayKey(x)
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
    /** 近 7 天专注时长，旧 → 新（迷你条形图用，最右边是今天，和近 14 天条形图一致） */
    weekBars(s) {
      const keys = recentDayKeys(7)
      const map = new Map(keys.map((k) => [k, 0]))
      for (const r of s.sessions) {
        if (map.has(r.day)) map.set(r.day, map.get(r.day) + (r.seconds || 0))
      }
      return keys.reverse().map((date) => ({ date, seconds: map.get(date) || 0 }))
    },
    /** 全部历史：总秒数 / 总轮数（右栏「概览」用） */
    allSeconds(s) {
      return s.sessions.reduce((acc, r) => acc + (r.seconds || 0), 0)
    },
    allCount: (s) => s.sessions.length,
    /** 每个目标的累计时长 / 轮数（按记录里的 task 名字聚合；改过名的就算到新名字上） */
    byTarget(s) {
      const map = {}
      for (const r of s.sessions) {
        const name = r.task || '未绑定任务'
        if (!map[name]) map[name] = { seconds: 0, count: 0 }
        map[name].seconds += Number(r.seconds) || 0
        map[name].count += 1
      }
      return map
    },
    /** 同上，只要今天的（目标行右边那句「今日 9:55」） */
    todayByTarget(s) {
      const key = todayKey()
      const map = {}
      for (const r of s.sessions) {
        if (r.day !== key) continue
        const name = r.task || '未绑定任务'
        if (!map[name]) map[name] = { seconds: 0, count: 0 }
        map[name].seconds += Number(r.seconds) || 0
        map[name].count += 1
      }
      return map
    },
    /**
     * 专注记录按天分组（新的在前），每行都带好了「20:45 - 21:30」这种区间文本。
     * 只取最近 60 条：全量统计在 stats 里还有，列表没必要渲染几千行。
     */
    byDay(s) {
      const groups = []
      const index = new Map()
      const today = todayKey()
      const y = new Date()
      y.setDate(y.getDate() - 1)
      const yesterday = todayKey(y)
      const list = s.sessions
        .slice()
        .sort((a, b) => (b.startedAt || b.at || 0) - (a.startedAt || a.at || 0))
        .slice(0, 60)
      for (const r of list) {
        const day = r.day || today
        let g = index.get(day)
        if (!g) {
          const d = new Date(`${day}T00:00:00`)
          const label =
            day === today ? '今天' : day === yesterday ? '昨天' : `${d.getMonth() + 1}月${d.getDate()}日`
          g = { day, label, seconds: 0, rows: [] }
          index.set(day, g)
          groups.push(g)
        }
        g.seconds += Number(r.seconds) || 0
        g.rows.push(focusRowView(r))
      }
      return groups
    },
    /** 计时条主按钮上的字：跑起来之后点它就是结束（没有「暂停」这个中间态） */
    primaryLabel(s) {
      if (!s.running) return '开始专注'
      return s.mode === 'break' ? '跳过休息' : '结束专注'
    }
  },
  actions: {
    // ── 生命周期 ──────────────────────────────────────────────
    async init() {
      const key = todayKey()
      if (this.day !== key) this.day = key
      // 只有「新的一轮」才重置倒计时：暂停中的半轮进度在切页回来时要保留，
      // 否则「专注到一半顺手切去看别的页」回来就白干了。
      if (!this.running && !this.focusedSeconds) {
        this.remain = this.totalSeconds
        this.recordedAt = 0
      }
      this.persist()
      // 定时器可能被系统/Chromium 限流（窗口被挡住、最小化、休眠回来）：回到前台立刻补算一次，
      // 免得「该结束的一轮」一直卡在倒计时里不动。
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
          LS_KEY,
          JSON.stringify({
            day: this.day,
            focusMin: this.focusMin,
            breakMin: this.breakMin,
            lastTask: this.task ? this.task.name : ''
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
    /** 把正在跑的这一段（界面停留时间）结算进 focusedSeconds */
    accrue() {
      if (!this.runStart) return
      this.focusedSeconds += Math.max(0, Math.floor((Date.now() - this.runStart) / 1000))
      this.runStart = null
    },

    // ── 设置 ──────────────────────────────────────────────────
    setDurations(patch) {
      const num = (v, d) => {
        const n = Number(v)
        return Number.isFinite(n) && n >= 1 && n <= 180 ? Math.round(n) : d
      }
      if (patch.focusMin != null) this.focusMin = num(patch.focusMin, this.focusMin)
      if (patch.breakMin != null) this.breakMin = num(patch.breakMin, this.breakMin)
      this.persist()
      if (!this.running && !this.focusedSeconds) this.remain = this.totalSeconds
    },
    setMode(mode) {
      if (!['focus', 'break'].includes(mode)) return
      this.stopTick()
      this.accrue()
      this.running = false
      this.mode = mode
      // 切到专注（以及新一轮）时清空计时，休息只换时长
      if (mode === 'focus') {
        this.focusedSeconds = 0
        this.startedAt = 0
        this.recordedAt = 0
      }
      this.remain = this.totalSeconds
    },

    // ── 任务绑定 ──────────────────────────────────────────────
    /** { name, bvid, cover }；传空 = 解绑 */
    setTask(task) {
      const name = task && String(task.name || '').trim()
      if (!name) {
        this.task = null
      } else {
        this.task = { name, bvid: task.bvid || null, cover: task.cover || '' }
      }
      this.persist()
    },
    clearTask() {
      this.setTask(null)
    },

    // ── 计时控制 ──────────────────────────────────────────────
    start() {
      if (this.running) return
      if (this.remain <= 0) this.remain = this.totalSeconds
      const now = Date.now()
      this.endAt = now + this.remain * 1000
      // 新一轮（计时归零）才重置「本轮」的统计
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
      this.accrue()
      this.running = false
      this.focusedSeconds = 0
      this.startedAt = 0
      this.recordedAt = 0
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

    // ── 结束一轮 ──────────────────────────────────────────────
    /** 一个阶段结束（completed=false 表示用户点了「结束本轮」）
        是 async 的：落库成功后才把这一轮计入学习时长，两边不会对不上 */
    async finish(completed) {
      this.stopTick()
      this.accrue()
      const elapsed = this.elapsedSeconds
      const wasFocus = this.mode === 'focus'
      // 落库一律用「真实已专注的秒数」，而不是配置的时长：万一这一轮中途改过
      // 设置、或者被定时器限流救回来了，记录才是准的。
      const seconds = wasFocus ? elapsed : 0

      if (completed && wasFocus) {
        this.rounds += 1
        this.persist()
        // 本轮真实专注的秒数：落库和「计入学习时长」用同一个值，两边不会对不上
        const secs = seconds > 0 ? seconds : this.focusMin * 60
        const minutes = Math.max(1, Math.round(secs / 60))
        // 少于 30 秒的记录不落库，也就不计入学习时长（避免误触刷时长）
        const recorded = secs >= MIN_RECORD_SECONDS ? await this.record({ seconds: secs, completed: true }) : null
        if (recorded) {
          try {
            const learn = useLearnStore()
            Promise.resolve(learn.addSeconds(secs)).catch(() => {})
          } catch {
            /* store 还没就绪 */
          }
        }
        const notice =
          !recorded && secs < MIN_RECORD_SECONDS
            ? '番茄钟完成：不足 30 秒，这次不计入统计'
            : `番茄钟完成：专注 ${minutes} 分钟已计入学习时长`
        try {
          useUiStore().ok(notice)
        } catch {
          /* ignore */
        }
        notify('🍅 番茄钟完成', `已专注 ${minutes} 分钟，休息一下吧`)
        beep(2)
        this.running = false
        // 不分长短休：专注完就进同一个「休息」，时长由用户设定
        this.mode = 'break'
        // 休息自动开始，方便离开屏幕一会儿
        this.remain = this.totalSeconds
        this.start()
        return
      }

      if (completed) {
        notify('休息结束', '准备开始下一个番茄钟')
        beep(3)
      } else if (wasFocus) {
        // 手动结束专注：已经专注的部分也算数（少于 30 秒的不记，避免误触）
        // 休息阶段点「跳过」不写记录，否则会凭空多出一轮专注
        if (seconds >= MIN_RECORD_SECONDS) {
          this.record({ seconds, completed: false })
          try {
            useUiStore().ok(`已按「部分完成」记下 ${fmtDuration(seconds)} 专注`)
          } catch {
            /* ignore */
          }
        } else {
          try {
            useUiStore().toast('这轮不到 30 秒，没有记进专注记录')
          } catch {
            /* ignore */
          }
        }
      }
      this.running = false
      this.mode = 'focus'
      this.focusedSeconds = 0
      this.startedAt = 0
      this.recordedAt = 0
      this.remain = this.totalSeconds
    },
    /**
     * 主按钮 / 空格键：没在跑就开始；在跑就一定要先问一句要不要结束。
     * 提前结束的专注只要超过 30 秒也会按「部分完成」记下来，不足 30 秒不记档。
     * 放在 store 里（而不是某个组件里）：计时条、目标行、键盘快捷键三处都要用它。
     */
    async primaryAction() {
      if (!this.running) {
        if (this.mode === 'break') this.setMode('focus')
        this.start()
        return
      }
      if (this.mode === 'focus') {
        const secs = this.elapsedSeconds
        const sub =
          secs >= 30
            ? `已专注 ${fmtDuration(secs)}，会按「部分完成」记进专注记录。`
            : `这一轮只走了 ${fmtDuration(secs)}，不到 30 秒不会记进专注记录。`
        let ok = true
        try {
          ok = await useUiStore().confirm('结束这次专注？', sub, '结束专注')
        } catch {
          ok = true // 确认框拿不到（store 没就绪）就直接结束，别把计时卡死
        }
        if (!ok) return
      }
      await this.finish(false)
    },
    /** 写一行专注记录（幂等：同一轮只写一次） */
    async record({ seconds, completed }) {
      const key = this.startedAt || Date.now()
      if (this.recordedAt === key) return null
      this.recordedAt = key
      const secs = Math.max(0, Math.round(Number(seconds) || 0))
      if (secs < MIN_RECORD_SECONDS) return null
      const row = await addFocusSession({
        day: todayKey(),
        startedAt: this.startedAt || Date.now(),
        seconds: secs,
        completed: Boolean(completed),
        task: this.task ? this.task.name : '',
        bvid: this.task ? this.task.bvid : null,
        cover: this.task ? this.task.cover : '',
        mode: 'focus',
        focusMin: this.focusMin
      })
      if (row) await this.loadStats()
      return row
    },

    // ── 专注记录 ──────────────────────────────────────────────
    async loadStats() {
      const all = await allFocusSessions()
      this.sessions = all
      this.recentSessions = await listFocusSessions({ limit: 30 })
      this.statsLoaded = true
    },
    async removeSession(id) {
      await db.focus.delete(id)
      // 「今日专注」是直接从 focus 表算出来的（todayCount），删完重新读一次就自动对齐
      await this.loadStats()
    },
    /**
     * 目标改名：把历史记录里的任务名一起改掉。
     * 不改的话旧记录会挂在一个已经不存在的目标上（列表里点不到、统计里又是一行幽灵）。
     */
    async renameTask(oldName, newName) {
      const from = String(oldName || '').trim()
      const to = String(newName || '').trim()
      if (!from || !to || from === to) return 0
      let n = 0
      try {
        n = await db.focus.where('task').equals(from).modify({ task: to })
      } catch (err) {
        console.warn('[focus] 改名历史记录失败：', err && err.message)
      }
      if (this.task && this.task.name === from) this.setTask({ ...this.task, name: to })
      if (n) await this.loadStats()
      return n
    },
    /**
     * 手动补记一条专注记录（记录面板右上角的「＋」）。
     * 时间和时长都是用户填的，所以 completed 记 true —— 它本来就是「已经完成的一段」。
     */
    async addManualSession({ date, time, minutes, task }) {
      const mins = Math.max(1, Math.min(600, Math.round(Number(minutes) || 0)))
      const d = new Date(`${date}T${time || '00:00'}:00`)
      if (Number.isNaN(d.getTime())) return null
      const row = await addFocusSession({
        day: todayKey(d),
        startedAt: d.getTime(),
        seconds: mins * 60,
        completed: true,
        task: String(task || ''),
        mode: 'focus',
        focusMin: mins
      })
      if (row) await this.loadStats()
      return row
    },
    async clearSessions() {
      await clearFocusSessions()
      await this.loadStats()
    }
  }
})
