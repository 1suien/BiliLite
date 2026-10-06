import { defineStore } from 'pinia'
import { db } from '../db'

/** 默认收藏夹，始终存在且不可删除 */
export const DEFAULT_FOLDER = '默认收藏夹'

/**
 * 本机收藏（不依赖 B 站账号），支持文件夹管理。
 * 与「B站账户收藏」并列显示在收藏页的两个 tab 里。
 */
export const useCollectStore = defineStore('collect', {
  state: () => ({
    loaded: false,
    /** 自定义文件夹名（不含默认收藏夹） */
    folders: [],
    /** {id, bvid, title, cover, upName, upMid, duration, folder, at} */
    items: [],
    activeFolder: DEFAULT_FOLDER
  }),
  getters: {
    count: (s) => s.items.length,
    /** 左栏文件夹列表：[{name, n, deletable}] */
    folderList: (s) => {
      const rows = [{ name: DEFAULT_FOLDER, n: s.items.filter((x) => x.folder === DEFAULT_FOLDER).length, deletable: false }]
      for (const f of s.folders) {
        rows.push({ name: f, n: s.items.filter((x) => x.folder === f).length, deletable: true })
      }
      return rows
    },
    filtered: (s) =>
      [...s.items]
        .filter((x) => s.activeFolder === 'all' || x.folder === s.activeFolder)
        .sort((a, b) => (b.at || 0) - (a.at || 0))
  },
  actions: {
    async init(force = false) {
      if (this.loaded && !force) return
      const [folders, items] = await Promise.all([db.collectfolders.toArray(), db.collect.toArray()])
      this.folders = folders.sort((a, b) => (a.at || 0) - (b.at || 0)).map((f) => f.name)
      this.items = items
      if (!this.folderList.some((f) => f.name === this.activeFolder)) this.activeFolder = DEFAULT_FOLDER
      this.loaded = true
    },
    inCollect(bvid) {
      return this.items.some((x) => x.bvid === bvid)
    },
    async add(item, folder = DEFAULT_FOLDER) {
      const existing = this.items.find((x) => x.bvid === item.bvid && x.folder === folder)
      if (existing) return existing
      const row = {
        bvid: item.bvid,
        title: item.title || '',
        cover: item.cover || '',
        upName: item.upName || '',
        upMid: item.upMid || null,
        duration: item.duration || 0,
        page: item.page || 1,
        folder: folder || DEFAULT_FOLDER,
        at: Date.now()
      }
      const id = await db.collect.add(row)
      const saved = { ...row, id }
      this.items = [...this.items, saved]
      return saved
    },
    async removeItem(id) {
      await db.collect.delete(id)
      this.items = this.items.filter((x) => x.id !== id)
    },
    async removeByBvid(bvid) {
      const rows = this.items.filter((x) => x.bvid === bvid)
      for (const r of rows) await db.collect.delete(r.id)
      this.items = this.items.filter((x) => x.bvid !== bvid)
      return rows.length
    },
    async moveItem(id, folder) {
      const row = this.items.find((x) => x.id === id)
      if (!row) return
      row.folder = folder || DEFAULT_FOLDER
      await db.collect.put({ ...row })
      this.items = [...this.items]
    },
    async createFolder(name) {
      const clean = String(name || '').trim()
      if (!clean) throw new Error('文件夹名不能为空')
      if (clean === DEFAULT_FOLDER || this.folders.includes(clean)) throw new Error('这个文件夹已经存在')
      await db.collectfolders.put({ name: clean, at: Date.now() })
      this.folders = [...this.folders, clean]
      this.activeFolder = clean
      return clean
    },
    async removeFolder(name) {
      if (name === DEFAULT_FOLDER) throw new Error('默认收藏夹不能删除')
      await db.collectfolders.delete(name)
      this.folders = this.folders.filter((f) => f !== name)
      const affected = this.items.filter((x) => x.folder === name)
      for (const r of affected) {
        r.folder = DEFAULT_FOLDER
        await db.collect.put({ ...r })
      }
      if (affected.length) this.items = [...this.items]
      if (this.activeFolder === name) this.activeFolder = DEFAULT_FOLDER
    }
  }
})
