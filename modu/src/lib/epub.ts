import JSZip from 'jszip'
import type { EpubTocEntry } from '@/db'

export interface EpubParsed {
  title: string
  author: string
  spine: { href: string; title: string }[]
  toc: EpubTocEntry[]
  coverDataUrl?: string
}

interface ManifestItem {
  id: string
  href: string
  mediaType: string
  properties: string
}

function allLocal(root: Document | Element, local: string): Element[] {
  const nodes = (root as Element).getElementsByTagName('*')
  const out: Element[] = []
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].localName === local) out.push(nodes[i])
  }
  return out
}

function firstLocal(root: Document | Element, local: string): Element | undefined {
  return allLocal(root, local)[0]
}

function textOf(el: Element | undefined): string {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim()
}

/** 目录/清单里的路径都是相对路径，统一归一化成 zip 内的绝对路径 */
export function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i + 1)
}

export function resolvePath(baseDir: string, rel: string): string {
  let r = rel.split('#')[0].trim()
  try {
    r = decodeURIComponent(r)
  } catch {
    /* 保持原样 */
  }
  if (r.startsWith('/')) return r.replace(/^\/+/, '')
  const parts = (baseDir + r).split('/')
  const out: string[] = []
  for (const p of parts) {
    if (!p || p === '.') continue
    if (p === '..') out.pop()
    else out.push(p)
  }
  return out.join('/')
}

function stripHash(href: string): string {
  return href.split('#')[0]
}

function extOf(path: string): string {
  const i = path.lastIndexOf('.')
  return i < 0 ? '' : path.slice(i + 1).toLowerCase()
}

const IMG_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
}

export function imageMime(path: string): string {
  return IMG_MIME[extOf(path)] || 'application/octet-stream'
}

export async function loadEpubZip(buf: ArrayBuffer): Promise<JSZip> {
  return JSZip.loadAsync(buf)
}

/** 在 zip 里找文件（兼容 href 的 URI 编码差异） */
function zipFile(zip: JSZip, path: string) {
  return (
    zip.file(path) ||
    (() => {
      try {
        return zip.file(decodeURIComponent(path))
      } catch {
        return null
      }
    })() ||
    null
  )
}

async function imageDataUrl(zip: JSZip, path: string): Promise<string | undefined> {
  const f = zipFile(zip, path)
  if (!f) return undefined
  const mime = imageMime(path)
  try {
    const bytes = await f.async('uint8array')
    const blobUrl = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }))
    const img = await loadImage(blobUrl)
    URL.revokeObjectURL(blobUrl)
    return downscaleToDataUrl(img)
  } catch {
    try {
      const b64 = await f.async('base64')
      return `data:${mime};base64,${b64}`
    } catch {
      return undefined
    }
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image decode failed'))
    img.src = url
  })
}

/** 封面缩到 360px 宽再存 base64，避免书架里塞几 MB 的原图 */
function downscaleToDataUrl(img: HTMLImageElement): string {
  const targetW = 360
  const scale = Math.min(1, targetW / (img.naturalWidth || targetW))
  const w = Math.max(1, Math.round((img.naturalWidth || targetW) * scale))
  const h = Math.max(1, Math.round((img.naturalHeight || targetW * 1.4) * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no canvas')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)
  return canvas.toDataURL('image/jpeg', 0.86)
}

export async function parseEpub(buf: ArrayBuffer): Promise<EpubParsed> {
  const zip = await loadEpubZip(buf)

  const containerFile = zip.file('META-INF/container.xml')
  if (!containerFile) throw new Error('不是有效的 EPUB（缺少 META-INF/container.xml）')
  const containerDoc = new DOMParser().parseFromString(await containerFile.async('string'), 'application/xml')
  const rootfile = firstLocal(containerDoc, 'rootfile')
  const opfPath = (rootfile?.getAttribute('full-path') || '').replace(/^\/+/, '')
  if (!opfPath) throw new Error('不是有效的 EPUB（container.xml 里没有 rootfile）')

  const opfFile = zipFile(zip, opfPath)
  if (!opfFile) throw new Error('EPUB 内容缺失：' + opfPath)
  const opf = new DOMParser().parseFromString(await opfFile.async('string'), 'application/xml')
  const opfDir = dirOf(opfPath)

  // --- 元数据 ---
  const metadata = firstLocal(opf, 'metadata')
  let title = textOf(firstLocal(metadata || opf, 'title'))
  let author = textOf(firstLocal(metadata || opf, 'creator'))

  // --- manifest / spine ---
  const manifest: ManifestItem[] = allLocal(opf, 'item')
    .map((el) => ({
      id: el.getAttribute('id') || '',
      href: el.getAttribute('href') || '',
      mediaType: el.getAttribute('media-type') || '',
      properties: el.getAttribute('properties') || '',
    }))
    .filter((i) => i.id && i.href)

  const byId = new Map(manifest.map((i) => [i.id, i]))
  const spineItems = allLocal(opf, 'itemref')
    .map((el) => byId.get(el.getAttribute('idref') || ''))
    .filter((i): i is ManifestItem => !!i)

  // --- 目录：优先 EPUB3 nav，其次 EPUB2 ncx ---
  let toc: { title: string; href: string; level: number }[] = []

  const navItem = manifest.find((i) => i.properties.split(/\s+/).includes('nav'))
  if (navItem) {
    const navFile = zipFile(zip, resolvePath(opfDir, navItem.href))
    if (navFile) {
      const navDoc = new DOMParser().parseFromString(await navFile.async('string'), 'text/html')
      const navs = Array.from(navDoc.querySelectorAll('nav'))
      const nav =
        navs.find((n) => /toc/i.test(n.getAttribute('epub:type') || '')) || navs[0] || navDoc.body
      const anchors = Array.from(nav.querySelectorAll('a[href]'))
      const navDir = dirOf(resolvePath(opfDir, navItem.href))
      for (const a of anchors) {
        const href = a.getAttribute('href') || ''
        const label = (a.textContent || '').replace(/\s+/g, ' ').trim()
        if (!href || !label) continue
        let level = 0
        let p: Element | null = a.parentElement
        while (p) {
          if (p.localName === 'ol' || p.localName === 'ul') level++
          p = p.parentElement
        }
        toc.push({ title: label, href: resolvePath(navDir, href), level: Math.max(0, level - 1) })
      }
    }
  }

  if (!toc.length) {
    const ncxItem =
      manifest.find((i) => i.mediaType === 'application/x-dtbncx+xml') ||
      manifest.find((i) => /\.ncx$/i.test(i.href))
    if (ncxItem) {
      const ncxFile = zipFile(zip, resolvePath(opfDir, ncxItem.href))
      if (ncxFile) {
        const ncxDir = dirOf(resolvePath(opfDir, ncxItem.href))
        const ncxDoc = new DOMParser().parseFromString(await ncxFile.async('string'), 'application/xml')
        for (const navPoint of allLocal(ncxDoc, 'navPoint')) {
          const label = textOf(firstLocal(navPoint, 'text'))
          const content = firstLocal(navPoint, 'content')
          const src = content?.getAttribute('src') || ''
          if (!label || !src) continue
          let level = 0
          let p: Element | null = navPoint.parentElement
          while (p) {
            if (p.localName === 'navPoint') level++
            p = p.parentElement
          }
          toc.push({ title: label, href: resolvePath(ncxDir, src), level })
        }
      }
    }
  }

  // --- 封面 ---
  let coverDataUrl: string | undefined
  let coverItem = manifest.find((i) => i.properties.split(/\s+/).includes('cover-image'))
  if (!coverItem) {
    const metaCover = allLocal(opf, 'meta').find((m) => m.getAttribute('name') === 'cover')
    const cid = metaCover?.getAttribute('content')
    if (cid) coverItem = byId.get(cid)
  }
  if (!coverItem) {
    coverItem = manifest.find((i) => i.mediaType.startsWith('image/') && /cover/i.test(i.id + i.href))
  }
  if (coverItem) {
    coverDataUrl = await imageDataUrl(zip, resolvePath(opfDir, coverItem.href))
  }

  // --- 书脊 + 用目录给章节补标题、算 spine 下标 ---
  const spine = spineItems.map((item) => {
    const href = resolvePath(opfDir, item.href)
    let chapterTitle = ''
    const hit = toc.find((t) => stripHash(t.href) === href)
    if (hit) chapterTitle = hit.title
    return { href, title: chapterTitle }
  })

  const tocWithSpine: EpubTocEntry[] = toc.map((t) => {
    const clean = stripHash(t.href)
    let idx = spine.findIndex((s) => s.href === clean)
    if (idx < 0) {
      // 有些书的目录 href 相对路径写错，退回按文件名匹配
      const base = clean.split('/').pop()
      idx = spine.findIndex((s) => s.href.split('/').pop() === base)
    }
    return { ...t, spine: idx >= 0 ? idx : undefined }
  })

  if (!title) title = '未命名'
  return {
    title,
    author: author || '',
    spine,
    toc: tocWithSpine,
    coverDataUrl,
  }
}

/**
 * 取出 EPUB 某一章，清洗成可以直接塞进阅读器的 HTML。
 * 图片会被换成 blob URL（由调用方负责 revoke）。
 */
export async function readEpubChapter(
  zip: JSZip,
  href: string,
  onBlobUrl: (url: string) => void,
): Promise<{ html: string }> {
  const file = zipFile(zip, href)
  if (!file) throw new Error('EPUB 章节缺失：' + href)
  const raw = await file.async('string')
  const doc = new DOMParser().parseFromString(raw, 'text/html')
  const body = doc.body
  if (!body) return { html: '' }

  // 干掉不该出现的东西
  body.querySelectorAll('script, style, link, iframe, object, embed, form, video, audio, noscript, nav').forEach((el) => el.remove())

  // 去掉事件属性和外部跳转，避免点一下跳到浏览器
  body.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) el.removeAttribute(attr.name)
      if (name === 'style' && /url\(/i.test(attr.value)) el.removeAttribute('style')
    }
  })
  body.querySelectorAll('a[href]').forEach((a) => {
    a.removeAttribute('href')
    a.removeAttribute('target')
  })

  // 图片：解出 zip 里的二进制，换成 blob URL
  const baseDir = dirOf(href)
  for (const img of Array.from(body.querySelectorAll('img'))) {
    const src = img.getAttribute('src') || ''
    img.removeAttribute('srcset')
    img.removeAttribute('width')
    img.removeAttribute('height')
    if (!src || src.startsWith('data:') || src.startsWith('http')) {
      if (!src) img.remove()
      continue
    }
    const path = resolvePath(baseDir, src)
    const f = zipFile(zip, path)
    if (!f) {
      img.remove()
      continue
    }
    try {
      const bytes = await f.async('uint8array')
      const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: imageMime(path) }))
      onBlobUrl(url)
      img.setAttribute('src', url)
    } catch {
      img.remove()
    }
  }

  return { html: body.innerHTML }
}
