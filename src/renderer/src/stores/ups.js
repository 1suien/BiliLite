import { defineStore } from 'pinia'
import { db } from '../db'
import { api } from '../api'

/** 没有指定分组时归到这里 */
export const DEFAULT_GROUP = '未分组'

const LATEST_CACHE_KEY = 'study-bili:up-latest'
const LATEST_TTL = 5 * 60 * 1000

function readLatestCache() {
  try {
    const raw = localStorage.getItem(LATEST_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.items)) return null
    return { at: Number(parsed.at) || 0, items: parsed.items }
  } catch (err) {
    return null
  }
}

function writeLatestCache(at, items) {
  try {
    localStorage.setItem(LATEST_CACHE_KEY, JSON.stringify({ at, items }))
  } catch (err) {
    /* 忽略：仅影响首屏缓存 */
  }
}

function normalize(info, group) {
  return {
    mid: Number(info.mid),
    name: info.name || `UP ${info.mid}`,
    face: info.face || '',
    sign: info.sign || '',
    fans: info.fans || 0,
    group: group || DEFAULT_GROUP,
    addedAt: Date.now()
  }
}

/**
 * 本机「UP 管理」名单：首页只显示这份名单里的 UP 的最新投稿。
 */
export const useUpsStore = defineStore('ups', {
  state: () => ({
    loaded: false,
    /** 本机 UP 名单 */
    items: [],
    /** 自定义分组名（不含「未分组」） */
    groups: [],
    /** 首页用：名单里 UP 的最新投稿 */
    latest: [],
    latestAt: 0,
    loadingLatest: false,
    latestError: '',
    /** 当前筛选的分组：'all' 或分组名 */
    activeGroup: 'all'
  }),
  getters: {
    count: (s) => s.items.length,
    mids: (s) => s.items.map((x) => String(x.mid)),
    groupChips: (s) => {
      const chips = [{ name: 'all', label: '全部', n: s.items.length }]
      for (const g of s.groups) {
        chips.push({ name: g, label: g, n: s.items.filter((x) => (x.group || DEFAULT_GROUP) === g).length })
      }
      const ungrouped = s.items.filter((x) => (x.group || DEFAULT_GROUP) === DEFAULT_GROUP).length
      if (ungrouped) chips.push({ name: DEFAULT_GROUP, label: DEFAULT_GROUP, n: ungrouped })
      return chips
    },
    filtered: (s) => {
      const list = [...s.items].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
      if (s.activeGroup === 'all') return list
      return list.filter((x) => (x.group || DEFAULT_GROUP) === s.activeGroup)
    },
    /** 首页分组用：upMid → 该 UP 的最新投稿 */
    latestByUp: (s) => {
      const map = {}
      for (const it of s.latest) {
        const k = String(it.upMid)
        if (!map[k]) map[k] = []
        map[k].push(it)
      }
      return map
    }
  },
  actions: {
    async init(force = false) {
      if (this.loaded && !force) return
      const [rows, groups] = await Promise.all([db.ups.toArray(), db.upgroups.toArray()])
      this.items = rows.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
      this.groups = groups.sort((a, b) => (a.at || 0) - (b.at || 0)).map((g) => g.name)
      if (!this.latest.length) {
        const cached = readLatestCache()
        if (cached) {
          this.latest = cached.items
          this.latestAt = cached.at
        }
      }
      this.loaded = true
    },

    /** 把 UP 主的投稿名字补上（接口不返回作者名，本地名单里有） */
    withNames(items) {
      const names = new Map(this.items.map((u) => [String(u.mid), u.name]))
      return items.map((it) => ({
        ...it,
        upName: names.get(String(it.upMid)) || `UP ${it.upMid}`
      }))
    },

    /** 拉取名单里所有 UP 的最新投稿（首页「关注的 UP 更新」） */
    async loadLatest(force = false) {
      if (!this.items.length) {
        this.latest = []
        this.latestAt = 0
        this.latestError = ''
        try {
          localStorage.removeItem(LATEST_CACHE_KEY)
        } catch (err) {
          /* 忽略 */
        }
        return { items: [], empty: true }
      }
      if (!force && this.latest.length && Date.now() - this.latestAt < LATEST_TTL) {
        return { items: this.latest, cached: true }
      }
      this.loadingLatest = true
      try {
        const res = await api.up.latest(this.mids, 2)
        this.latest = this.withNames(res.items || [])
        this.latestAt = Date.now()
        const failed = (res.errors || []).length
        this.latestError = failed ? `${failed} 个 UP 的投稿拉取失败（可能是风控，稍后再试）` : ''
        writeLatestCache(this.latestAt, this.latest)
        return { items: this.latest, errors: res.errors || [] }
      } catch (err) {
        this.latestError = err && err.message ? err.message : String(err)
        throw err
      } finally {
        this.loadingLatest = false
      }
    },

    async addUp(info, group = DEFAULT_GROUP) {
      const row = normalize(info, group)
      await db.ups.put(row)
      this.items = [row, ...this.items.filter((x) => String(x.mid) !== String(row.mid))]
      return row
    },

    async removeUp(mid) {
      await db.ups.delete(Number(mid))
      this.items = this.items.filter((x) => String(x.mid) !== String(mid))
      this.latest = this.latest.filter((x) => String(x.upMid) !== String(mid))
    },

    async setGroup(mid, group) {
      const row = this.items.find((x) => String(x.mid) === String(mid))
      if (!row) return
      row.group = group || DEFAULT_GROUP
      await db.ups.put({ ...row })
      this.items = [...this.items]
    },

    async addGroup(name) {
      const clean = String(name || '').trim()
      if (!clean) throw new Error('分组名不能为空')
      if (clean === DEFAULT_GROUP) return
      if (this.groups.includes(clean)) throw new Error('这个分组已经存在')
      await db.upgroups.put({ name: clean, at: Date.now() })
      this.groups = [...this.groups, clean]
    },

    async removeGroup(name) {
      await db.upgroups.delete(name)
      this.groups = this.groups.filter((g) => g !== name)
      // 该分组下的 UP 回到「未分组」
      const affected = this.items.filter((x) => x.group === name)
      for (const row of affected) {
        row.group = DEFAULT_GROUP
        await db.ups.put({ ...row })
      }
      if (affected.length) this.items = [...this.items]
      if (this.activeGroup === name) this.activeGroup = 'all'
    },

    /** 导入 B 站账号的关注列表（需要登录），已存在的保留原分组 */
    async importFollowings() {
      const collected = []
      let pn = 1
      let pages = 1
      do {
        const res = await api.up.followings(pn, 50)
        collected.push(...(res.items || []))
        pages = Math.max(1, Math.ceil((res.total || collected.length) / 50))
        pn += 1
      } while (pn <= Math.min(pages, 6))

      const rows = collected.filter((u) => u && u.mid).map((u) => {
        const old = this.items.find((x) => String(x.mid) === String(u.mid))
        return {
          mid: Number(u.mid),
          name: u.name,
          face: u.face,
          sign: u.sign,
          fans: u.fans,
          group: (old && old.group) || DEFAULT_GROUP,
          addedAt: (old && old.addedAt) || Date.now()
        }
      })
      if (rows.length) await db.ups.bulkPut(rows)
      await this.init(true)
      return { imported: rows.length }
    }
  }
})
