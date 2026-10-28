/**
 * 课表（本机定制 0.4.12）
 *
 * 纯本地数据：一门课 = 名称 + 星期 + 提醒时间 + 可选关联（专注目标 / B 站视频）+ 备注。
 * 数据存在 Dexie 的 courses 表（见 db/index.ts 的 version(9)）。
 *
 * 0.4.14 起去掉了「地点 / 老师 / 开始时间 / 结束时间」：课表只关心哪天、几点提醒。
 */
import { defineStore } from 'pinia'
import * as db from '@/db'
import { useUiStore } from '@/stores/ui'
import type { Course } from '@/types'

/** 课表用到的星期文案（1=周一 … 7=周日） */
export const COURSE_WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

/** 'YYYY-MM-DD' → 1..7（周一=1，周日=7） */
export function weekdayOf(day: string): number {
  const d = new Date(`${String(day || '').slice(0, 10)}T00:00:00`)
  const w = d.getDay() // 0=周日
  return ((w + 6) % 7) + 1
}

function remindKey(c: Course) {
  return String(c.remindAt || '99:99')
}

export const useCoursesStore = defineStore('courses', {
  state: () => ({
    list: [] as Course[],
    loaded: false,
  }),
  getters: {
    /** 某天的课（按提醒时间排） */
    ofWeekday: (s) => (weekday: number) =>
      s.list.filter((c) => Number(c.weekday) === Number(weekday)).sort((a, b) => remindKey(a).localeCompare(remindKey(b))),
    /** 今天的课 */
    today(state): Course[] {
      const wd = weekdayOf(new Date().toISOString().slice(0, 10))
      return state.list
        .filter((c) => Number(c.weekday) === wd)
        .sort((a, b) => remindKey(a).localeCompare(remindKey(b)))
    },
    count: (s) => s.list.length,
  },
  actions: {
    async init(force = false) {
      if (this.loaded && !force) return
      this.list = await db.listCourses()
      this.loaded = true
    },
    async reload() {
      this.list = await db.listCourses()
      this.loaded = true
    },
    async save(patch: Partial<Course>) {
      const ui = useUiStore()
      const rec = await db.putCourse(patch)
      if (!rec) {
        ui.err('课程名不能为空')
        return null
      }
      await this.reload()
      ui.ok(patch.id ? '课程已保存' : `已添加「${rec.name}」`)
      return rec
    },
    async remove(id: number) {
      const ui = useUiStore()
      const hit = this.list.find((c) => Number(c.id) === Number(id))
      const ok = await ui.confirm(
        `删除课程「${hit ? hit.name : ''}」？`,
        '删了就找不回来了（不影响学习进度和专注记录）。',
        '删除',
      )
      if (!ok) return false
      await db.removeCourse(id)
      await this.reload()
      ui.ok('已删除')
      return true
    },
    async clearAll() {
      const ui = useUiStore()
      const ok = await ui.confirm('清空课表？', '所有课程都会被删除，删了不能恢复。', '清空')
      if (!ok) return false
      await db.clearCourses()
      await this.reload()
      ui.ok('已清空课表')
      return true
    },
  },
})
