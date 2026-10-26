/**
 * 小窗播放器状态（可拖动、可缩放、跨页面常驻）
 * 还原自 mini-DAIY6r9a.js
 */
import { defineStore } from 'pinia'

export const MINI_SIZE_KEY = 'study-bili-mini'

export const MINI_SIZES = [
  { w: 320, h: 190 },
  { w: 420, h: 246 },
  { w: 560, h: 325 },
]

function loadPosition() {
  const num = (v: any, def: number) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : def)
  try {
    const raw = JSON.parse(localStorage.getItem(MINI_SIZE_KEY) || '{}')
    return {
      x: num(raw.x, -1),
      y: num(raw.y, -1),
      sizeIndex: Math.max(0, Math.min(MINI_SIZES.length - 1, num(raw.sizeIndex, 1))),
    }
  } catch {
    return { x: -1, y: -1, sizeIndex: 1 }
  }
}

export const useMiniStore = defineStore('mini', {
  state: () => {
    const pos = loadPosition()
    return {
      open: false,
      minimized: false,
      bvid: '',
      cid: 0,
      page: 1,
      title: '',
      upName: '',
      cover: '',
      qn: 80,
      startTime: 0,
      /** 每次 play 自增：MiniPlayer 用它判断「换视频了」 */
      seq: 0,
      playing: false,
      /** 进小窗时是否处于暂停（本机定制 0.4.8：离开播放页自动缩进小圈并暂停，点圆圈回来再继续播） */
      paused: false,
      currentTime: 0,
      duration: 0,
      status: '',
      error: '',
      x: pos.x,
      y: pos.y,
      sizeIndex: pos.sizeIndex,
    }
  },
  getters: {
    size: (s) => MINI_SIZES[s.sizeIndex] || MINI_SIZES[1],
    clock: (s) => {
      const fmt = (v: any) => {
        const t = Math.max(0, Math.floor(Number(v) || 0))
        const h = Math.floor(t / 3600)
        const m = Math.floor((t % 3600) / 60)
        const sec = t % 60
        const p = (x: number) => String(x).padStart(2, '0')
        return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`
      }
      return `${fmt(s.currentTime)} / ${fmt(s.duration)}`
    },
    pct: (s) => (s.duration > 0 ? Math.min(100, Math.max(0, (s.currentTime / s.duration) * 100)) : 0),
    /** 从浮窗跳回播放页时用的路由目标 */
    videoTarget: (s) => ({
      name: 'video',
      params: { bvid: s.bvid },
      query: {
        ...(s.page > 1 ? { p: String(s.page) } : {}),
        ...(s.currentTime > 3 ? { t: String(Math.floor(s.currentTime)) } : {}),
      },
    }),
  },
  actions: {
    play(video: any = {}) {
      const v = video || {}
      if (v.bvid) this.bvid = String(v.bvid)
      if (v.cid) this.cid = Number(v.cid)
      if (v.title) this.title = String(v.title)
      if (v.upName || v.upName === '') this.upName = String(v.upName || '')
      if (v.cover || v.cover === '') this.cover = String(v.cover || '')
      if (v.page) this.page = Number(v.page)
      if (v.qn) this.qn = Number(v.qn)
      else if (v.fromCard) this.qn = 0
      if (v.duration) this.duration = Number(v.duration) || 0
      this.startTime = Number(v.startTime) > 0 ? Number(v.startTime) : 0
      if (v.cid == null && v.fromCard) this.cid = 0
      // paused=true：进小窗后保持暂停（只加载到当前位置，不继续播）；默认 false 表示照常播放
      this.paused = !!v.paused
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
      this.paused = false
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
    moveTo(x: number, y: number) {
      this.x = Math.round(x)
      this.y = Math.round(y)
    },
    persist() {
      try {
        localStorage.setItem(MINI_SIZE_KEY, JSON.stringify({ x: this.x, y: this.y, sizeIndex: this.sizeIndex }))
      } catch {}
    },
    resetPos() {
      this.x = -1
      this.y = -1
      this.persist()
    },
    setProgress(currentTime: number, duration?: number) {
      this.currentTime = Number(currentTime) || 0
      if (duration) this.duration = Number(duration) || 0
    },
    setState(state: string) {
      if (state === 'playing') this.playing = true
      else if (state === 'paused') this.playing = false
      else if (state === 'waiting') this.status = '缓冲中…'
      if (state === 'playing') this.error = ''
    },
    setError(msg: any) {
      this.error = String(msg || '播放出错')
      this.status = ''
      this.playing = false
    },
  },
})
