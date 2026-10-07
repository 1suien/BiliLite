import { defineStore } from 'pinia'

/* ── 小窗播放 ──────────────────────────────────────────────────────────
   用户要的是 B 站客户端那种「小窗播放」：信息流卡片上点一下小窗按钮，
   视频进小窗继续放，人还能接着翻别的页面。这里做成**应用内悬浮小窗**
   （挂在 App.vue 上，跟着路由一直在），位置/大小存 localStorage。

   为什么「播什么」要放 store 而不是放组件里：
   - 卡片只给 bvid（没有 cid）：cid 由小窗组件用 video.pages() 补出来；
   - 视频页给的是完整信息（cid / 清晰度 / 当前进度），切小窗要接着播下去，
     「回到视频页」又要把小窗的进度带回去（见 seq / startTime）。 */

const LS_KEY = 'study-bili-mini'
/** 三档大小（16:9），点「大小」按钮循环 */
export const MINI_SIZES = [
  { w: 320, h: 190 },
  { w: 420, h: 246 },
  { w: 560, h: 325 }
]

function readGeom() {
  const num = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d)
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
    return {
      x: num(raw.x, -1),
      y: num(raw.y, -1),
      sizeIndex: Math.max(0, Math.min(MINI_SIZES.length - 1, num(raw.sizeIndex, 1)))
    }
  } catch {
    return { x: -1, y: -1, sizeIndex: 1 }
  }
}

export const useMiniStore = defineStore('mini', {
  state: () => {
    const g = readGeom()
    return {
      /** 小窗是否开着 */
      open: false,
      /** 收起成标题栏一条（还在播） */
      minimized: false,
      bvid: '',
      cid: 0,
      page: 1,
      title: '',
      upName: '',
      cover: '',
      qn: 80,
      /** 打开小窗时的起播秒数（从视频页切过来时是当前进度） */
      startTime: 0,
      /** 每次「请求播放」都 +1：组件监听它重新取流（同一视频再点一次也会重载） */
      seq: 0,
      // ── 播放状态（组件回写，供 UI 显示）──
      playing: false,
      currentTime: 0,
      duration: 0,
      status: '',
      error: '',
      // ── 几何 ──
      x: g.x,
      y: g.y,
      sizeIndex: g.sizeIndex
    }
  },
  getters: {
    size: (s) => MINI_SIZES[s.sizeIndex] || MINI_SIZES[1],
    clock: (s) => {
      const fmt = (t) => {
        const n = Math.max(0, Math.floor(Number(t) || 0))
        const h = Math.floor(n / 3600)
        const m = Math.floor((n % 3600) / 60)
        const sec = n % 60
        const pad = (x) => String(x).padStart(2, '0')
        return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
      }
      return `${fmt(s.currentTime)} / ${fmt(s.duration)}`
    },
    pct: (s) => (s.duration > 0 ? Math.min(100, Math.max(0, (s.currentTime / s.duration) * 100)) : 0),
    /** 「回到视频页」要跳的路由（带当前进度，视频页会从 ?t= 接着播） */
    videoTarget: (s) => ({
      name: 'video',
      params: { bvid: s.bvid },
      query: {
        ...(s.page > 1 ? { p: String(s.page) } : {}),
        ...(s.currentTime > 3 ? { t: String(Math.floor(s.currentTime)) } : {})
      }
    })
  },
  actions: {
    /** 打开/切换小窗播放。payload 里给了什么就用什么，没给的沿用上一次 */
    play(payload = {}) {
      const p = payload || {}
      if (p.bvid) this.bvid = String(p.bvid)
      if (p.cid) this.cid = Number(p.cid)
      if (p.title) this.title = String(p.title)
      if (p.upName || p.upName === '') this.upName = String(p.upName || '')
      if (p.cover || p.cover === '') this.cover = String(p.cover || '')
      if (p.page) this.page = Number(p.page)
      // 卡片点进来没带清晰度：清成 0，让组件回落到设置里的默认清晰度
      // （否则会沿用上一个视频的档位）
      if (p.qn) this.qn = Number(p.qn)
      else if (p.fromCard) this.qn = 0
      if (p.duration) this.duration = Number(p.duration) || 0
      this.startTime = Number(p.startTime) > 0 ? Number(p.startTime) : 0
      // 从视频页切过来时会带上 cid；从卡片点进来只有 bvid → cid 归零，让组件自己去查
      if (p.cid == null && p.fromCard) this.cid = 0
      this.open = true
      this.minimized = false
      this.error = ''
      this.status = '正在获取播放地址…'
      this.currentTime = this.startTime || 0
      this.playing = false
      this.seq += 1
    },
    close() {
      this.open = false
      this.playing = false
      this.currentTime = 0
      this.status = ''
      this.error = ''
      this.startTime = 0
    },
    toggleMinimize() {
      this.minimized = !this.minimized
    },
    cycleSize() {
      this.sizeIndex = (this.sizeIndex + 1) % MINI_SIZES.length
      this.persist()
    },
    moveTo(x, y) {
      this.x = Math.round(x)
      this.y = Math.round(y)
    },
    persist() {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({ x: this.x, y: this.y, sizeIndex: this.sizeIndex }))
      } catch {
        /* ignore */
      }
    },
    resetPos() {
      this.x = -1
      this.y = -1
      this.persist()
    },
    setProgress(t, d) {
      this.currentTime = Number(t) || 0
      if (d) this.duration = Number(d) || 0
    },
    setState(state) {
      if (state === 'playing') this.playing = true
      else if (state === 'paused') this.playing = false
      else if (state === 'waiting') this.status = '缓冲中…'
      if (state === 'playing') this.error = ''
    },
    setError(message) {
      this.error = String(message || '播放出错')
      this.status = ''
      this.playing = false
    }
  }
})
