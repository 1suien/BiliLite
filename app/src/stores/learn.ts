/**
 * 学习数据：进度、每日时长、打卡、UP 时长分布
 * 还原自 learn-CdIQSw0v.js
 */
import { defineStore } from 'pinia'
import * as db from '@/db'
import { todayStr } from '@/utils/format'
import type { DailyRecord, ProgressRecord, ShelfItem, UpTimeRecord } from '@/types'

/** 今日日期 YYYY-MM-DD（本地时区） */
function dayKey(d: Date) {
  return todayStr(d)
}

export const useLearnStore = defineStore('learn', {
  state: () => ({
    loaded: false,
    cleanedJunk: false,
    progressMap: {} as Record<string, ProgressRecord>,
    daily: [] as DailyRecord[],
    shelf: [] as ShelfItem[],
    checkins: [] as string[],
    upTime: [] as UpTimeRecord[],
    /** 还没落库的播放秒数（节省 IndexedDB 写入） */
    sessionSeconds: 0,
  }),
  getters: {
    list: (s) =>
      Object.values(s.progressMap).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    /** 按视频去重（同一视频多个分 P 只保留最近一条） */
    listByVideo: (s) => {
      const seen = new Set<string>()
      const out: ProgressRecord[] = []
      for (const p of Object.values(s.progressMap).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) {
        if (!p.bvid || seen.has(p.bvid)) continue
        seen.add(p.bvid)
        out.push(p)
      }
      return out
    },
    totalSeconds: (s) => s.daily.reduce((a, b) => a + (b.seconds || 0), 0),
    totalVideos(): number {
      return this.listByVideo.length
    },
    completedCount(): number {
      return this.listByVideo.filter((p) => p.completed).length
    },
    inProgressCount(): number {
      return this.listByVideo.filter((p) => !p.completed && (p.seconds || 0) > 5).length
    },
    todaySeconds: (s) => {
      const key = dayKey(new Date())
      const row = s.daily.find((d) => d.date === key)
      return (row && row.seconds) || 0
    },
    /** 连续学习天数（每天 > 60s 才算） */
    streak: (s) => {
      let n = 0
      for (let i = s.daily.length - 1; i >= 0; i--) {
        if ((s.daily[i].seconds || 0) > 60) n++
        else if (i < s.daily.length - 1) break
      }
      return n
    },
    maxDailySeconds: (s) => Math.max(3600, ...s.daily.map((d) => d.seconds || 0)),
    /** 连续打卡天数 */
    checkinStreak: (s) => {
      const set = new Set(s.checkins)
      const d = new Date()
      if (!set.has(dayKey(d))) d.setDate(d.getDate() - 1)
      let n = 0
      while (set.has(dayKey(d))) {
        n++
        d.setDate(d.getDate() - 1)
      }
      return n
    },
    recentDays(): DailyRecord[] {
      return this.daily.slice(-14)
    },
    /** UP 主学习时长占比 */
    upDistribution: (s) => {
      const rows = s.upTime.filter((u) => (u.seconds || 0) > 0)
      const total = rows.reduce((a, b) => a + b.seconds, 0)
      return rows
        .map((u) => ({ name: u.name || '未知 UP', seconds: u.seconds, pct: total ? u.seconds / total : 0 }))
        .sort((a, b) => b.seconds - a.seconds)
    },
  },
  actions: {
    async init(force = false) {
      if (this.loaded && !force) return
      if (!this.cleanedJunk) {
        await this.cleanupJunk().catch(() => {})
        this.cleanedJunk = true
      }
      const rows = await db.getAllProgress()
      const map: Record<string, ProgressRecord> = {}
      for (const r of rows) map[r.key || `${r.bvid}:${r.cid}`] = r
      this.progressMap = map
      this.daily = await db.getDailyRange(30)
      this.shelf = (await db.db.shelf.orderBy('at').reverse().toArray()) as ShelfItem[]
      this.checkins = await db.getCheckins()
      this.upTime = await db.getUpTime()
      this.loaded = true
    },
    get(bvid: string, cid: number | string) {
      return this.progressMap[`${bvid}:${cid}`] || null
    },
    isChecked(date = dayKey(new Date())) {
      return this.checkins.includes(date)
    },
    async checkin(date = dayKey(new Date())) {
      if (this.checkins.includes(date)) return false
      await db.putCheckin(date)
      this.checkins = [...this.checkins, date].sort()
      return true
    },
    /**
     * 历史脏数据清理：旧版本可能写出没有 bvid 的进度行，
     * 能按 cid 合并到正常行就合并，否则丢弃。
     */
    async cleanupJunk() {
      const rows = await db.getAllProgress()
      const junk = rows.filter((r) => !r.bvid)
      if (!junk.length) return 0
      let merged = 0
      let dropped = 0
      for (const item of junk) {
        const target = rows.find((r) => r.bvid && String(r.cid) === String(item.cid))
        if (target) {
          const next = {
            ...target,
            seconds: Math.max(target.seconds || 0, item.seconds || 0),
            duration: Math.max(target.duration || 0, item.duration || 0),
            completed: !!(target.completed || item.completed),
            title: target.title || item.title || '',
            cover: target.cover || item.cover || '',
            upName: target.upName || item.upName || '',
            updatedAt: Math.max(target.updatedAt || 0, item.updatedAt || 0),
          }
          next.key = `${next.bvid}:${next.cid}`
          await db.db.progress.put(next)
          target.seconds = next.seconds
          target.duration = next.duration
          target.completed = next.completed
          merged++
        } else {
          dropped++
        }
        await db.db.progress.delete(item.key)
      }
      console.warn('[learn] 清理历史脏进度行', { merged, dropped })
      return merged + dropped
    },
    /** 保存播放进度（seconds/completed 不传则保留旧值） */
    async save(p: Partial<ProgressRecord> & { bvid?: string; cid?: any }) {
      if (!p || !p.bvid || p.cid == null || p.cid === '') return null
      const key = `${p.bvid}:${p.cid}`
      const old = this.progressMap[key]
      const next = {
        bvid: p.bvid,
        cid: p.cid,
        title: p.title || (old && old.title) || '',
        cover: p.cover || (old && old.cover) || '',
        upName: p.upName || (old && old.upName) || '',
        upMid: p.upMid != null ? p.upMid : old && old.upMid,
        page: p.page != null ? p.page : old && old.page,
        seconds: p.seconds != null ? p.seconds : (old && old.seconds) || 0,
        duration: p.duration != null ? p.duration : (old && old.duration) || 0,
        completed: p.completed != null ? p.completed : !!(old && old.completed),
      }
      const isNew = !old
      this.progressMap = { ...this.progressMap, [key]: { ...next, key, updatedAt: Date.now() } as ProgressRecord }
      await db.putProgress(next as ProgressRecord)
      if (isNew) {
        await db.bumpDailyVideo(dayKey(new Date()))
        this.daily = await db.getDailyRange(30)
      }
      return null
    },
    /** 累加观看秒数（同时计入 UP 时长） */
    async addSeconds(sec: number, up: { mid?: number | null; name?: string } | null = null) {
      if (!sec) return
      this.sessionSeconds += sec
      const row = await db.addDailySeconds(dayKey(new Date()), sec)
      const i = this.daily.findIndex((d) => d.date === row.date)
      if (i >= 0) this.daily[i] = { ...this.daily[i], seconds: row.seconds, videos: row.videos }
      else this.daily = await db.getDailyRange(30)

      if (up && (up.mid || up.name)) {
        const key = String(up.mid || up.name)
        const hit = this.upTime.find((u) => u.key === key)
        if (hit) hit.seconds = (hit.seconds || 0) + sec
        else
          this.upTime = [
            ...this.upTime,
            { key, mid: up.mid || null, name: up.name || '未知 UP', seconds: sec },
          ]
        await db.addUpSeconds(up, sec)
      }
    },
    /** 把缓存的秒数落库（离开播放页时调用） */
    async flushSeconds() {
      const sec = Math.round(this.sessionSeconds)
      this.sessionSeconds = 0
      if (sec > 0) await db.addDailySeconds(dayKey(new Date()), sec)
      this.daily = await db.getDailyRange(30)
    },
    /** 稍后再看开关 */
    async shelfToggle(video: Partial<ShelfItem> & { bvid: string }) {
      if (this.shelf.some((x) => x.bvid === video.bvid)) {
        await db.db.shelf.delete(video.bvid)
        this.shelf = this.shelf.filter((x) => x.bvid !== video.bvid)
        return false
      }
      const rec = { ...video, at: Date.now() } as ShelfItem
      await db.db.shelf.put(rec)
      this.shelf = [rec, ...this.shelf]
      return true
    },
    inShelf(bvid: string) {
      return this.shelf.some((x) => x.bvid === bvid)
    },
    async clearAll() {
      await Promise.all([
        db.db.progress.clear(),
        db.db.daily.clear(),
        db.db.marks.clear(),
        db.db.notes.clear(),
        db.db.shelf.clear(),
        db.db.checkins.clear(),
        db.db.upTime.clear(),
        db.db.focus.clear(),
      ])
      this.progressMap = {}
      this.shelf = []
      this.checkins = []
      this.upTime = []
      this.sessionSeconds = 0
      this.daily = await db.getDailyRange(30)
    },
  },
})
