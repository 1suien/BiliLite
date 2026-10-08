import Dexie from 'dexie'
import { todayKey } from '../utils/format'

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
 *   subs      : 本地字幕文件解析结果，key = `${bvid}:${cid}:${name}`
 *   focus     : 番茄钟/专注记录，每完成（或跳过）一轮写一行
 *   habits    : 习惯打卡的习惯定义（名字 / 目标天数 / 提醒时间 / 是否归档）
 *   habitLogs : 每个习惯每天的打卡记录，key = `${habitId}:${date}`
 *
 * 注意：v3 声明的 books / bookmarks / highlights（原读书模块）**故意保留不删**。
 * 删表要走一次 Dexie 迁移，一旦表名清单写错就可能动到用户真实的 progress / daily / checkins
 * 数据；而留着空表既不占空间也不影响启动，所以摘掉读书模块时只删了读写这些表的辅助函数。
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

// v3：读书模块。书籍正文在主进程（userData/books），这里只放「读到哪儿」和标注。
db.version(3).stores({
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
  upTime: 'key, mid, name',
  books: 'id, addedAt, lastReadAt, format',
  bookmarks: '++id, bookId, chapterIndex, at',
  highlights: '++id, bookId, chapterIndex, at'
})

// v4：专注页。每一轮番茄钟（完成或跳过）落一行，用来出「今日/本周专注」统计和历史列表。
db.version(4).stores({
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
  upTime: 'key, mid, name',
  books: 'id, addedAt, lastReadAt, format',
  bookmarks: '++id, bookId, chapterIndex, at',
  highlights: '++id, bookId, chapterIndex, at',
  focus: '++id, day, startedAt, task'
})

// v5：本地字幕。一个分P可以挂多份字幕文件（key = `${bvid}:${cid}:${文件名}`），
// 解析后的 cues 直接存进来，下次打开同一个分P不用再选文件。
db.version(5).stores({
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
  upTime: 'key, mid, name',
  books: 'id, addedAt, lastReadAt, format',
  bookmarks: '++id, bookId, chapterIndex, at',
  highlights: '++id, bookId, chapterIndex, at',
  focus: '++id, day, startedAt, task',
  subs: 'key, bvid, cid, at'
})

// v6：本地视频。只存用户选进来的文件（绝对路径 + 名字/大小）和解析出来的时长/缩略图/上次看到哪儿，
// 视频文件本身一个字节都不动；thumb 是渲染层用 canvas 抽的一帧 dataURL（抽不到就留空）。
db.version(6).stores({
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
  upTime: 'key, mid, name',
  books: 'id, addedAt, lastReadAt, format',
  bookmarks: '++id, bookId, chapterIndex, at',
  highlights: '++id, bookId, chapterIndex, at',
  focus: '++id, day, startedAt, task',
  subs: 'key, bvid, cid, at',
  locals: 'id, path, addedAt, playedAt'
})

// v7：习惯打卡。
//   habits    : 一个习惯一行（名字 / 目标天数 / 提醒时间 / 是否归档）
//   habitLogs : 打过的每一天一行，key = `${habitId}:${date}`（同一天同一习惯天然只有一行）
// 打卡记录不存「连续多少天」，连续/累计/完成率都是渲染时按记录算出来的 —— 免得改一下
// 历史就出现算错的历史值。
db.version(7).stores({
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
  upTime: 'key, mid, name',
  books: 'id, addedAt, lastReadAt, format',
  bookmarks: '++id, bookId, chapterIndex, at',
  highlights: '++id, bookId, chapterIndex, at',
  focus: '++id, day, startedAt, task',
  subs: 'key, bvid, cid, at',
  locals: 'id, path, addedAt, playedAt',
  habits: '++id, name, archived, createdAt',
  habitLogs: 'key, habitId, date'
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

// ---------------- 专注（番茄钟） ----------------

/**
 * 写一行专注记录。
 *   day        'YYYY-MM-DD'（用于按天/按周统计，单独存一列便于索引）
 *   seconds    这一轮实际专注的秒数（跳过时是已专注的部分）
 *   completed  是否自然走完（false = 用户跳过）
 *   task       绑定的任务名 / 视频标题，未绑定为空串
 *   bvid       绑定的学习清单视频（自定义任务为 null）
 */
export async function addFocusSession(rec = {}) {
  const seconds = Math.max(0, Math.round(Number(rec.seconds) || 0))
  const row = {
    day: rec.day || todayKey(),
    startedAt: Number(rec.startedAt) || Date.now(),
    at: Date.now(),
    seconds,
    completed: Boolean(rec.completed),
    task: String(rec.task || ''),
    bvid: rec.bvid || null,
    cover: rec.cover || '',
    mode: rec.mode || 'focus',
    focusMin: Number(rec.focusMin) || 0
  }
  try {
    const id = await db.focus.add(row)
    return { ...row, id }
  } catch (err) {
    console.warn('[focus] 专注记录写入失败：', err && err.message)
    return null
  }
}

/** 最近的专注记录（新的在前），可按天过滤；默认只取最近 40 天 */
export async function listFocusSessions({ limit = 200 } = {}) {
  try {
    const since = Date.now() - 40 * 24 * 60 * 60 * 1000
    const rows = await db.focus.where('startedAt').aboveOrEqual(since).toArray()
    return rows.sort((a, b) => (b.startedAt || b.at || 0) - (a.startedAt || a.at || 0)).slice(0, limit)
  } catch (err) {
    console.warn('[focus] 专注记录读取失败：', err && err.message)
    return []
  }
}

/** 全部专注记录（统计用，量级不大，直接全取） */
export async function allFocusSessions() {
  try {
    return await db.focus.toArray()
  } catch (err) {
    console.warn('[focus] 专注记录读取失败：', err && err.message)
    return []
  }
}

export async function clearFocusSessions() {
  await db.focus.clear()
}

// ---------------- 本地字幕 ----------------

/** 某个分P上挂着的本地字幕文件（按添加时间正序），不含大数组以外的元信息都在 */
export async function listLocalSubs(bvid, cid) {
  try {
    const rows = await db.subs.where('bvid').equals(String(bvid || '')).toArray()
    return rows
      .filter((r) => String(r.cid) === String(cid))
      .sort((a, b) => (a.at || 0) - (b.at || 0))
  } catch (err) {
    console.warn('[sub] 本地字幕读取失败：', err && err.message)
    return []
  }
}

/**
 * 存一份本地字幕。同名文件重复加载会覆盖（key 里带文件名）。
 * rec: { bvid, cid, name, format, count, items: [{from,to,content}] }
 */
export async function putLocalSub(rec = {}) {
  const bvid = String(rec.bvid || '')
  const cid = String(rec.cid || '')
  const name = String(rec.name || '字幕')
  if (!bvid || !cid || !Array.isArray(rec.items) || !rec.items.length) return null
  const row = {
    key: `${bvid}:${cid}:${name}`,
    bvid,
    cid,
    name,
    format: rec.format || 'srt',
    count: rec.items.length,
    items: rec.items,
    at: Date.now()
  }
  try {
    await db.subs.put(row)
    return row
  } catch (err) {
    console.warn('[sub] 本地字幕保存失败：', err && err.message)
    return null
  }
}

export async function removeLocalSub(key) {
  try {
    await db.subs.delete(key)
  } catch (err) {
    console.warn('[sub] 本地字幕删除失败：', err && err.message)
  }
}

// ---------------- 本地视频 ----------------
//
// 一行 = 一个用户选进来的视频文件：
//   { id, path, name, size, mtime, duration, pos, thumb, addedAt, playedAt }
// id 是主进程按绝对路径算的 sha1 前 24 位，因此重启后重新登记拿到的 lmedia:// 地址不变。

/** 本地视频列表：最近播过的排前面，没播过的按加入时间倒序 */
export async function listLocals() {
  try {
    const rows = await db.locals.toArray()
    return rows.sort((a, b) => (b.playedAt || 0) - (a.playedAt || 0) || (b.addedAt || 0) - (a.addedAt || 0))
  } catch (err) {
    console.warn('[local] 本地视频读取失败：', err && err.message)
    return []
  }
}

export async function getLocal(id) {
  try {
    return (await db.locals.get(String(id || ''))) || null
  } catch (err) {
    console.warn('[local] 本地视频读取失败：', err && err.message)
    return null
  }
}

/** 写入/更新一行（只覆盖传进来的字段） */
export async function putLocal(rec = {}) {
  const id = String(rec.id || '')
  if (!id) return null
  try {
    const old = (await db.locals.get(id)) || {}
    const row = { ...old, ...rec, id, addedAt: old.addedAt || rec.addedAt || Date.now() }
    await db.locals.put(row)
    return row
  } catch (err) {
    console.warn('[local] 本地视频保存失败：', err && err.message)
    return null
  }
}

export async function removeLocal(id) {
  try {
    await db.locals.delete(String(id || ''))
  } catch (err) {
    console.warn('[local] 本地视频删除失败：', err && err.message)
  }
}

// ---------------- 习惯打卡 ----------------
//
// habits    : { id, name, targetDays, remindAt, remindOn, note, archived, createdAt }
//   targetDays 目标天数（累计打卡多少天算养成）；remindAt 'HH:MM'；remindOn 是否开提醒；
//   archived 0=坚持中、>0 是归档时间戳（归档的习惯不提醒、不进「今日」统计，但记录都留着）
// habitLogs : { key, habitId, date, at, note }，key = `${habitId}:${date}`

const HABIT_DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 全部习惯：坚持中的在前，各自按创建时间 */
export async function listHabits() {
  try {
    const rows = await db.habits.toArray()
    return rows.sort(
      (a, b) => (Number(a.archived) || 0 ? 1 : 0) - (Number(b.archived) || 0 ? 1 : 0) || (a.createdAt || 0) - (b.createdAt || 0)
    )
  } catch (err) {
    console.warn('[habit] 习惯读取失败：', err && err.message)
    return []
  }
}

export async function getHabit(id) {
  try {
    return (await db.habits.get(Number(id) || 0)) || null
  } catch (err) {
    console.warn('[habit] 习惯读取失败：', err && err.message)
    return null
  }
}

/** 新建/更新一个习惯（只覆盖传进来的字段；名字为空直接拒绝） */
export async function putHabit(rec = {}) {
  const id = Number(rec.id) || 0
  const old = id ? (await db.habits.get(id)) || {} : {}
  const row = {
    ...old,
    name: String(rec.name !== undefined ? rec.name : old.name || '').trim(),
    targetDays: Math.max(1, Math.min(9999, Number(rec.targetDays !== undefined ? rec.targetDays : old.targetDays) || 100)),
    remindAt: /^\d{2}:\d{2}$/.test(String(rec.remindAt !== undefined ? rec.remindAt : old.remindAt || ''))
      ? String(rec.remindAt !== undefined ? rec.remindAt : old.remindAt)
      : '',
    remindOn: Boolean(rec.remindOn !== undefined ? rec.remindOn : old.remindOn),
    note: String(rec.note !== undefined ? rec.note : old.note || ''),
    archived: Number(rec.archived !== undefined ? rec.archived : old.archived) || 0,
    createdAt: Number(old.createdAt) || Number(rec.createdAt) || Date.now()
  }
  if (!row.name) return null
  try {
    if (id) {
      await db.habits.put({ ...row, id })
      return { ...row, id }
    }
    const newId = await db.habits.add(row)
    return { ...row, id: newId }
  } catch (err) {
    console.warn('[habit] 习惯保存失败：', err && err.message)
    return null
  }
}

/** 删习惯连它的打卡记录一起删（不然日志里会留下找不到习惯的孤儿行） */
export async function removeHabit(id) {
  const hid = Number(id) || 0
  if (!hid) return 0
  try {
    const n = await db.habitLogs.where('habitId').equals(hid).delete()
    await db.habits.delete(hid)
    return n
  } catch (err) {
    console.warn('[habit] 习惯删除失败：', err && err.message)
    return 0
  }
}

/** 打卡记录：可只取一段时间（date 是 'YYYY-MM-DD'，字符串比较就是按天比较） */
export async function listHabitLogs({ from = '', to = '', habitId = 0 } = {}) {
  try {
    let rows
    if (from || to) {
      rows = await db.habitLogs.where('date').between(from || '0000-00-00', to || '9999-99-99', true, true).toArray()
    } else {
      rows = await db.habitLogs.toArray()
    }
    const hid = Number(habitId) || 0
    return hid ? rows.filter((r) => Number(r.habitId) === hid) : rows
  } catch (err) {
    console.warn('[habit] 打卡记录读取失败：', err && err.message)
    return []
  }
}

/** 打卡 / 取消打卡（幂等：同一天同一习惯只可能有一行） */
export async function setHabitLog(habitId, date, on, note = '') {
  const hid = Number(habitId) || 0
  const day = String(date || '').slice(0, 10)
  if (!hid || !HABIT_DAY_RE.test(day)) return null
  const key = `${hid}:${day}`
  try {
    if (!on) {
      await db.habitLogs.delete(key)
      return null
    }
    const old = (await db.habitLogs.get(key)) || {}
    const row = { ...old, key, habitId: hid, date: day, at: Number(old.at) || Date.now(), note: String(note || old.note || '') }
    await db.habitLogs.put(row)
    return row
  } catch (err) {
    console.warn('[habit] 打卡写入失败：', err && err.message)
    return null
  }
}

/** 清空所有习惯与记录（习惯页自己的「清空」用，不动学习数据） */
export async function clearHabits() {
  try {
    await db.habitLogs.clear()
    await db.habits.clear()
  } catch (err) {
    console.warn('[habit] 习惯数据清空失败：', err && err.message)
  }
}

export default db
