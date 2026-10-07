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
    /** 脏行只清理一次 */
    cleanedJunk: false,
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
    /**
     * 同一个视频只保留最近看的那条（多分P也只算一个视频）。
     * 首页「继续学习」和学习记录都按视频展示，避免同一视频出现多张卡片。
     */
    listByVideo: (s) => {
      const seen = new Set()
      const out = []
      for (const r of Object.values(s.progressMap).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) {
        if (!r.bvid || seen.has(r.bvid)) continue
        seen.add(r.bvid)
        out.push(r)
      }
      return out
    },
    totalSeconds: (s) => s.daily.reduce((acc, d) => acc + (d.seconds || 0), 0),
    totalVideos() {
      return this.listByVideo.length
    },
    completedCount() {
      return this.listByVideo.filter((r) => r.completed).length
    },
    inProgressCount() {
      return this.listByVideo.filter((r) => !r.completed && (r.seconds || 0) > 5).length
    },
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
      if (!this.cleanedJunk) {
        await this.cleanupJunk().catch(() => {})
        this.cleanedJunk = true
      }
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
    /**
     * 清理历史脏行：早期版本在 bvid 还没拿到时就落库，写出 key 形如 `:cid` 的行
     * （首页「继续学习」里同一视频因此出现两张卡片，点进去还是空视频）。
     * 能按 cid 配回真实行就把进度并过去，配不上就删掉（这种行已经没法打开）。
     */
    async cleanupJunk() {
      const all = await getAllProgress()
      const bad = all.filter((r) => !r.bvid)
      if (!bad.length) return 0
      let merged = 0
      let dropped = 0
      for (const b of bad) {
        const good = all.find((r) => r.bvid && String(r.cid) === String(b.cid))
        if (good) {
          const row = {
            ...good,
            seconds: Math.max(good.seconds || 0, b.seconds || 0),
            duration: Math.max(good.duration || 0, b.duration || 0),
            completed: Boolean(good.completed || b.completed),
            title: good.title || b.title || '',
            cover: good.cover || b.cover || '',
            upName: good.upName || b.upName || '',
            updatedAt: Math.max(good.updatedAt || 0, b.updatedAt || 0)
          }
          row.key = `${row.bvid}:${row.cid}`
          await db.progress.put(row)
          good.seconds = row.seconds
          good.duration = row.duration
          good.completed = row.completed
          merged++
        } else {
          dropped++
        }
        await db.progress.delete(b.key)
      }
      console.warn('[learn] 清理历史脏进度行', { merged, dropped })
      return merged + dropped
    },
    async save(rec) {
      // 防御：bvid/cid 缺一不可，否则会写出 `:cid` 这种脏行（首页重复卡片的根源）
      if (!rec || !rec.bvid || rec.cid == null || rec.cid === '') return null
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
      // 内存里先按「本次写入的发起时间」记一条，再去落库。
      // 早先是 await putProgress() 之后才更新时间戳，于是「先发起、后完成」的旧行会拿到更新的
      // updatedAt，把真正刚看过的分P挤出「最新一行」——分P续播因此偶发地回到 P1（库里是对的，
      // 只有内存里的顺序错了，所以现象时好时坏）。
      this.progressMap = { ...this.progressMap, [key]: { ...next, key, updatedAt: Date.now() } }
      await putProgress(next)
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
        db.upTime.clear(),
        // 专注记录也属于本机学习数据，一起清掉
        db.focus.clear()
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
