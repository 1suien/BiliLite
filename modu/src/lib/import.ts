import { db, type Book, type BookFile, type BookCover } from '@/db'
import { decodeText, parseTxtChapters } from './encoding'
import { parseEpub } from './epub'
import { getPdfCover, getPdfPageCount } from './pdf'
import { generatedCover } from './cover'
import { hueOf, titleFromFilename, uid, fmtSize } from './util'

/** 单本上限 150MB：手机内存有限，再大也打不开 */
const MAX_BYTES = 150 * 1024 * 1024

export interface ImportResult {
  added: Book[]
  failed: { name: string; error: string }[]
}

export interface ImportOptions {
  onProgress?: (done: number, total: number, current: string) => void
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

async function buildBook(file: File): Promise<Book> {
  const name = file.name
  const format = extOf(name)
  if (format !== 'txt' && format !== 'epub' && format !== 'pdf') {
    throw new Error('不支持的文件类型：.' + (format || '未知'))
  }
  if (!file.size) throw new Error('文件是空的（' + fmtSize(file.size) + '）')
  if (file.size > MAX_BYTES) throw new Error('文件太大（' + fmtSize(file.size) + '，上限 150MB）')

  const buf = await file.arrayBuffer()
  const baseTitle = titleFromFilename(name)
  const id = uid()
  const hue = hueOf(baseTitle)

  let book: Book
  let cover: string | undefined

  if (format === 'txt') {
    const text = decodeText(buf)
    if (!text.trim()) throw new Error('解码后没有正文（可能是加密或二进制文件）')
    const chapters = parseTxtChapters(text, baseTitle)
    book = {
      id,
      title: baseTitle,
      author: '',
      format: 'txt',
      size: file.size,
      addedAt: Date.now(),
      lastReadAt: 0,
      percent: 0,
      pos: null,
      chapters,
      hue,
    }
    cover = generatedCover(baseTitle, '', hue)
  } else if (format === 'epub') {
    const parsed = await parseEpub(buf)
    book = {
      id,
      title: parsed.title || baseTitle,
      author: parsed.author,
      format: 'epub',
      size: file.size,
      addedAt: Date.now(),
      lastReadAt: 0,
      percent: 0,
      pos: null,
      spine: parsed.spine,
      toc: parsed.toc,
      hue,
    }
    if (!parsed.spine.length) throw new Error('EPUB 里没有可读的章节（spine 为空）')
    cover = parsed.coverDataUrl || generatedCover(book.title, book.author, hue)
  } else {
    const pageCount = await getPdfPageCount(buf)
    book = {
      id,
      title: baseTitle,
      author: '',
      format: 'pdf',
      size: file.size,
      addedAt: Date.now(),
      lastReadAt: 0,
      percent: 0,
      pos: null,
      pageCount,
      hue,
    }
    cover = (await getPdfCover(buf)) || generatedCover(baseTitle, '', hue)
  }

  const fileRow: BookFile = { id, data: buf }
  const coverRow: BookCover = { id, dataUrl: cover || '' }
  await db.transaction('rw', [db.books, db.files, db.covers], async () => {
    await db.files.put(fileRow)
    await db.covers.put(coverRow)
    await db.books.put(book)
  })
  return book
}

/** 批量导入：单个失败不影响其它书，返回失败清单给 UI 提示 */
export async function importFiles(files: File[], opts: ImportOptions = {}): Promise<ImportResult> {
  const added: Book[] = []
  const failed: { name: string; error: string }[] = []
  let done = 0
  for (const file of files) {
    opts.onProgress?.(done, files.length, file.name)
    try {
      added.push(await buildBook(file))
    } catch (e: any) {
      failed.push({ name: file.name, error: e?.message || String(e) })
    }
    done++
    opts.onProgress?.(done, files.length, file.name)
  }
  if (added.length) window.dispatchEvent(new CustomEvent('books-changed'))
  return { added, failed }
}

/** 直接在 JS 里造一本（示例书 / 测试用） */
export async function importBuffer(name: string, buf: ArrayBuffer, mime = 'application/octet-stream'): Promise<Book> {
  const file = new File([buf], name, { type: mime })
  const res = await importFiles([file])
  if (!res.added.length) throw new Error(res.failed[0]?.error || '导入失败')
  return res.added[0]
}
