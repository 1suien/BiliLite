/**
 * 关注的 UP 主：分组、增量投稿（“最近更新”）
 * 还原自 ups-9iD6MS7t.js
 */
import { defineStore } from 'pinia'
import * as db from '@/db'
import { bili } from '@/bridge'
import type { UpItem, VideoCard } from '@/types'

export const UNGROUPED = '未分组'
const LATEST_KEY = 'study-bili:up-latest'
const LATEST_TTL = 5 * 60 * 1000

function readLatestCache(): { at: number; items: VideoCard[] } | null {
  try {
    const raw = localStorage.getItem(LATEST_KEY)
    if (!raw) return null
    const obj = JSON.parse(raw)
    if (!obj || !Array.isArray(obj.items)) return null
    return { at: Number(obj.at) || 0, items: obj.items }
  } catch {
    return null
  }
}

function writeLatestCache(at: number, items: VideoCard[]) {
  try {
    localStorage.setItem(LATEST_KEY, JSON.stringify({ at, items }))
  } catch {}
}

function normalizeUp(raw: any, group?: string): UpItem {
  return {
    mid: Number(raw.mid),
    name: raw.name || `UP ${raw.mid}`,
    face: raw.face || '',
    sign: raw.sign || '',
    fans: raw.fans || 0,
    group: group || UNGROUPED,
    addedAt: Date.now(),
  }
}

export const useUpsStore = defineStore('ups', {
  state: () => ({
    loaded: false,
    items: [] as UpItem[],
    groups: [] as string[],
    latest: [] as VideoCard[],
    latestAt: 0,
    loadingLatest: false,
    latestError: '',
    activeGroup: 'all',
  }),
  getters: {
    count: (s) => s.items.length,
    mids: (s) => s.items.map((u) => String(u.mid)),
    /** 分组筛选 chip */
    groupChips: (s) => {
      const chips: { name: string; label: string; n: number }[] = [
        { name: 'all', label: '全部', n: s.items.length },
      ]
      for (const g of s.groups) {
        chips.push({ name: g, label: g, n: s.items.filter((u) => (u.group || UNGROUPED) === g).length })
      }
      const loose = s.items.filter((u) => (u.group || UNGROUPED) === UNGROUPED).length
      if (loose) chips.push({ name: UNGROUPED, label: UNGROUPED, n: loose })
      return chips
    },
    filtered: (s) => {
      const list = [...s.items].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
      return s.activeGroup === 'all' ? list : list.filter((u) => (u.group || UNGROUPED) === s.activeGroup)
    },
    latestByUp: (s) => {
      const map: Record<string, VideoCard[]> = {}
      for (const v of s.latest) {
        const key = String(v.upMid)
        if (!map[key]) map[key] = []
        map[key].push(v)
      }
      return map
    },
  },
  actions: {
    async init(force = false) {
      if (this.loaded && !force) return
      const [ups, groups] = await Promise.all([db.db.ups.toArray(), db.db.upgroups.toArray()])
      this.items = ups.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
      this.groups = groups.sort((a, b) => (a.at || 0) - (b.at || 0)).map((g) => g.name)
      if (!this.latest.length) {
        const cache = readLatestCache()
        if (cache) {
          this.latest = cache.items
          this.latestAt = cache.at
        }
      }
      this.loaded = true
    },
    withNames(list: VideoCard[]) {
      const map = new Map(this.items.map((u) => [String(u.mid), u.name]))
      return list.map((v) => ({ ...v, upName: map.get(String(v.upMid)) || `UP ${v.upMid}` }))
    },
    async loadLatest(force = false) {
      if (!this.items.length) {
        this.latest = []
        this.latestAt = 0
        this.latestError = ''
        try {
          localStorage.removeItem(LATEST_KEY)
        } catch {}
        return { items: [], empty: true as const }
      }
      if (!force && this.latest.length && Date.now() - this.latestAt < LATEST_TTL) {
        return { items: this.latest, cached: true as const }
      }
      this.loadingLatest = true
      try {
        const res = await bili.up.latest(this.mids, 2)
        this.latest = this.withNames(res.items || [])
        this.latestAt = Date.now()
        const failed = (res.errors || []).length
        this.latestError = failed ? `${failed} 个 UP 的投稿拉取失败（可能是风控，稍后再试）` : ''
        writeLatestCache(this.latestAt, this.latest)
        return { items: this.latest, errors: res.errors || [] }
      } catch (e: any) {
        this.latestError = e && e.message ? e.message : String(e)
        throw e
      } finally {
        this.loadingLatest = false
      }
    },
    async addUp(raw: any, group = UNGROUPED) {
      const rec = normalizeUp(raw, group)
      await db.db.ups.put(rec)
      this.items = [rec, ...this.items.filter((u) => String(u.mid) !== String(rec.mid))]
      return rec
    },
    async removeUp(mid: number | string) {
      await db.db.ups.delete(Number(mid))
      this.items = this.items.filter((u) => String(u.mid) !== String(mid))
      this.latest = this.latest.filter((v) => String(v.upMid) !== String(mid))
    },
    async setGroup(mid: number | string, group: string) {
      const hit = this.items.find((u) => String(u.mid) === String(mid))
      if (!hit) return
      hit.group = group || UNGROUPED
      await db.db.ups.put({ ...hit })
      this.items = [...this.items]
    },
    async addGroup(name: string) {
      const n = String(name || '').trim()
      if (!n) throw new Error('分组名不能为空')
      if (n !== UNGROUPED) {
        if (this.groups.includes(n)) throw new Error('这个分组已经存在')
        await db.db.upgroups.put({ name: n, at: Date.now() })
        this.groups = [...this.groups, n]
      }
    },
    async removeGroup(name: string) {
      await db.db.upgroups.delete(name)
      this.groups = this.groups.filter((g) => g !== name)
      const affected = this.items.filter((u) => u.group === name)
      for (const u of affected) {
        u.group = UNGROUPED
        await db.db.ups.put({ ...u })
      }
      if (affected.length) this.items = [...this.items]
      if (this.activeGroup === name) this.activeGroup = 'all'
    },
    /** 从 B 站「我的关注」批量导入（最多 6 页 × 50） */
    async importFollowings() {
      const all: any[] = []
      let pn = 1
      let pages = 1
      do {
        const res = await bili.up.followings(pn, 50)
        all.push(...(res.items || []))
        pages = Math.max(1, Math.ceil((res.total || all.length) / 50))
        pn += 1
      } while (pn <= Math.min(pages, 6))

      const rows = all
        .filter((r) => r && r.mid)
        .map((r) => {
          const old = this.items.find((u) => String(u.mid) === String(r.mid))
          return {
            mid: Number(r.mid),
            name: r.name,
            face: r.face,
            sign: r.sign,
            fans: r.fans,
            group: (old && old.group) || UNGROUPED,
            addedAt: (old && old.addedAt) || Date.now(),
          }
        })
      if (rows.length) await db.db.ups.bulkPut(rows as UpItem[])
      await this.init(true)
      return { imported: rows.length }
    },
  },
})
