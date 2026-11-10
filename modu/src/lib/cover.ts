import { hueOf } from './util'

/**
 * 给没有封面图的书写一张「生成封面」：色相由书名决定，
 * 同一本书每次生成的配色一致，书架看起来也整齐。
 */
export function generatedCover(title: string, author = '', hue = hueOf(title)): string {
  const W = 360
  const H = 504
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''

  const h = hue
  const g = ctx.createLinearGradient(0, 0, W * 0.7, H)
  g.addColorStop(0, `hsl(${h}, 26%, 34%)`)
  g.addColorStop(0.55, `hsl(${h}, 22%, 25%)`)
  g.addColorStop(1, `hsl(${h}, 20%, 16%)`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)

  // 一层很淡的纸纹（对角线）
  ctx.strokeStyle = 'rgba(255,255,255,0.035)'
  ctx.lineWidth = 1
  for (let i = -H; i < W; i += 9) {
    ctx.beginPath()
    ctx.moveTo(i, 0)
    ctx.lineTo(i + H, H)
    ctx.stroke()
  }

  // 顶部细线
  ctx.strokeStyle = `hsla(${h}, 45%, 78%, 0.55)`
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(34, 52)
  ctx.lineTo(W - 34, 52)
  ctx.stroke()

  // 书名：按宽度折行
  ctx.fillStyle = 'rgba(248, 243, 233, 0.96)'
  ctx.font = '600 30px "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", serif'
  ctx.textAlign = 'left'
  const maxW = W - 68
  const chars = Array.from(title)
  const lines: string[] = []
  let cur = ''
  for (const ch of chars) {
    if (ctx.measureText(cur + ch).width > maxW && cur) {
      lines.push(cur)
      cur = ch
    } else {
      cur += ch
    }
  }
  if (cur) lines.push(cur)
  const shown = lines.slice(0, 6)
  const lineH = 44
  const blockH = shown.length * lineH + (author ? 46 : 0)
  // 书名整体垂直居中，长书名自动上移
  let y = Math.max(96, Math.round((H - blockH) / 2) + 30)
  ctx.textBaseline = 'alphabetic'
  for (const line of shown) {
    ctx.fillText(line, 34, y)
    y += lineH
  }
  if (lines.length > 6) {
    ctx.fillText('…', 34, y)
    y += lineH
  }

  // 作者
  if (author) {
    ctx.fillStyle = `hsla(${h}, 30%, 86%, 0.72)`
    ctx.font = '400 17px "Songti SC", "Noto Serif CJK SC", serif'
    ctx.fillText(author.length > 12 ? author.slice(0, 12) + '…' : author, 34, y + 18)
  }

  // 底部小标记
  ctx.fillStyle = `hsla(${h}, 40%, 90%, 0.35)`
  ctx.font = '400 13px system-ui, sans-serif'
  ctx.fillText('墨读 · 生成封面', 34, H - 30)

  return canvas.toDataURL('image/jpeg', 0.88)
}

/** 从 dataURL 取二进制长度，用于「是不是真封面」这类判断 */
export function dataUrlBytes(dataUrl: string): number {
  const i = dataUrl.indexOf(',')
  if (i < 0) return 0
  return Math.floor(((dataUrl.length - i - 1) * 3) / 4)
}
