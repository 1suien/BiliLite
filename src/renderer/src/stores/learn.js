import { defineStore } from 'pinia'
import {
  getAllProgress,
  putProgress,
  addDailySeconds,
  bumpDailyVideo,
  getDailyRange,
  getCheckins,
  putCheckin,
  addUpSeconds,
  getUpTime,
  db
} from '../db'
import { todayKey } from '../utils/format'

function keyOf(d) {
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export const useLearnStore = defineStore('learn', {
  state: () => ({
    loaded: false,
    /** key `${bvid}:${cid}` → 进度记录 */
    progressMap: {},
    daily: [],
    shelf: [],
    /** 已签到的日期（'YYYY-MM-DD'） */
    checkins: [],
    /** 按 UP 累计的学习时长 */
    upTime: [],
    sessionSeconds: 0
  }),
  getters: {
    list: (s) =>
      Object.values(s.progressMap).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    totalSeconds: (s) => s.daily.reduce((acc, d) => acc + (d.seconds || 0), 0),
    totalVideos: (s) => Object.keys(s.progressMap).length,
    completedCount: (s) => Object.values(s.progressMap).filter((r) => r.completed).length,
    inProgressCount: (s) =>
      Object.values(s.progressMap).filter((r) => !r.completed && (r.seconds || 0) > 5).length,
    todaySeconds: (s) => {
      const key = todayKey()
      const row = s.daily.find((d) => d.date === key)
      return row ? row.seconds || 0 : 0
    },
    streak: (s) => {
      let n = 0
      for (let i = s.daily.length - 1; i >= 0; i--) {
        if ((s.daily[i].seconds || 0) > 60) n++
        else if (i < s.daily.length - 1) break
      }
      return n
    },
    maxDailySeconds: (s) => Math.max(3600, ...s.daily.map((d) => d.seconds || 0)),
    /** 连续签到天数（含今天，今天没签则从昨天往前数） */
    checkinStreak: (s) => {
      const set = new Set(s.checkins)
      const d = new Date()
      if (!set.has(keyOf(d))) d.setDate(d.getDate() - 1)
      let n = 0
      while (set.has(keyOf(d))) {
        n++
        d.setDate(d.getDate() - 1)
      }
      return n
    },
    /** 近 14 天每日学习时长（条形图用） */
    recentDays() {
      return this.daily.slice(-14)
    },
    /** 按 UP 分布（饼图用） */
    upDistribution: (s) => {
      const rows = s.upTime.filter((r) => (r.seconds || 0) > 0)
      const total = rows.reduce((acc, r) => acc + r.seconds, 0)
      return rows
        .map((r) => ({ name: r.name || '未知 UP', seconds: r.seconds, pct: total ? r.seconds / total : 0 }))
        .sort((a, b) => b.seconds - a.seconds)
    }
  },
  actions: {
    async init(force = false) {
      if (this.loaded && !force) return
      const all = await getAllProgress()
      const map = {}
      for (const r of all) map[r.key || `${r.bvid}:${r.cid}`] = r
      this.progressMap = map
      this.daily = await getDailyRange(30)
      this.shelf = await db.shelf.orderBy('at').reverse().toArray()
      this.checkins = await getCheckins()
      this.upTime = await getUpTime()
      this.loaded = true
    },
    get(bvid, cid) {
      return this.progressMap[`${bvid}:${cid}`] || null
    },
    isChecked(date = todayKey()) {
      return this.checkins.includes(date)
    },
    /** 手动打卡（幂等：同一天只记一次） */
    async checkin(date = todayKey()) {
      if (this.checkins.includes(date)) return false
      await putCheckin(date)
      this.checkins = [...this.checkins, date].sort()
      return true
    },
    async save(rec) {
      const key = `${rec.bvid}:${rec.cid}`
      const prev = this.progressMap[key]
      const next = {
        bvid: rec.bvid,
        cid: rec.cid,
        title: rec.title || (prev && prev.title) || '',
        cover: rec.cover || (prev && prev.cover) || '',
        upName: rec.upName || (prev && prev.upName) || '',
        upMid: rec.upMid != null ? rec.upMid : prev && prev.upMid,
        page: rec.page != null ? rec.page : prev && prev.page,
        seconds: rec.seconds != null ? rec.seconds : (prev && prev.seconds) || 0,
        duration: rec.duration != null ? rec.duration : (prev && prev.duration) || 0,
        completed: rec.completed != null ? rec.completed : Boolean(prev && prev.completed)
      }
      const isFirst = !prev
      await putProgress(next)
      this.progressMap = { ...this.progressMap, [key]: { ...next, key, updatedAt: Date.now() } }
      if (isFirst) await bumpDailyVideo(todayKey())
      if (isFirst) this.daily = await getDailyRange(30)
    },
    /** 播放器每秒回调一次，累加当天时长 + 该 UP 的时长 */
    async addSeconds(seconds, up = null) {
      if (!seconds) return
      this.sessionSeconds += seconds
      const row = await addDailySeconds(todayKey(), seconds)
      const i = this.daily.findIndex((d) => d.date === row.date)
      if (i >= 0) this.daily[i] = { ...this.daily[i], seconds: row.seconds, videos: row.videos }
      else this.daily = await getDailyRange(30)
      if (up && (up.mid || up.name)) {
        const key = String(up.mid || up.name)
        const exist = this.upTime.find((r) => r.key === key)
        if (exist) exist.seconds = (exist.seconds || 0) + seconds
        else this.upTime = [...this.upTime, { key, mid: up.mid || null, name: up.name || '未知 UP', seconds }]
        await addUpSeconds(up, seconds)
      }
    },
    async flushSeconds() {
      const s = Math.round(this.sessionSeconds)
      this.sessionSeconds = 0
      if (s > 0) await addDailySeconds(todayKey(), s)
      this.daily = await getDailyRange(30)
    },
    async shelfToggle(item) {
      const exists = this.shelf.some((x) => x.bvid === item.bvid)
      if (exists) {
        await db.shelf.delete(item.bvid)
        this.shelf = this.shelf.filter((x) => x.bvid !== item.bvid)
        return false
      }
      const row = { ...item, at: Date.now() }
      await db.shelf.put(row)
      this.shelf = [row, ...this.shelf]
      return true
    },
    inShelf(bvid) {
      return this.shelf.some((x) => x.bvid === bvid)
    },
    async clearAll() {
      await Promise.all([
        db.progress.clear(),
        db.daily.clear(),
        db.marks.clear(),
        db.notes.clear(),
        db.shelf.clear(),
        db.checkins.clear(),
        db.upTime.clear()
      ])
      this.progressMap = {}
      this.shelf = []
      this.checkins = []
      this.upTime = []
      this.sessionSeconds = 0
      this.daily = await getDailyRange(30)
    }
  }
})
