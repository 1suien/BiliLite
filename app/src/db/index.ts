/**
 * 本地数据库（Dexie / IndexedDB）
 *
 * 还原自构建产物里的 `new Dexie('study-bili')`：版本 1 ~ 7 的 schema 演进被完整保留，
 * 数据库名与表名必须与原 APK 一致，否则用户升级后会丢数据。
 */
import Dexie, { type Table } from 'dexie'
import type {
  CollectItem,
  DailyRecord,
  FocusSession,
  Habit,
  HabitLog,
  Course,
  ScheduleSlot,
  LocalSub,
  LocalVideo,
  ProgressRecord,
  ShelfItem,
  UpItem,
  UpTimeRecord,
} from '@/types'
import { todayStr } from '@/utils/format'

export interface BookRecord {
  id: string
  addedAt?: number
  lastReadAt?: number
  format?: string
  [key: string]: any
}

export interface MarkRecord {
  id?: number
  bvid: string
  cid: number
  sec: number
  [key: string]: any
}

export interface NoteRecord {
  id?: number
  bvid: string
  cid: number
  at: number
  [key: string]: any
}

export interface CheckinRecord {
  date: string
  at?: number
}

export interface BookmarkRecord {
  id?: number
  bookId: string
  chapterIndex: number
  at: number
}

export interface HighlightRecord {
  id?: number
  bookId: string
  chapterIndex: number
  at: number
}

export interface UpGroupRecord {
  name: string
  at: number
}

export interface CollectFolderRecord {
  name: string
  at: number
}

export class BiliLiteDB extends Dexie {
  progress!: Table<ProgressRecord, string>
  daily!: Table<DailyRecord, string>
  marks!: Table<MarkRecord, number>
  notes!: Table<NoteRecord, number>
  shelf!: Table<ShelfItem, string>
  ups!: Table<UpItem, number>
  upgroups!: Table<UpGroupRecord, string>
  collect!: Table<CollectItem, number>
  collectfolders!: Table<CollectFolderRecord, string>
  checkins!: Table<CheckinRecord, string>
  upTime!: Table<UpTimeRecord, string>
  books!: Table<BookRecord, string>
  bookmarks!: Table<BookmarkRecord, number>
  highlights!: Table<HighlightRecord, number>
  focus!: Table<FocusSession, number>
  subs!: Table<LocalSub, string>
  locals!: Table<LocalVideo, string>
  habits!: Table<Habit, number>
  habitLogs!: Table<HabitLog, string>
  /** 本机定制 0.4.12：课表 */
  courses!: Table<Course, number>
  slots!: Table<ScheduleSlot, number>

  constructor() {
    super('study-bili')

    this.version(1).stores({
      progress: 'key, bvid, updatedAt, completed',
      daily: 'date',
      marks: '++id, bvid, cid, sec',
      notes: '++id, bvid, cid, at',
      shelf: 'bvid, at',
    })
    this.version(2).stores({
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
    })
    this.version(3).stores({
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
    })
    this.version(4).stores({
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
    })
    this.version(5).stores({
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
    })
    this.version(6).stores({
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
    })
    this.version(7).stores({
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
      habitLogs: 'key, habitId, date',
    })
    // 本机定制 0.4.12：新增课表
    this.version(8).stores({
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
      habitLogs: 'key, habitId, date',
      courses: '++id, weekday, start',
    })
    // 本机定制 0.4.14：课表只保留「提醒时间」，旧字段 start/end/location/teacher 不再使用
    this.version(9).stores({
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
      habitLogs: 'key, habitId, date',
      courses: '++id, weekday, remindAt',
    })
    // 本机定制 0.4.29：课表改「时间块」（做什么 + 学习/休息 + 起止 + 星期可多选），新增 slots 表
    this.version(10).stores({
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
      habitLogs: 'key, habitId, date',
      courses: '++id, weekday, remindAt',
      slots: '++id, kind, start, *days',
    })
  }
}

export const db = new BiliLiteDB()

/* ------------------------------- 学习进度 ------------------------------- */

export async function getProgress(bvid: string, cid: number | string) {
  return db.progress.get(`${bvid}:${cid}`)
}

export async function getAllProgress() {
  return db.progress.toArray()
}

export async function putProgress(p: ProgressRecord) {
  const rec = { ...p, key: `${p.bvid}:${p.cid}`, updatedAt: Date.now() }
  await db.progress.put(rec)
  return rec
}

export async function addDailySeconds(date: string, sec: number) {
  const rec = (await db.daily.get(date)) || { date, seconds: 0, videos: 0 }
  rec.seconds = Math.max(0, (rec.seconds || 0) + sec)
  await db.daily.put(rec)
  return rec
}

export async function bumpDailyVideo(date: string) {
  const rec = (await db.daily.get(date)) || { date, seconds: 0, videos: 0 }
  rec.videos = (rec.videos || 0) + 1
  await db.daily.put(rec)
}

/** 最近 n 天（补零，方便直接画图） */
export async function getDailyRange(n = 30): Promise<DailyRecord[]> {
  const all = await db.daily.toArray()
  const map = new Map(all.map((x) => [x.date, x]))
  const out: DailyRecord[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const key = todayStr(d)
    const hit = map.get(key)
    out.push({ date: key, seconds: hit?.seconds || 0, videos: hit?.videos || 0 })
  }
  return out
}

/* -------------------------------- 打卡 -------------------------------- */

export async function getCheckins(): Promise<string[]> {
  const rows = await db.checkins.toArray()
  return rows.map((r) => r.date)
}

export async function putCheckin(date: string) {
  await db.checkins.put({ date, at: Date.now() })
  return date
}

/* ------------------------------ UP 学习时长 ------------------------------ */

export async function addUpSeconds(up: { mid?: number | null; name?: string }, sec: number) {
  if (!up || !sec) return null
  const key = String(up.mid || up.name || 'unknown')
  const rec = (await db.upTime.get(key)) || {
    key,
    mid: up.mid || null,
    name: up.name || '未知 UP',
    seconds: 0,
  }
  rec.seconds = Math.max(0, (rec.seconds || 0) + sec)
  if (up.name) rec.name = up.name
  await db.upTime.put(rec)
  return rec
}

export async function getUpTime() {
  return db.upTime.toArray()
}

/* -------------------------------- 专注 -------------------------------- */

export async function addFocusSession(p: Partial<FocusSession> = {}) {
  const sec = Math.max(0, Math.round(Number(p.seconds) || 0))
  const rec: Omit<FocusSession, 'id'> = {
    day: p.day || todayStr(),
    startedAt: Number(p.startedAt) || Date.now(),
    at: Date.now(),
    seconds: sec,
    completed: !!p.completed,
    task: String(p.task || ''),
    bvid: p.bvid || null,
    cover: p.cover || '',
    mode: p.mode || 'focus',
    focusMin: Number(p.focusMin) || 0,
  }
  try {
    const id = await db.focus.add(rec as FocusSession)
    return { ...rec, id }
  } catch (e: any) {
    console.warn('[focus] 专注记录写入失败：', e && e.message)
    return null
  }
}

/** 近 40 天（3456e6ms）的专注记录，倒序 */
export async function listFocusSessions({ limit = 200 } = {}) {
  try {
    const from = Date.now() - 3456e6
    const rows = await db.focus.where('startedAt').aboveOrEqual(from).toArray()
    return rows.sort((a, b) => (b.startedAt || b.at || 0) - (a.startedAt || a.at || 0)).slice(0, limit)
  } catch (e: any) {
    console.warn('[focus] 专注记录读取失败：', e && e.message)
    return []
  }
}

export async function allFocusSessions() {
  try {
    return await db.focus.toArray()
  } catch (e: any) {
    console.warn('[focus] 专注记录读取失败：', e && e.message)
    return []
  }
}

export async function clearFocusSessions() {
  await db.focus.clear()
}

/* ------------------------------- 本地字幕 ------------------------------- */

export async function listLocalSubs(bvid: string, cid: number | string) {
  try {
    const rows = await db.subs.where('bvid').equals(String(bvid || '')).toArray()
    return rows
      .filter((x) => String(x.cid) === String(cid))
      .sort((a, b) => (a.at || 0) - (b.at || 0))
  } catch (e: any) {
    console.warn('[sub] 本地字幕读取失败：', e && e.message)
    return []
  }
}

export async function putLocalSub(p: Partial<LocalSub>) {
  const bvid = String(p.bvid || '')
  const cid = String(p.cid || '')
  const name = String(p.name || '字幕')
  if (!bvid || !cid || !Array.isArray(p.items) || !p.items.length) return null
  const rec: LocalSub = {
    key: `${bvid}:${cid}:${name}`,
    bvid,
    cid,
    name,
    format: p.format || 'srt',
    count: p.items.length,
    items: p.items,
    at: Date.now(),
  }
  try {
    await db.subs.put(rec)
    return rec
  } catch (e: any) {
    console.warn('[sub] 本地字幕保存失败：', e && e.message)
    return null
  }
}

export async function removeLocalSub(key: string) {
  try {
    await db.subs.delete(key)
  } catch (e: any) {
    console.warn('[sub] 本地字幕删除失败：', e && e.message)
  }
}

/* ------------------------------- 本地视频 ------------------------------- */

export async function listLocals(): Promise<LocalVideo[]> {
  try {
    const rows = await db.locals.toArray()
    return rows.sort((a, b) => (b.playedAt || 0) - (a.playedAt || 0) || (b.addedAt || 0) - (a.addedAt || 0))
  } catch (e: any) {
    console.warn('[local] 本地视频读取失败：', e && e.message)
    return []
  }
}

export async function getLocal(id: string) {
  try {
    return (await db.locals.get(String(id || ''))) || null
  } catch (e: any) {
    console.warn('[local] 本地视频读取失败：', e && e.message)
    return null
  }
}

export async function putLocal(p: Partial<LocalVideo>) {
  const id = String(p.id || '')
  if (!id) return null
  try {
    const old = (await db.locals.get(id)) || ({} as LocalVideo)
    const rec = { ...old, ...p, id, addedAt: old.addedAt || p.addedAt || Date.now() }
    await db.locals.put(rec as LocalVideo)
    return rec
  } catch (e: any) {
    console.warn('[local] 本地视频保存失败：', e && e.message)
    return null
  }
}

export async function removeLocal(id: string) {
  try {
    await db.locals.delete(String(id || ''))
  } catch (e: any) {
    console.warn('[local] 本地视频删除失败：', e && e.message)
  }
}

/* -------------------------------- 习惯 -------------------------------- */

export async function listHabits(): Promise<Habit[]> {
  try {
    const rows = await db.habits.toArray()
    return rows.sort(
      (a, b) =>
        (Number(a.archived) ? 1 : 0) - (Number(b.archived) ? 1 : 0) ||
        (a.createdAt || 0) - (b.createdAt || 0),
    )
  } catch (e: any) {
    console.warn('[habit] 习惯读取失败：', e && e.message)
    return []
  }
}

export async function getHabit(id: number) {
  try {
    return (await db.habits.get(Number(id) || 0)) || null
  } catch (e: any) {
    console.warn('[habit] 习惯读取失败：', e && e.message)
    return null
  }
}

/** 新建或更新习惯；名称为空返回 null */
export async function putHabit(p: Partial<Habit> = {}) {
  const id = Number(p.id) || 0
  const old: Partial<Habit> = id ? (await db.habits.get(id)) || {} : {}
  const rec = {
    ...old,
    name: String(p.name !== undefined ? p.name : old.name || '').trim(),
    targetDays: Math.max(1, Math.min(9999, Number(p.targetDays !== undefined ? p.targetDays : old.targetDays) || 100)),
    remindAt: /^\d{2}:\d{2}$/.test(String(p.remindAt !== undefined ? p.remindAt : old.remindAt || ''))
      ? String(p.remindAt !== undefined ? p.remindAt : old.remindAt)
      : '',
    remindOn: !!(p.remindOn !== undefined ? p.remindOn : old.remindOn),
    note: String(p.note !== undefined ? p.note : old.note || ''),
    archived: Number(p.archived !== undefined ? p.archived : old.archived) || 0,
    createdAt: Number(old.createdAt) || Number(p.createdAt) || Date.now(),
  }
  if (!rec.name) return null
  try {
    if (id) {
      await db.habits.put({ ...rec, id })
      return { ...rec, id }
    }
    const newId = await db.habits.add(rec as Habit)
    return { ...rec, id: newId }
  } catch (e: any) {
    console.warn('[habit] 习惯保存失败：', e && e.message)
    return null
  }
}

export async function removeHabit(id: number) {
  const n = Number(id) || 0
  if (!n) return 0
  try {
    const deleted = await db.habitLogs.where('habitId').equals(n).delete()
    await db.habits.delete(n)
    return deleted
  } catch (e: any) {
    console.warn('[habit] 习惯删除失败：', e && e.message)
    return 0
  }
}

export async function listHabitLogs({ from = '', to = '', habitId = 0 } = {}) {
  try {
    let rows: HabitLog[]
    if (from || to) {
      rows = await db.habitLogs.where('date').between(from || '0000-00-00', to || '9999-99-99', true, true).toArray()
    } else {
      rows = await db.habitLogs.toArray()
    }
    const hid = Number(habitId) || 0
    return hid ? rows.filter((x) => Number(x.habitId) === hid) : rows
  } catch (e: any) {
    console.warn('[habit] 打卡记录读取失败：', e && e.message)
    return []
  }
}

/** 设置/取消某天打卡（done=false 时删除记录） */
export async function setHabitLog(habitId: number, date: string, done: boolean, note = '') {
  const hid = Number(habitId) || 0
  const day = String(date || '').slice(0, 10)
  if (!hid || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const key = `${hid}:${day}`
  try {
    if (!done) {
      await db.habitLogs.delete(key)
      return null
    }
    const old = (await db.habitLogs.get(key)) || ({} as HabitLog)
    const rec: HabitLog = {
      ...old,
      key,
      habitId: hid,
      date: day,
      at: Number(old.at) || Date.now(),
      note: String(note || old.note || ''),
    }
    await db.habitLogs.put(rec)
    return rec
  } catch (e: any) {
    console.warn('[habit] 打卡写入失败：', e && e.message)
    return null
  }
}

export async function clearHabits() {
  try {
    await db.habitLogs.clear()
    await db.habits.clear()
  } catch (e: any) {
    console.warn('[habit] 习惯数据清空失败：', e && e.message)
  }
}

/* ------------------------------- 课表（本机定制 0.4.12，0.4.14 精简） ------------------------------- */

const HHMM_RE = /^\d{2}:\d{2}$/

/** 旧数据只有 start（起止时间），新版只认 remindAt：读的时候给个兜底 */
function remindAtOf(row: any): string {
  if (HHMM_RE.test(String(row && row.remindAt))) return String(row.remindAt)
  if (HHMM_RE.test(String(row && row.start))) return String(row.start)
  return '08:00'
}

export async function listCourses(): Promise<Course[]> {
  try {
    const rows = await db.courses.toArray()
    const list = rows.map((r: any) => ({ ...r, remindAt: remindAtOf(r) })) as Course[]
    return list.sort((a, b) => (Number(a.weekday) - Number(b.weekday)) || a.remindAt.localeCompare(b.remindAt))
  } catch (e: any) {
    console.warn('[course] 课表读取失败：', e && e.message)
    return []
  }
}

export async function putCourse(p: Partial<Course> = {}) {
  const name = String(p.name || '').trim()
  if (!name) return null
  const weekday = Math.min(7, Math.max(1, Number(p.weekday) || 1))
  const remindAt = HHMM_RE.test(String(p.remindAt || '')) ? String(p.remindAt) : '08:00'
  const rec: Course = {
    id: Number(p.id) || 0,
    name: name.slice(0, 40),
    weekday,
    remindAt,
    color: String(p.color || 'blue'),
    targetName: String(p.targetName || ''),
    bvid: String(p.bvid || ''),
    videoTitle: String(p.videoTitle || ''),
    remindOn: !!p.remindOn,
    note: String(p.note || '').slice(0, 200),
    createdAt: Number(p.createdAt) || Date.now(),
  }
  try {
    if (rec.id) {
      await db.courses.put(rec)
      return rec
    }
    // 新增时必须不带 id 字段：带 id: 0 会被 Dexie 当成显式主键写进去，之后一直拿不到自增 id
    const { id: _drop, ...rest } = rec
    const id = await db.courses.add(rest as Course)
    return { ...rec, id: Number(id) }
  } catch (e: any) {
    console.warn('[course] 课表保存失败：', e && e.message)
    return null
  }
}

export async function removeCourse(id: number) {
  const n = Number(id) || 0
  if (!n) return false
  try {
    await db.courses.delete(n)
    return true
  } catch (e: any) {
    console.warn('[course] 课表删除失败：', e && e.message)
    return false
  }
}

export async function clearCourses() {
  try {
    await db.courses.clear()
  } catch (e: any) {
    console.warn('[course] 课表清空失败：', e && e.message)
  }
}

/** ---------------- 课表时段（本机构建 0.4.29） ---------------- */

function hhmmNum(v: any): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim())
  if (!m) return -1
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return -1
  return h * 60 + mi
}

function numToHHMM(min: number): string {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)))
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

function normDays(v: any): number[] {
  const arr = Array.isArray(v) ? v : [v]
  const out = arr
    .map((x) => Math.round(Number(x)))
    .filter((x) => x >= 1 && x <= 7)
  return Array.from(new Set(out)).sort((a, b) => a - b)
}

export async function listSlots(): Promise<ScheduleSlot[]> {
  try {
    const rows = await db.slots.toArray()
    return (rows as ScheduleSlot[]).sort((a, b) => (a.start || '').localeCompare(b.start || ''))
  } catch (e: any) {
    console.warn('[slot] 课表读取失败：', e && e.message)
    return []
  }
}

export async function putSlot(p: Partial<ScheduleSlot> = {}) {
  const name = String(p.name || '').trim()
  const start = numToHHMM(hhmmNum(p.start))
  const end = numToHHMM(hhmmNum(p.end))
  if (!name || hhmmNum(p.start) < 0 || hhmmNum(p.end) < 0 || end <= start) return null
  const days = normDays(p.days && (p.days as number[]).length ? p.days : [1])
  if (!days.length) return null
  const rec: ScheduleSlot = {
    id: Number(p.id) || 0,
    name: name.slice(0, 40),
    kind: p.kind === 'break' ? 'break' : 'study',
    start,
    end,
    days,
    color: String(p.color || 'blue'),
    targetName: String(p.targetName || ''),
    bvid: String(p.bvid || ''),
    videoTitle: String(p.videoTitle || ''),
    remindOn: !!p.remindOn,
    remindLead: Math.max(0, Math.min(60, Math.round(Number(p.remindLead) || 0))),
    note: String(p.note || '').slice(0, 200),
    createdAt: Number(p.createdAt) || Date.now(),
  }
  try {
    if (rec.id) {
      await db.slots.put(rec)
      return rec
    }
    const { id: _drop, ...rest } = rec
    const id = await db.slots.add(rest as ScheduleSlot)
    return { ...rec, id: Number(id) }
  } catch (e: any) {
    console.warn('[slot] 课表保存失败：', e && e.message)
    return null
  }
}

export async function removeSlot(id: number) {
  const n = Number(id) || 0
  if (!n) return false
  try {
    await db.slots.delete(n)
    return true
  } catch (e: any) {
    console.warn('[slot] 课表删除失败：', e && e.message)
    return false
  }
}

export async function clearSlots() {
  try {
    await db.slots.clear()
  } catch (e: any) {
    console.warn('[slot] 课表清空失败：', e && e.message)
  }
}

/**
 * 0.4.29 迁移：旧版 courses（名字 + 星期 + 提醒时间）→ 时段
 * 没有起止时间，就按「提醒时间开始、45 分钟后结束」来搬，颜色 / 关联 / 备注原样保留。
 */
export async function migrateCoursesToSlots(): Promise<number> {
  try {
    const rows = (await db.courses.toArray()) as any[]
    if (!rows || !rows.length) return 0
    const exist = await db.slots.count()
    if (exist > 0) return 0
    let n = 0
    for (const c of rows) {
      const remindAt = /^\d{1,2}:\d{2}$/.test(String((c && c.remindAt) || (c && c.start))) ? String(c.remindAt || c.start) : '08:00'
      const a = hhmmNum(remindAt)
      if (a < 0) continue
      await db.slots.add({
        name: String(c.name || '课程').slice(0, 40),
        kind: 'study',
        start: numToHHMM(a),
        end: numToHHMM(a + 45),
        days: normDays([Number(c.weekday) || 1]),
        color: String(c.color || 'blue'),
        targetName: String(c.targetName || ''),
        bvid: String(c.bvid || ''),
        videoTitle: String(c.videoTitle || ''),
        remindOn: c.remindOn === undefined ? true : !!c.remindOn,
        remindLead: 5,
        note: String(c.note || ''),
        createdAt: Number(c.createdAt) || Date.now(),
      } as ScheduleSlot)
      n++
    }
    return n
  } catch (e: any) {
    console.warn('[slot] 旧课表迁移失败：', e && e.message)
    return 0
  }
}

/** 与原构建一致的默认导出（页面里通过 * as dbModule 使用） */
export default db
