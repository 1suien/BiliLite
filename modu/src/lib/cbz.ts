import JSZip from 'jszip'

export interface CbzBook {
  pageCount: number
  /** 按自然序排好的 zip 内图片路径 */
  pages: string[]
  /** 第一页缩略图 data URL（用于书架封面），失败可 undefined */
  coverDataUrl?: string
  /** 取第 i 页（0-based）的 object URL（blob:），内部缓存；i 越界时 reject */
  pageUrl(i: number): Promise<string>
}

const IMG_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
}

/** 书架封面宽度上限 */
const COVER_WIDTH = 320
/** blob URL 缓存上限：翻页时只留最近几页，别把整本图都挂在内存里 */
const MAX_CACHED_URLS = 8

function extOf(path: string): string {
  const i = path.lastIndexOf('.')
  return i < 0 ? '' : path.slice(i + 1).toLowerCase()
}

function mimeOf(path: string): string {
  return IMG_MIME[extOf(path)] || 'application/octet-stream'
}

function isPage(path: string): boolean {
  if (path.endsWith('/') || path.startsWith('__MACOSX/')) return false
  const base = path.slice(path.lastIndexOf('/') + 1)
  if (!base || base.startsWith('.')) return false
  return !!IMG_MIME[extOf(base)]
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image decode failed'))
    img.src = url
  })
}

/** 封面缩到 320px 宽再存 base64，书架里不必留原图 */
function downscaleToDataUrl(img: HTMLImageElement): string {
  const scale = Math.min(1, COVER_WIDTH / (img.naturalWidth || COVER_WIDTH))
  const w = Math.max(1, Math.round((img.naturalWidth || COVER_WIDTH) * scale))
  const h = Math.max(1, Math.round((img.naturalHeight || COVER_WIDTH * 1.4) * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no canvas')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)
  return canvas.toDataURL('image/jpeg', 0.72)
}

async function makeCover(blobUrl: string, rawDataUrl: string): Promise<string | undefined> {
  // 没有 canvas / Image 的环境（比如测试里的纯 DOM）直接退回原图
  if (typeof Image === 'undefined' || typeof document === 'undefined') return rawDataUrl
  try {
    const img = await loadImage(blobUrl)
    return downscaleToDataUrl(img)
  } catch {
    return rawDataUrl
  }
}

export async function openCbz(buf: ArrayBuffer): Promise<CbzBook> {
  const zip = await JSZip.loadAsync(buf)

  // 自然序：1.png < 2.png < 10.png，避免按字典序把 10 排到 2 前面
  const pages = Object.keys(zip.files)
    .filter(isPage)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  if (!pages.length) throw new Error('这个 CBZ 里没有图片页')

  const cache = new Map<number, string>()

  async function pageUrl(i: number): Promise<string> {
    if (!Number.isInteger(i) || i < 0 || i >= pages.length) {
      throw new Error(`页码超出范围：${i}`)
    }
    const hit = cache.get(i)
    if (hit) {
      // 命中就挪到队尾，维持 LRU 顺序
      cache.delete(i)
      cache.set(i, hit)
      return hit
    }
    const file = zip.file(pages[i])
    if (!file) throw new Error('CBZ 缺少页面：' + pages[i])
    const bytes = await file.async('uint8array')
    const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mimeOf(pages[i]) }))
    cache.set(i, url)
    while (cache.size > MAX_CACHED_URLS) {
      const oldest = cache.keys().next().value as number
      const oldUrl = cache.get(oldest)
      cache.delete(oldest)
      if (oldUrl) URL.revokeObjectURL(oldUrl)
    }
    return url
  }

  let coverDataUrl: string | undefined
  try {
    const first = zip.file(pages[0])
    if (first) {
      const b64 = await first.async('base64')
      if (b64) {
        const raw = `data:${mimeOf(pages[0])};base64,${b64}`
        // 用第一页的 blob URL 解码，避免超长 data URL 在部分 WebView 里解码失败
        const bytes = await first.async('uint8array')
        const blobUrl = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mimeOf(pages[0]) }))
        try {
          coverDataUrl = await makeCover(blobUrl, raw)
        } finally {
          URL.revokeObjectURL(blobUrl)
        }
      }
    }
  } catch {
    coverDataUrl = undefined
  }

  return { pageCount: pages.length, pages, coverDataUrl, pageUrl }
}
