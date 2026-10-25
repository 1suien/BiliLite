/**
 * 通用格式化工具
 *
 * 对应原构建里 Icon-BMG-uEuU.js（被所有页面 import 的“公共库” chunk）中的工具函数。
 */

/** 万/亿 计数，例如 12345 -> "1.2 万" */
export function formatCount(n: number | string): string {
  const v = Number(n) || 0
  if (v >= 1e8) return (v / 1e8).toFixed(1).replace(/\.0$/, '') + ' 亿'
  if (v >= 1e4) return (v / 1e4).toFixed(1).replace(/\.0$/, '') + ' 万'
  return String(v)
}

/** 秒 -> mm:ss / h:mm:ss */
export function formatClock(sec: number | string): string {
  const v = Math.max(0, Math.floor(Number(sec) || 0))
  const h = Math.floor(v / 3600)
  const m = Math.floor((v % 3600) / 60)
  const s = v % 60
  const p = (x: number) => String(x).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`
}

/** 秒 -> 30m / 2h 5m */
export function formatDuration(sec: number | string): string {
  const v = Math.max(0, Math.floor(Number(sec) || 0))
  if (v <= 0) return '0m'
  let h = Math.floor(v / 3600)
  let m = Math.round((v % 3600) / 60)
  if (m >= 60) {
    h += 1
    m = 0
  }
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${Math.max(1, m)}m`
}

/** "12:34" -> 754；纯数字原样返回 */
export function parseSec(v: number | string): number {
  if (typeof v === 'number') return v
  if (!v) return 0
  return String(v)
    .split(':')
    .map((x) => parseInt(x, 10) || 0)
    .reduce((a, b) => a * 60 + b, 0)
}

/** 时间戳（秒或毫秒）-> YYYY-MM-DD[ HH:mm] */
export function formatDateTime(ts: number, withTime = true): string {
  const v = Number(ts)
  if (!v) return '—'
  const d = new Date(v < 1e12 ? v * 1e3 : v)
  const p = (x: number) => String(x).padStart(2, '0')
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return withTime ? `${day} ${p(d.getHours())}:${p(d.getMinutes())}` : day
}

/** 时间戳 -> 刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期 */
export function relativeTime(ts: number): string {
  const v = Number(ts)
  if (!v) return '—'
  const t = v < 1e12 ? v * 1e3 : v
  const diff = Date.now() - t
  if (diff < 6e4) return '刚刚'
  if (diff < 36e5) return `${Math.floor(diff / 6e4)} 分钟前`
  if (diff < 864e5) return `${Math.floor(diff / 36e5)} 小时前`
  if (diff < 2592e6) return `${Math.floor(diff / 864e5)} 天前`
  return formatDateTime(t, false)
}

/** 今天 YYYY-MM-DD */
export function todayStr(d = new Date()): string {
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 秒 -> 小时（保留 1~2 位小数，用于学习时长展示） */
export function toHours(sec: number | string): string {
  const h = (Number(sec) || 0) / 3600
  return h >= 10 ? h.toFixed(1) : h.toFixed(2)
}

/** HH:mm（提醒时间比较用） */
export function hhmm(d = new Date()): string {
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** YYYY-MM-DD -> Date */
export function parseDay(s: string): Date {
  const [y, m, d] = String(s || '')
    .split('-')
    .map(Number)
  return new Date(y || 1970, (m || 1) - 1, d || 1)
}

/** 日期字符串 + N 天 */
export function addDays(s: string, n: number): string {
  const d = parseDay(s)
  d.setDate(d.getDate() + n)
  return todayStr(d)
}

/** 补零 */
export function pad2(n: number | string): string {
  return String(n).padStart(2, '0')
}
