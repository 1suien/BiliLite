import Dexie, { type Table } from 'dexie'

export type BookFormat = 'txt' | 'epub' | 'pdf' | 'fb2' | 'cbz'

/** TXT/FB2 分章：字符偏移量（只存偏移，正文只在打开时解码一次） */
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
  /** TXT / FB2 分章 */
  chapters?: TxtChapter[]
  /** PDF 总页数、CBZ 图片页数 */
  pageCount?: number
  /** EPUB 书脊（zip 内绝对路径） */
  spine?: { href: string; title: string }[]
  /** EPUB 目录 */
  toc?: EpubTocEntry[]
  /** 生成封面的色相（0–360），没有真实封面时用 */
  hue: number
  /** 累计阅读时长（毫秒），书架 / 统计用 */
  readMs?: number
}

export interface BookFile {
  id: string
  data: ArrayBuffer
}

export interface BookCover {
  id: string
  dataUrl: string
}

export const HL_COLORS = ['yellow', 'green', 'blue', 'pink'] as const
export type HlColor = (typeof HL_COLORS)[number]

/** 一条划线 / 批注。位置用「章节渲染后纯文本里的字符偏移」表示，改字号、转屏都不丢。 */
export interface Annotation {
  id: string
  bookId: string
  chapter: number
  /** 章节标题快照，笔记列表里显示用 */
  chapterTitle: string
  start: number
  end: number
  quote: string
  color: HlColor
  note: string
  createdAt: number
  updatedAt: number
}

/** 一次连续的阅读会话，用于统计 */
export interface ReadingSession {
  id: string
  bookId: string
  bookTitle: string
  start: number
  end: number
  /** 这期间翻过的页数（含跨章） */
  pages: number
}

export interface ReaderSettings {
  fontSize: number
  lineHeight: number
  theme: 'paper' | 'sepia' | 'green' | 'night'
  fontFamily: 'serif' | 'sans'
  margin: number
  pageAnim: 'slide' | 'fade'
  /** 逐句聚焦：只把当前这句读黑，其余变淡 */
  focusMode: boolean
  /** 阅读页常亮 */
  keepAwake: boolean
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 19,
  lineHeight: 1.9,
  theme: 'paper',
  fontFamily: 'serif',
  margin: 22,
  pageAnim: 'slide',
  focusMode: false,
  keepAwake: true,
}

/** AI 助手配置（可选的「自带 Key」模式，纯本地保存，不上传） */
export interface AiSettings {
  baseUrl: string
  apiKey: string
  model: string
}

export const DEFAULT_AI: AiSettings = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
}

export interface SettingRow {
  key: string
  value: unknown
}

class ReaderDB extends Dexie {
  books!: Table<Book, string>
  files!: Table<BookFile, string>
  covers!: Table<BookCover, string>
  annotations!: Table<Annotation, string>
  sessions!: Table<ReadingSession, string>
  settings!: Table<SettingRow, string>

  constructor() {
    super('readawre')
    this.version(1).stores({
      books: 'id, lastReadAt, addedAt',
      files: 'id',
      covers: 'id',
      settings: 'key',
    })
    this.version(2).stores({
      books: 'id, lastReadAt, addedAt',
      files: 'id',
      covers: 'id',
      annotations: 'id, bookId, chapter, createdAt, [bookId+chapter]',
      sessions: 'id, bookId, start',
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

export async function loadAiSettings(): Promise<AiSettings> {
  const row = await db.settings.get('ai')
  return { ...DEFAULT_AI, ...((row?.value as Partial<AiSettings>) || {}) }
}

export async function saveAiSettings(s: AiSettings): Promise<void> {
  await db.settings.put({ key: 'ai', value: { ...s } })
}

/** 书架按最近阅读（没读过按导入时间）倒序 */
export async function listBooks(): Promise<Book[]> {
  const all = await db.books.toArray()
  return all.sort((a, b) => (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt))
}

export async function removeBook(id: string): Promise<void> {
  await db.transaction('rw', [db.books, db.files, db.covers, db.annotations, db.sessions], async () => {
    await db.books.delete(id)
    await db.files.delete(id)
    await db.covers.delete(id)
    await db.annotations.where('bookId').equals(id).delete()
    await db.sessions.where('bookId').equals(id).delete()
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

// ---------------- 划线 / 批注 ----------------

export async function listAnnotations(bookId?: string): Promise<Annotation[]> {
  const all = bookId
    ? await db.annotations.where('bookId').equals(bookId).toArray()
    : await db.annotations.toArray()
  return all.sort((a, b) => a.chapter - b.chapter || a.start - b.start)
}

export async function listAnnotationsForChapter(bookId: string, chapter: number): Promise<Annotation[]> {
  const rows = await db.annotations.where('[bookId+chapter]').equals([bookId, chapter]).toArray()
  return rows.sort((a, b) => a.start - b.start)
}

export async function saveAnnotation(a: Annotation): Promise<void> {
  await db.annotations.put(a)
}

export async function removeAnnotation(id: string): Promise<void> {
  await db.annotations.delete(id)
}

// ---------------- 阅读统计 ----------------

export async function saveSession(s: ReadingSession): Promise<void> {
  if (s.end - s.start < 3000) return
  await db.sessions.put(s)
}

export async function listSessions(since = 0): Promise<ReadingSession[]> {
  const all = await db.sessions.where('start').aboveOrEqual(since).toArray()
  return all.sort((a, b) => a.start - b.start)
}

export async function addReadMs(bookId: string, ms: number): Promise<void> {
  if (ms < 1000) return
  const b = await db.books.get(bookId)
  if (!b) return
  await db.books.update(bookId, { readMs: (b.readMs || 0) + ms })
}
