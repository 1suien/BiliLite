import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url'

/** Capacitor 里 base 是 './'，拼出来的路径相对 index.html，dev/build 都能用 */
const base = import.meta.env.BASE_URL || './'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export const PDF_DOC_OPTS = {
  cMapUrl: `${base}pdfjs/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${base}pdfjs/standard_fonts/`,
}

/**
 * pdf.js 会 transfer 掉传进来的 ArrayBuffer，而我们从 IndexedDB 拿到的是同一份数据，
 * 所以先 slice(0) 复制一份，避免书的数据被「用掉」。
 */
export function loadPdfDocument(data: ArrayBuffer) {
  return pdfjsLib.getDocument({ data: data.slice(0), ...PDF_DOC_OPTS }).promise
}

export async function getPdfPageCount(data: ArrayBuffer): Promise<number> {
  const doc = await loadPdfDocument(data)
  const n = doc.numPages
  await doc.destroy()
  return n
}

/** 用 PDF 首页渲一张书架封面 */
export async function getPdfCover(data: ArrayBuffer): Promise<string | undefined> {
  const doc = await loadPdfDocument(data)
  try {
    const page = await doc.getPage(1)
    const v1 = page.getViewport({ scale: 1 })
    const scale = 360 / v1.width
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(viewport.width))
    canvas.height = Math.max(1, Math.round(viewport.height))
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx, viewport }).promise
    return canvas.toDataURL('image/jpeg', 0.86)
  } catch {
    return undefined
  } finally {
    doc.destroy()
  }
}

export { pdfjsLib }
