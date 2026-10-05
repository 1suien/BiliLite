export function fmtCount(n) {
  const v = Number(n) || 0
  if (v >= 100000000) return (v / 100000000).toFixed(1).replace(/\.0$/, '') + ' 亿'
  if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + ' 万'
  return String(v)
}

export function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const p = (x) => String(x).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`
}

/** "MM:SS" / "HH:MM:SS" / "12:34" 文本 → 秒 */
export function parseDuration(text) {
  if (typeof text === 'number') return text
  if (!text) return 0
  const parts = String(text).split(':').map((x) => parseInt(x, 10) || 0)
  return parts.reduce((acc, x) => acc * 60 + x, 0)
}

export function fmtDate(ts, withTime = true) {
  const n = Number(ts)
  if (!n) return '—'
  const d = new Date(n < 1e12 ? n * 1000 : n)
  const p = (x) => String(x).padStart(2, '0')
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return withTime ? `${base} ${p(d.getHours())}:${p(d.getMinutes())}` : base
}

export function fmtAgo(ts) {
  const n = Number(ts)
  if (!n) return '—'
  const t = n < 1e12 ? n * 1000 : n
  const diff = Date.now() - t
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  if (diff < 2592000000) return `${Math.floor(diff / 86400000)} 天前`
  return fmtDate(t, false)
}

export function todayKey(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function fmtHours(seconds) {
  const h = (Number(seconds) || 0) / 3600
  if (h >= 10) return h.toFixed(1)
  return h.toFixed(2)
}
