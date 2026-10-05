import { defineStore } from 'pinia'
import {
  getAllProgress,
  putProgress,
  addDailySeconds,
  bumpDailyVideo,
  getDailyRange,
  db
} from '../db'
import { todayKey } from '../utils/format'

export const useLearnStore = defineStore('learn', {
  state: () => ({
    loaded: false,
    /** key `${bvid}:${cid}` → 进度记录 */
    progressMap: {},
    daily: [],
    shelf: [],
    sessionSeconds: 0
  }),
  getters: {
    list: (s) =>
      Object.values(s.progressMap).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    totalSeconds: (s) => s.daily.reduce((acc, d) => acc + (d.seconds || 0), 0),
    totalVideos: (s) => Object.keys(s.progressMap).length,
    completedCount: (s) => Object.values(s.progressMap).filter((r) => r.completed).length,
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
    maxDailySeconds: (s) => Math.max(3600, ...s.daily.map((d) => d.seconds || 0))
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
      this.loaded = true
    },
    get(bvid, cid) {
      return this.progressMap[`${bvid}:${cid}`] || null
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
    /** 播放器每秒回调一次，累加当天时长 */
    async addSeconds(seconds) {
      if (!seconds) return
      this.sessionSeconds += seconds
      const row = await addDailySeconds(todayKey(), seconds)
      const i = this.daily.findIndex((d) => d.date === row.date)
      if (i >= 0) this.daily[i] = { ...this.daily[i], seconds: row.seconds, videos: row.videos }
      else this.daily = await getDailyRange(30)
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
        db.shelf.clear()
      ])
      this.progressMap = {}
      this.shelf = []
      this.sessionSeconds = 0
      this.daily = await getDailyRange(30)
    }
  }
})
