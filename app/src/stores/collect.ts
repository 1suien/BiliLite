/**
 * 本地收藏夹（不依赖 B 站账号，存在 IndexedDB 里）
 * 还原自 collect-CTJFhi1X.js
 */
import { defineStore } from 'pinia'
import { db } from '@/db'
import type { CollectItem } from '@/types'

export const DEFAULT_FOLDER = '默认收藏夹'

export const useCollectStore = defineStore('collect', {
  state: () => ({
    loaded: false,
    folders: [] as string[],
    items: [] as CollectItem[],
    activeFolder: DEFAULT_FOLDER,
  }),
  getters: {
    count: (s) => s.items.length,
    folderList: (s) => {
      const list: { name: string; n: number; deletable: boolean }[] = [
        {
          name: DEFAULT_FOLDER,
          n: s.items.filter((i) => i.folder === DEFAULT_FOLDER).length,
          deletable: false,
        },
      ]
      for (const name of s.folders) {
        list.push({ name, n: s.items.filter((i) => i.folder === name).length, deletable: true })
      }
      return list
    },
    filtered: (s) =>
      [...s.items]
        .filter((i) => s.activeFolder === 'all' || i.folder === s.activeFolder)
        .sort((a, b) => (b.at || 0) - (a.at || 0)),
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
    inCollect(bvid: string) {
      return this.items.some((i) => i.bvid === bvid)
    },
    async add(video: any, folder = DEFAULT_FOLDER) {
      const hit = this.items.find((i) => i.bvid === video.bvid && i.folder === folder)
      if (hit) return hit
      const rec = {
        bvid: video.bvid,
        title: video.title || '',
        cover: video.cover || '',
        upName: video.upName || '',
        upMid: video.upMid || null,
        duration: video.duration || 0,
        page: video.page || 1,
        folder: folder || DEFAULT_FOLDER,
        at: Date.now(),
      }
      const id = await db.collect.add(rec as CollectItem)
      const withId = { ...rec, id }
      this.items = [...this.items, withId]
      return withId
    },
    async removeItem(id: number) {
      await db.collect.delete(id)
      this.items = this.items.filter((i) => i.id !== id)
    },
    async removeByBvid(bvid: string) {
      const hits = this.items.filter((i) => i.bvid === bvid)
      for (const i of hits) await db.collect.delete(i.id as number)
      this.items = this.items.filter((i) => i.bvid !== bvid)
      return hits.length
    },
    async moveItem(id: number, folder: string) {
      const hit = this.items.find((i) => i.id === id)
      if (!hit) return
      hit.folder = folder || DEFAULT_FOLDER
      await db.collect.put({ ...hit })
      this.items = [...this.items]
    },
    async createFolder(name: string) {
      const n = String(name || '').trim()
      if (!n) throw new Error('文件夹名不能为空')
      if (n === DEFAULT_FOLDER || this.folders.includes(n)) throw new Error('这个文件夹已经存在')
      await db.collectfolders.put({ name: n, at: Date.now() })
      this.folders = [...this.folders, n]
      this.activeFolder = n
      return n
    },
    async removeFolder(name: string) {
      if (name === DEFAULT_FOLDER) throw new Error('默认收藏夹不能删除')
      await db.collectfolders.delete(name)
      this.folders = this.folders.filter((f) => f !== name)
      const affected = this.items.filter((i) => i.folder === name)
      for (const i of affected) {
        i.folder = DEFAULT_FOLDER
        await db.collect.put({ ...i })
      }
      if (affected.length) this.items = [...this.items]
      if (this.activeFolder === name) this.activeFolder = DEFAULT_FOLDER
    },
  },
})
