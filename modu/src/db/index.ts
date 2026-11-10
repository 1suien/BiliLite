import Dexie, { type Table } from 'dexie'

export type BookFormat = 'txt' | 'epub' | 'pdf'

/** TXT 分章：字符偏移量（只存偏移，正文只在打开时解码一次） */
export interface TxtChapter {
  title: string
  start: number
  end: number
}

/** EPUB 目录项；spine 指向它在书脊里的下标（用来做「当前章节」高亮） */
export interface EpubTocEntry {
  title: string
  href: string
  level: number
  spine?: number
}

export interface ReaderPos {
  chapter: number
  page: number
  percent: number
}

export interface Book {
  id: string
  title: string
  author: string
  format: BookFormat
  size: number
  addedAt: number
  lastReadAt: number
  /** 0–1，书架上的进度条；没读过是 0 */
  percent: number
  pos?: ReaderPos | null
  /** TXT 分章 */
  chapters?: TxtChapter[]
  /** PDF 总页数 */
  pageCount?: number
  /** EPUB 书脊（zip 内绝对路径） */
  spine?: { href: string; title: string }[]
  /** EPUB 目录 */
  toc?: EpubTocEntry[]
  /** 生成封面的色相（0–360），没有真实封面时用 */
  hue: number
}

export interface BookFile {
  id: string
  data: ArrayBuffer
}

export interface BookCover {
  id: string
  dataUrl: string
}

export interface ReaderSettings {
  fontSize: number
  lineHeight: number
  theme: 'paper' | 'sepia' | 'green' | 'night'
  fontFamily: 'serif' | 'sans'
  margin: number
  pageAnim: 'slide' | 'fade'
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 19,
  lineHeight: 1.9,
  theme: 'paper',
  fontFamily: 'serif',
  margin: 22,
  pageAnim: 'slide',
}

class ReaderDB extends Dexie {
  books!: Table<Book, string>
  files!: Table<BookFile, string>
  covers!: Table<BookCover, string>
  settings!: Table<{ key: string; value: unknown }, string>

  constructor() {
    super('readawre')
    this.version(1).stores({
      books: 'id, lastReadAt, addedAt',
      files: 'id',
      covers: 'id',
      settings: 'key',
    })
  }
}

export const db = new ReaderDB()

export async function loadSettings(): Promise<ReaderSettings> {
  const row = await db.settings.get('reader')
  return { ...DEFAULT_SETTINGS, ...((row?.value as Partial<ReaderSettings>) || {}) }
}

export async function saveSettings(s: ReaderSettings): Promise<void> {
  await db.settings.put({ key: 'reader', value: { ...s } })
}

/** 书架按最近阅读（没读过按导入时间）倒序 */
export async function listBooks(): Promise<Book[]> {
  const all = await db.books.toArray()
  return all.sort((a, b) => (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt))
}

export async function removeBook(id: string): Promise<void> {
  await db.transaction('rw', [db.books, db.files, db.covers], async () => {
    await db.books.delete(id)
    await db.files.delete(id)
    await db.covers.delete(id)
  })
}

export async function savePos(id: string, pos: ReaderPos): Promise<void> {
  await db.books.update(id, {
    pos,
    percent: pos.percent,
    lastReadAt: Date.now(),
  })
}

export async function resetProgress(id: string): Promise<void> {
  await db.books.update(id, { pos: null, percent: 0, lastReadAt: Date.now() })
}

export async function getCover(id: string): Promise<string | undefined> {
  return (await db.covers.get(id))?.dataUrl
}
