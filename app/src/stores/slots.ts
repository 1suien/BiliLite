/**
 * 课表 · 时间块（本机构建 0.4.29）
 *
 * 0.4.12 ~ 0.4.28 的课表是「课程 = 名字 + 星期 + 提醒时间」的周卡片；
 * 0.4.29 起改成时间块：一条 = 做什么 + 学习/休息 + 起止时间 + 星期（可多选）。
 * 目的只有一个：打开课表就知道「现在该做什么、还剩多久、下一项是什么」。
 *
 * 数据：
 *  - 时段存 Dexie 的 slots 表（见 db/index.ts 的 version(10)）；
 *  - 每天每条的完成 / 跳过状态存 localStorage（按天，第二天自动重置）；
 *  - 旧版 courses 表的数据在首次初始化时一次性迁移成时段，不丢数据。
 */
import { defineStore } from 'pinia'
import * as db from '@/db'
import { useUiStore } from '@/stores/ui'
import { todayStr } from '@/utils/format'
import type { ScheduleSlot, SlotKind, SlotStatus } from '@/types'

/** 课表用到的星期文案（1=周一 … 7=周日） */
export const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

/** 'YYYY-MM-DD' → 1..7（周一=1，周日=7） */
export function weekdayOf(day: string): number {
  const d = new Date(`${String(day || '').slice(0, 10)}T00:00:00`)
  const w = d.getDay() // 0=周日
  return ((w + 6) % 7) + 1
}

export function pad2(n: number) {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0')
}

/** 'HH:MM' → 分钟数；不合法返回 -1 */
export function minutesOf(time: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim())
  if (!m) return -1
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return -1
  return h * 60 + mi
}

/** 分钟数 → 'HH:MM' */
export function hhmmOf(min: number): string {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)))
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`
}

export function durOf(slot: Pick<ScheduleSlot, 'start' | 'end'>): number {
  const a = minutesOf(slot.start)
  const b = minutesOf(slot.end)
  if (a < 0 || b < 0) return 0
  return Math.max(0, b - a)
}

/** 分钟数 → 「1 小时 45 分」/「45 分钟」 */
export function fmtDur(min: number): string {
  const m = Math.max(0, Math.round(min))
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r ? `${h} 小时 ${r} 分` : `${h} 小时`
}

/** 时段属于哪一段（只用于分组标题：早晨 / 上午 / 下午 / 晚上） */
export function partOf(time: string): '早晨' | '上午' | '下午' | '晚上' {
  const m = minutesOf(time)
  if (m < 0) return '上午'
  if (m < 9 * 60) return '早晨'
  if (m < 12 * 60) return '上午'
  if (m < 18 * 60) return '下午'
  return '晚上'
}

export const PARTS = ['早晨', '上午', '下午', '晚上'] as const

const STATUS_KEY = 'study-bili-slot-status'
const MIGRATED_KEY = 'study-bili-slots-migrated'

function readStatus(): Record<string, Record<string, SlotStatus>> {
  try {
    const raw = JSON.parse(localStorage.getItem(STATUS_KEY) || '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function writeStatus(v: Record<string, Record<string, SlotStatus>>) {
  try {
    localStorage.setItem(STATUS_KEY, JSON.stringify(v))
  } catch {
    /* 存不下就算了，状态只是锦上添花 */
  }
}

/** 解析「从表格粘贴」的文本：返回识别出的时段与跳过的行数 */
export function parsePlanText(text: string): {
  rows: { start: string; end: string; name: string; kind: SlotKind }[]
  skipped: number
} {
  const rows: { start: string; end: string; name: string; kind: SlotKind }[] = []
  let skipped = 0
  const lines = String(text || '').split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      skipped++
      continue
    }
    const tokens = line.split(/[\s\t|,，;；]+/).filter(Boolean)
    // 找到前两个时间片段
    const times: string[] = []
    const rest: string[] = []
    for (const tk of tokens) {
      const m = /^(\d{1,2})[:：](\d{2})$/.exec(tk)
      if (m && times.length < 2) {
        times.push(`${pad2(Number(m[1]))}:${m[2]}`)
      } else if (m) {
        skipped++
        times.length = 0
        break
      } else {
        rest.push(tk)
      }
    }
    if (times.length < 2) {
      skipped++
      continue
    }
    let kind: SlotKind = 'study'
    const name: string[] = []
    for (const tk of rest) {
      if (/^(学习|学习任务|study)$/i.test(tk)) kind = 'study'
      else if (/^(休息|休息时间|break)$/i.test(tk)) kind = 'break'
      else name.push(tk)
    }
    const title = name.join(' ').trim()
    if (!title) {
      skipped++
      continue
    }
    // 没写类型时按关键词猜：冥想 / 休息 / 运动 … 当休息
    if (!rest.some((tk) => /^(学习|休息)$/.test(tk)) && /冥想|休息|运动|放松|散步|茶歇|午休/.test(title)) {
      kind = 'break'
    }
    rows.push({ start: times[0], end: times[1], name: title.slice(0, 40), kind })
  }
  return { rows, skipped }
}

export const useSlotsStore = defineStore('slots', {
  state: () => ({
    list: [] as ScheduleSlot[],
    loaded: false,
    /** localStorage：{ 'YYYY-MM-DD': { 'id': 'done' | 'skipped' } } */
    status: readStatus() as Record<string, Record<string, SlotStatus>>,
  }),
  getters: {
    /** 某星期的时段（按开始时间排） */
    ofWeekday: (s) => (weekday: number) =>
      s.list
        .filter((x) => Array.isArray(x.days) && x.days.includes(Number(weekday)))
        .slice()
        .sort((a, b) => minutesOf(a.start) - minutesOf(b.start)),
    /** 今天（按开始时间排） */
    today(state): ScheduleSlot[] {
      const wd = weekdayOf(todayStr())
      return state.list
        .filter((x) => Array.isArray(x.days) && x.days.includes(wd))
        .slice()
        .sort((a, b) => minutesOf(a.start) - minutesOf(b.start))
    },
    count: (s) => s.list.length,
  },
  actions: {
    async init(force = false) {
      if (this.loaded && !force) return
      // 0.4.29：旧版 courses → 时段（只迁一次）
      if (!localStorage.getItem(MIGRATED_KEY)) {
        try {
          const n = await db.migrateCoursesToSlots()
          localStorage.setItem(MIGRATED_KEY, '1')
          if (n > 0) console.info(`[slots] 已把 ${n} 条旧课表迁移成时段`)
        } catch (e: any) {
          console.warn('[slots] 旧课表迁移失败：', e && e.message)
        }
      }
      this.list = await db.listSlots()
      this.status = readStatus()
      this.loaded = true
    },
    async reload() {
      this.list = await db.listSlots()
      this.loaded = true
    },
    /** 某天某条的状态：显式标记优先，否则按时间推断（已结束=done，进行中=doing） */
    statusOf(day: string, slot: ScheduleSlot): SlotStatus | 'doing' {
      const marked = (this.status[day] || {})[String(slot.id)]
      if (marked) return marked
      const now = new Date()
      const cur = now.getHours() * 60 + now.getMinutes()
      const a = minutesOf(slot.start)
      const b = minutesOf(slot.end)
      if (a < 0 || b < 0) return 'todo'
      if (cur >= b) return 'done'
      if (cur >= a) return 'doing'
      return 'todo'
    },
    setStatus(day: string, id: number, status: SlotStatus | '') {
      const d = (this.status[day] = this.status[day] || {})
      if (status) d[String(id)] = status
      else delete d[String(id)]
      writeStatus(this.status)
      this.status = { ...this.status }
    },
    /** 今天的统计：已完成项数 / 已学习分钟 / 计划学习分钟 */
    statOf(slots?: ScheduleSlot[]) {
      const list = slots || this.today
      const wd = weekdayOf(todayStr())
      let done = 0
      let learned = 0
      let plan = 0
      let studyCount = 0
      for (const s of list) {
        if (s.kind !== 'study') continue
        studyCount++
        const d = durOf(s)
        plan += d
        const st = this.statusOf(todayStr(), s)
        if (st === 'done') {
          done++
          learned += d
        } else if (st === 'doing') {
          done++
          const cur = new Date().getHours() * 60 + new Date().getMinutes()
          learned += Math.max(0, Math.min(d, cur - minutesOf(s.start)))
        }
      }
      return { done, total: list.length, learned, plan, studyCount, wd }
    },
    async save(patch: Partial<ScheduleSlot>, opts?: { silent?: boolean }) {
      const ui = useUiStore()
      const rec = await db.putSlot(patch)
      if (!rec) {
        ui.err('「做什么」不能为空，起止时间要填对')
        return null
      }
      await this.reload()
      // 批量导入时静音：几十条各弹一次 toast 会刷屏
      if (!opts?.silent) ui.ok(patch.id ? '时段已保存' : `已添加「${rec.name}」`)
      return rec
    },
    async remove(id: number) {
      const ui = useUiStore()
      const hit = this.list.find((c) => Number(c.id) === Number(id))
      const ok = await ui.confirm(`删除时段「${hit ? hit.name : ''}」？`, '删了就找不回来了（不影响学习进度和专注记录）。', '删除')
      if (!ok) return false
      await db.removeSlot(id)
      await this.reload()
      ui.ok('已删除')
      return true
    },
    async clearAll(dayOnly = false) {
      const ui = useUiStore()
      if (dayOnly) {
        const wd = weekdayOf(todayStr())
        const todays = this.list.filter((x) => Array.isArray(x.days) && x.days.includes(wd))
        const ok = await ui.confirm('清空今天的计划？', `会删掉今天（${WEEKDAY_LABELS[wd - 1]}）的 ${todays.length} 个时段。`, '清空')
        if (!ok) return false
        for (const s of todays) {
          // 多选星期的时段只从今天里摘掉这一天
          const days = (s.days || []).filter((d) => Number(d) !== wd)
          if (days.length) await db.putSlot({ ...s, days })
          else await db.removeSlot(Number(s.id))
        }
        await this.reload()
        ui.ok('已清空今天')
        return true
      }
      const ok = await ui.confirm('清空整张课表？', '所有时段都会被删除，删了不能恢复。', '清空')
      if (!ok) return false
      await db.clearSlots()
      await this.reload()
      ui.ok('已清空课表')
      return true
    },
  },
})
