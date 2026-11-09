/**
 * 全量备份（本机 0.4.61）
 *
 * 备份范围：Dexie 的全部业务表 + 设置 + 番茄设置 + 课表当天状态。
 * 不包含登录态（cookie / token）：换机重新扫码即可，避免备份文件泄露账号。
 * 旧版备份（只有 progress / daily / notes / shelf 四类、平铺在顶层）仍可导入。
 */
import db from '@/db'

/** 参与备份的表（顺序即预览里的展示顺序） */
export const BACKUP_TABLES = [
  'progress',
  'daily',
  'marks',
  'notes',
  'shelf',
  'ups',
  'upgroups',
  'collect',
  'collectfolders',
  'checkins',
  'upTime',
  'books',
  'bookmarks',
  'highlights',
  'focus',
  'habits',
  'habitLogs',
  'slots',
  'courses',
  'subs',
  'locals',
] as const

export type BackupTableName = (typeof BACKUP_TABLES)[number]

/** 预览/提示里用的中文名 */
export const BACKUP_LABELS: Record<string, string> = {
  progress: '观看进度',
  daily: '每日时长',
  marks: '视频标记',
  notes: '笔记',
  shelf: '学习清单',
  ups: '关注 UP',
  upgroups: 'UP 分组',
  collect: '收藏',
  collectfolders: '收藏夹',
  checkins: '打卡记录',
  upTime: '追更进度',
  books: '书籍',
  bookmarks: '书签',
  highlights: '划线',
  focus: '专注记录',
  habits: '习惯',
  habitLogs: '习惯记录',
  slots: '课表时段',
  courses: '旧课表',
  subs: '本地字幕',
  locals: '本地视频',
}

const LS_POMODORO = 'study-bili-pomodoro'
const LS_SLOT_STATUS = 'study-bili-slot-status'

export interface BackupPayload {
  app: 'study-bili'
  schema: 2
  version: string
  exportedAt: string
  user?: { mid: number; uname: string } | null
  data: Record<string, any[]>
  prefs: {
    settings?: Record<string, any>
    pomodoro?: Record<string, any>
    slotStatus?: Record<string, any>
  }
  meta: { counts: Record<string, number>; bytes: number }
}

function readLS(key: string): any {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : undefined
  } catch {
    return undefined
  }
}

/** 收集全量数据（settings 由调用方传入，避免 store 循环依赖） */
export async function collectBackup(opts: {
  version: string
  settings?: Record<string, any>
  user?: { mid: number; uname: string } | null
}): Promise<BackupPayload> {
  const data: Record<string, any[]> = {}
  const counts: Record<string, number> = {}
  for (const name of BACKUP_TABLES) {
    const table = (db as any)[name]
    if (!table) continue
    const rows = await table.toArray()
    data[name] = rows
    counts[name] = rows.length
  }
  const prefs: BackupPayload['prefs'] = {}
  if (opts.settings && typeof opts.settings === 'object') {
    prefs.settings = JSON.parse(JSON.stringify(opts.settings))
  }
  const pomodoro = readLS(LS_POMODORO)
  if (pomodoro) prefs.pomodoro = pomodoro
  const slotStatus = readLS(LS_SLOT_STATUS)
  if (slotStatus) prefs.slotStatus = slotStatus

  const payload: BackupPayload = {
    app: 'study-bili',
    schema: 2,
    version: opts.version,
    exportedAt: new Date().toISOString(),
    user: opts.user || null,
    data,
    prefs,
    meta: { counts, bytes: 0 },
  }
  payload.meta.bytes = JSON.stringify(payload).length
  return payload
}

/** 兼容旧格式：schema 1 的四类数据平铺在顶层 */
export function normalizePayload(payload: any): {
  schema: number
  data: Record<string, any[]>
  prefs: BackupPayload['prefs']
} {
  if (!payload || typeof payload !== 'object') return { schema: 0, data: {}, prefs: {} }
  if (payload.schema >= 2 || payload.data) {
    const data: Record<string, any[]> = {}
    const src = payload.data || {}
    for (const name of BACKUP_TABLES) {
      if (Array.isArray(src[name])) data[name] = src[name]
    }
    return { schema: Number(payload.schema) || 2, data, prefs: payload.prefs || {} }
  }
  // schema 1：顶层 progress/daily/notes/shelf
  const data: Record<string, any[]> = {}
  for (const name of ['progress', 'daily', 'notes', 'shelf'] as const) {
    if (Array.isArray(payload[name])) data[name] = payload[name]
  }
  return { schema: 1, data, prefs: {} }
}

/** 预览：每张表的条数与偏好项数 */
export function describeBackup(payload: any): {
  schema: number
  rows: { name: string; label: string; count: number }[]
  total: number
  prefs: string[]
  hasData: boolean
} {
  const { schema, data, prefs } = normalizePayload(payload)
  const rows = BACKUP_TABLES.filter((n) => Array.isArray(data[n]) && data[n].length > 0).map((n) => ({
    name: n,
    label: BACKUP_LABELS[n] || n,
    count: data[n].length,
  }))
  const prefsKeys: string[] = []
  if (prefs.settings && Object.keys(prefs.settings).length) prefsKeys.push('设置')
  if (prefs.pomodoro) prefsKeys.push('番茄设置')
  if (prefs.slotStatus) prefsKeys.push('课表状态')
  const total = rows.reduce((sum, r) => sum + r.count, 0)
  return { schema, rows, total, prefs: prefsKeys, hasData: rows.length > 0 || prefsKeys.length > 0 }
}

function pickStamp(row: any): number {
  if (!row || typeof row !== 'object') return 0
  return (
    Number(row.updatedAt) ||
    Number(row.at) ||
    Number(row.readAt) ||
    Number(row.lastReadAt) ||
    Number(row.createdAt) ||
    Number(row.addedAt) ||
    0
  )
}

/** 合并一张表 */
async function mergeTable(name: string, rows: any[], mode: 'merge' | 'replace'): Promise<number> {
  const table = (db as any)[name]
  if (!table || !Array.isArray(rows) || !rows.length) return 0
  if (mode === 'replace') {
    await table.clear()
    await table.bulkPut(rows)
    return rows.length
  }
  if (name === 'notes') {
    const exist = await table.toArray()
    const seen = new Set(
      exist.map(
        (n: any) => `${String(n.bvid)}|${Number(n.cid) || 0}|${Number(n.at) || 0}|${String(n.text || '')}`,
      ),
    )
    let addedNotes = 0
    for (const row of rows) {
      if (!row || !row.bvid) continue
      const stamp = `${String(row.bvid)}|${Number(row.cid) || 0}|${Number(row.at) || 0}|${String(row.text || '')}`
      if (seen.has(stamp)) continue
      const copy: any = { ...row }
      delete copy.id
      await table.add(copy)
      seen.add(stamp)
      addedNotes++
    }
    return addedNotes
  }
  const schema = table.schema
  const keyPath = schema && schema.primKey ? schema.primKey.keyPath : null
  const pk: string | null = typeof keyPath === 'string' ? keyPath : null
  let added = 0
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const key = pk ? row[pk] : undefined
    if (pk && (key === undefined || key === null)) continue
    const old: any = pk ? await table.get(key) : undefined
    if (!old) {
      await table.put(row)
      added++
      continue
    }
    if (name === 'daily') {
      const next = {
        ...old,
        seconds: Math.max(Number(old.seconds) || 0, Number(row.seconds) || 0),
        videos: Math.max(Number(old.videos) || 0, Number(row.videos) || 0),
      }
      if (next.seconds !== old.seconds || next.videos !== old.videos) {
        await table.put(next)
        added++
      }
      continue
    }
    const stampNew = pickStamp(row)
    const stampOld = pickStamp(old)
    // 旧记录没有时间戳：保留本地（避免把本机数据盖掉）
    if (stampNew && (!stampOld || stampNew > stampOld)) {
      await table.put(row)
      added++
    }
  }
  return added
}

/** 应用备份：默认合并；replace 会先清空（调用方需二次确认） */
export async function applyBackup(
  payload: any,
  mode: 'merge' | 'replace' = 'merge',
): Promise<{ added: Record<string, number>; total: number }> {
  const { data } = normalizePayload(payload)
  const added: Record<string, number> = {}
  let total = 0
  for (const name of BACKUP_TABLES) {
    const rows = data[name]
    if (!rows || !rows.length) continue
    try {
      const n = await mergeTable(name, rows, mode)
      if (n > 0) added[name] = n
      total += n
    } catch (e: any) {
      console.warn('[backup] 合并失败', name, e && e.message)
    }
  }
  return { added, total }
}

/** 应用 prefs：设置只补缺失项（覆盖模式才整体替换），番茄/课表状态做对象合并 */
export function applyBackupPrefs(
  payload: any,
  mode: 'merge' | 'replace' = 'merge',
): { settingsPatch: Record<string, any>; keys: string[] } {
  const { prefs } = normalizePayload(payload)
  const keys: string[] = []
  const settingsPatch: Record<string, any> = {}
  if (prefs.settings && typeof prefs.settings === 'object') {
    for (const [k, v] of Object.entries(prefs.settings)) {
      settingsPatch[k] = v
    }
    keys.push('设置')
  }
  if (prefs.pomodoro && typeof prefs.pomodoro === 'object') {
    const cur = readLS(LS_POMODORO) || {}
    localStorage.setItem(LS_POMODORO, JSON.stringify({ ...prefs.pomodoro, ...cur }))
    keys.push('番茄设置')
  }
  if (prefs.slotStatus && typeof prefs.slotStatus === 'object') {
    const cur = readLS(LS_SLOT_STATUS) || {}
    const merged: Record<string, any> = { ...cur }
    for (const [day, val] of Object.entries(prefs.slotStatus)) {
      merged[day] = { ...(val as any), ...(merged[day] || {}) }
    }
    localStorage.setItem(LS_SLOT_STATUS, JSON.stringify(merged))
    keys.push('课表状态')
  }
  void mode
  return { settingsPatch, keys }
}
