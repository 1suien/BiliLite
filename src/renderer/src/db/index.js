import Dexie from 'dexie'

/**
 * 学习数据全部放在渲染层 IndexedDB，主进程只保存登录凭证与设置。
 *   progress  : 每个分P的观看进度，key = `${bvid}:${cid}`
 *   daily     : 按天的学习时长累计，key = 'YYYY-MM-DD'
 *   marks     : 打点/书签
 *   notes     : 学习笔记
 *   shelf     : 本地「学习清单」（不依赖 B 站收藏夹）
 *   ups       : 本机「UP 管理」名单，key = mid
 *   upgroups  : UP 分组名
 *   collect       : 本机收藏的视频
 *   collectfolders: 本机收藏的文件夹名
 *   checkins  : 手动/自动签到，key = 'YYYY-MM-DD'
 *   upTime    : 按 UP 累计的学习时长，key = mid 或 UP 名
 */
export const db = new Dexie('study-bili')

db.version(1).stores({
  progress: 'key, bvid, updatedAt, completed',
  daily: 'date',
  marks: '++id, bvid, cid, sec',
  notes: '++id, bvid, cid, at',
  shelf: 'bvid, at'
})

db.version(2).stores({
  progress: 'key, bvid, updatedAt, completed',
  daily: 'date',
  marks: '++id, bvid, cid, sec',
  notes: '++id, bvid, cid, at',
  shelf: 'bvid, at',
  ups: 'mid, group, addedAt',
  upgroups: 'name, at',
  collect: '++id, bvid, folder, at',
  collectfolders: 'name, at',
  checkins: 'date, at',
  upTime: 'key, mid, name'
})

export async function getProgress(bvid, cid) {
  return db.progress.get(`${bvid}:${cid}`)
}

export async function getAllProgress() {
  return db.progress.toArray()
}

export async function putProgress(rec) {
  return db.progress.put({ ...rec, key: `${rec.bvid}:${rec.cid}`, updatedAt: Date.now() })
}

export async function addDailySeconds(date, seconds) {
  const row = (await db.daily.get(date)) || { date, seconds: 0, videos: 0 }
  row.seconds = Math.max(0, (row.seconds || 0) + seconds)
  await db.daily.put(row)
  return row
}

export async function bumpDailyVideo(date) {
  const row = (await db.daily.get(date)) || { date, seconds: 0, videos: 0 }
  row.videos = (row.videos || 0) + 1
  await db.daily.put(row)
}

export async function getDailyRange(days = 30) {
  const rows = await db.daily.toArray()
  const map = new Map(rows.map((r) => [r.date, r]))
  const out = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const p = (x) => String(x).padStart(2, '0')
    const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    out.push({ date: key, seconds: (map.get(key) || {}).seconds || 0, videos: (map.get(key) || {}).videos || 0 })
  }
  return out
}

export async function getCheckins() {
  const rows = await db.checkins.toArray()
  return rows.map((r) => r.date)
}

export async function putCheckin(date) {
  await db.checkins.put({ date, at: Date.now() })
  return date
}

export async function addUpSeconds(up, seconds) {
  if (!up || !seconds) return null
  const key = String(up.mid || up.name || 'unknown')
  const row = (await db.upTime.get(key)) || { key, mid: up.mid || null, name: up.name || '未知 UP', seconds: 0 }
  row.seconds = Math.max(0, (row.seconds || 0) + seconds)
  if (up.name) row.name = up.name
  await db.upTime.put(row)
  return row
}

export async function getUpTime() {
  return db.upTime.toArray()
}

export default db
