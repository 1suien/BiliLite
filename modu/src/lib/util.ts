export function uid(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

/** 由标题算一个稳定色相，用来给没有封面的书生成封面配色 */
export function hueOf(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) % 360
  }
  return h
}

export function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB'
  return bytes + ' B'
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** 去掉文件名里的扩展名，作为默认书名 */
export function titleFromFilename(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || name
}
