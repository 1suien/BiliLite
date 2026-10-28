<script setup lang="ts">
/**
 * 周课表 /schedule（本机构建 0.4.12）
 *
 * 一门课 = 名称 + 星期 + 起止时间 + 地点/老师 + 可选关联（专注目标 / B 站视频）+ 到点提醒。
 * 提醒由 stores/remind.ts 扫描后弹右下角卡片；卡片可以直接跳到关联视频或学习页。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import { useCoursesStore, COURSE_WEEKDAYS, weekdayOf } from '@/stores/courses'
import { useSettingsStore, accentColor, FOCUS_COLOR_KEYS } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { todayStr } from '@/utils/format'
import type { Course } from '@/types'

const courses = useCoursesStore()
const settings = useSettingsStore()
const ui = useUiStore()
const router = useRouter()

const today = computed(() => todayStr())
const todayWd = computed(() => weekdayOf(today.value))
const todayList = computed(() => courses.ofWeekday(todayWd.value))

/** 按周几分列 */
const columns = computed(() =>
  COURSE_WEEKDAYS.map((label, i) => ({
    label,
    weekday: i + 1,
    today: i + 1 === todayWd.value,
    list: courses.ofWeekday(i + 1),
  })),
)

const activeTargets = computed(() =>
  (Array.isArray(settings.settings.focusTargets) ? settings.settings.focusTargets : []).filter(
    (t: any) => t && !t.archived,
  ),
)

const form = ref({
  open: false,
  id: 0,
  name: '',
  weekday: 1,
  start: '08:00',
  end: '08:45',
  location: '',
  teacher: '',
  color: 'blue',
  targetName: '',
  bvid: '',
  videoTitle: '',
  remindOn: false,
  remindLead: 5,
  note: '',
})
const formTitle = computed(() => (form.value.id ? '编辑课程' : '添加课程'))

function colorOf(c: Course) {
  return accentColor(c.color, settings.settings.theme)
}

/** 从 BV 号 / 视频链接里抠出 BV 号 */
function normalizeBvid(text: string) {
  // 正式 BV 号是 BV + 10 位；这里放宽到 8–12 位，方便手输和 mock 数据
  const m = /BV[0-9A-Za-z]{8,12}/.exec(String(text || ''))
  return m ? m[0] : ''
}

function openCreate(weekday = todayWd.value) {
  form.value = {
    open: true,
    id: 0,
    name: '',
    weekday,
    start: '08:00',
    end: '08:45',
    location: '',
    teacher: '',
    color: FOCUS_COLOR_KEYS[weekday % FOCUS_COLOR_KEYS.length],
    targetName: '',
    bvid: '',
    videoTitle: '',
    remindOn: false,
    remindLead: 5,
    note: '',
  }
}

function openEdit(c: Course) {
  form.value = {
    open: true,
    id: Number(c.id) || 0,
    name: c.name,
    weekday: Number(c.weekday) || 1,
    start: c.start || '08:00',
    end: c.end || '08:45',
    location: c.location || '',
    teacher: c.teacher || '',
    color: c.color || 'blue',
    targetName: c.targetName || '',
    bvid: c.bvid || '',
    videoTitle: c.videoTitle || '',
    remindOn: !!c.remindOn,
    remindLead: Number(c.remindLead) || 5,
    note: c.note || '',
  }
}

async function save() {
  if (!form.value.name.trim()) {
    ui.err('课程名不能为空')
    return
  }
  const bvid = normalizeBvid(form.value.bvid)
  if (form.value.bvid.trim() && !bvid) {
    ui.err('BV 号格式不对（形如 BV1xx411c7mD）')
    return
  }
  await courses.save({
    id: form.value.id || undefined,
    name: form.value.name,
    weekday: form.value.weekday,
    start: form.value.start,
    end: form.value.end,
    location: form.value.location,
    teacher: form.value.teacher,
    color: form.value.color,
    targetName: form.value.targetName,
    bvid,
    videoTitle: form.value.videoTitle || (bvid ? `关联视频 ${bvid}` : ''),
    remindOn: form.value.remindOn,
    remindLead: form.value.remindLead,
    note: form.value.note,
  })
  form.value.open = false
}

async function removeCurrent() {
  if (form.value.id) {
    const ok = await courses.remove(form.value.id)
    if (ok) form.value.open = false
  }
}

/** 从课程卡片直接去关联的视频 / 学习页 */
function goLearn(c: Course) {
  if (c.bvid) router.push({ path: `/video/${c.bvid}` })
  else router.push({ path: '/learn' })
}

// 改开始时间时，如果结束时间已经不比它晚，自动顺延 45 分钟（省得存一个 23:59 的怪时间）
watch(
  () => form.value.start,
  (start) => {
    if (!/^\d{2}:\d{2}$/.test(String(start || ''))) return
    if (!form.value.end || form.value.end <= start) {
      const [h, m] = String(start).split(':').map(Number)
      const total = Math.min(23 * 60 + 59, h * 60 + m + 45)
      form.value.end = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
    }
  },
)

onMounted(async () => {
  await settings.init()
  await courses.init()
})
</script>

<template>
  <div class="schedule-page">
    <div class="page-head">
      <h1>课表</h1>
      <span class="muted sc-today">今天 {{ COURSE_WEEKDAYS[todayWd - 1] }} · {{ todayList.length }} 节课</span>
      <span class="grow" />
      <button class="btn sm primary" title="添加课程" @click="openCreate()">
        <Icon name="plus" :size="14" /> 添加课程
      </button>
      <button
        v-if="courses.count"
        class="btn sm ghost"
        title="清空课表"
        @click="courses.clearAll()"
      >
        <Icon name="trash" :size="14" />
      </button>
    </div>

    <div class="sc-hint muted">
      点某节课可以改时间 / 换关联视频；课表只存在本机。到点提醒在右下角弹卡片（可提前 0–15 分钟）。
    </div>

    <template v-if="todayList.length">
      <div class="sc-today-label muted">今天要上</div>
      <div class="sc-today-list">
        <button
          v-for="c in todayList"
          :key="'t' + c.id"
          class="sc-today-card"
          :style="{ borderLeftColor: colorOf(c) }"
          @click="openEdit(c)"
        >
          <span class="sc-time mono">{{ c.start }}–{{ c.end }}</span>
          <b class="sc-name">{{ c.name }}</b>
          <span class="muted sc-sub">{{ [c.location, c.teacher].filter(Boolean).join(' · ') || '—' }}</span>
          <span class="grow" />
          <span v-if="c.remindOn" class="chip plain sc-chip">
            <Icon name="clock" :size="11" />
            {{ c.remindLead ? `提前 ${c.remindLead} 分` : '到点' }}
          </span>
          <span v-if="c.targetName" class="chip plain sc-chip">{{ c.targetName }}</span>
          <span v-if="c.bvid" class="chip plain sc-chip">关联视频</span>
        </button>
      </div>
    </template>

    <div class="sc-grid">
      <div v-for="col in columns" :key="col.weekday" class="sc-col" :class="{ today: col.today }">
        <div class="sc-col-head">
          <b>{{ col.label }}</b>
          <span v-if="col.today" class="sc-today-dot">今天</span>
          <button class="sc-add" :title="`给${col.label}加课`" :aria-label="`给${col.label}加课`" @click="openCreate(col.weekday)">
            <Icon name="plus" :size="12" />
          </button>
        </div>
        <div class="sc-col-body">
          <button
            v-for="c in col.list"
            :key="c.id"
            class="sc-card"
            :style="{ borderLeftColor: colorOf(c) }"
            :title="`${c.name} ${c.start}-${c.end}`"
            @click="openEdit(c)"
          >
            <span class="sc-card-time mono">{{ c.start }}–{{ c.end }}</span>
            <b class="sc-card-name">{{ c.name }}</b>
            <span v-if="c.location || c.teacher" class="muted sc-card-sub">{{ [c.location, c.teacher].filter(Boolean).join(' · ') }}</span>
            <span class="sc-card-tags">
              <span v-if="c.remindOn" class="sc-tag"><Icon name="clock" :size="10" /></span>
              <span v-if="c.targetName" class="sc-tag">{{ c.targetName }}</span>
              <span v-if="c.bvid" class="sc-tag" @click.stop="goLearn(c)">去视频</span>
            </span>
          </button>
          <div v-if="!col.list.length" class="sc-empty muted">没课</div>
        </div>
      </div>
    </div>

    <div v-if="form.open" class="overlay" @click.self="form.open = false">
      <div class="modal sc-modal" role="dialog" aria-label="编辑课程">
        <h3>{{ formTitle }}</h3>
        <div class="sc-form">
          <label class="field">
            <span>课程名</span>
            <input v-model="form.name" class="input" name="courseName" type="text" maxlength="40" placeholder="比如 高等数学 / 英语听力" />
          </label>
          <div class="sc-form-row">
            <label class="field">
              <span>星期</span>
              <select v-model.number="form.weekday" class="input" name="courseWeekday">
                <option v-for="(label, i) in COURSE_WEEKDAYS" :key="label" :value="i + 1">{{ label }}</option>
              </select>
            </label>
            <label class="field">
              <span>开始</span>
              <input v-model="form.start" class="input" name="courseStart" type="time" />
            </label>
            <label class="field">
              <span>结束</span>
              <input v-model="form.end" class="input" name="courseEnd" type="time" />
            </label>
          </div>
          <div class="sc-form-row">
            <label class="field">
              <span>地点</span>
              <input v-model="form.location" class="input" name="courseLocation" type="text" maxlength="40" placeholder="教学楼 302" />
            </label>
            <label class="field">
              <span>老师</span>
              <input v-model="form.teacher" class="input" name="courseTeacher" type="text" maxlength="40" placeholder="选填" />
            </label>
          </div>
          <label class="field">
            <span>关联专注目标</span>
            <select v-model="form.targetName" class="input" name="courseTarget">
              <option value="">不关联</option>
              <option v-for="t in activeTargets" :key="t.name" :value="t.name">{{ t.name }}</option>
            </select>
          </label>
          <label class="field">
            <span>关联 B 站视频</span>
            <input
              v-model="form.bvid"
              class="input"
              name="courseBvid"
              type="text"
              maxlength="120"
              placeholder="BV 号或视频链接（选填），到点提醒可直接跳过去看"
            />
          </label>
          <label class="field">
            <span>到点提醒</span>
            <span class="row" style="gap: 10px; align-items: center">
              <label class="sc-switch">
                <input v-model="form.remindOn" type="checkbox" name="courseRemind" /> 提醒我
              </label>
              <select v-model.number="form.remindLead" class="input" name="courseLead" style="max-width: 132px" :disabled="!form.remindOn">
                <option :value="0">到点提醒</option>
                <option :value="5">提前 5 分钟</option>
                <option :value="10">提前 10 分钟</option>
                <option :value="15">提前 15 分钟</option>
              </select>
            </span>
          </label>
          <label class="field">
            <span>备注</span>
            <textarea v-model="form.note" class="input" name="courseNote" rows="2" maxlength="200" placeholder="选填"></textarea>
          </label>
        </div>
        <div class="row" style="justify-content: flex-end; gap: 8px; margin-top: 6px">
          <button v-if="form.id" class="btn danger" name="courseDelete" @click="removeCurrent">删除</button>
          <span class="grow" />
          <button class="btn" @click="form.open = false">取消</button>
          <button class="btn primary" name="courseSave" @click="save">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.schedule-page {
  padding: 0 0 24px;
}
.sc-today {
  font-size: 12.5px;
}
.sc-hint {
  font-size: 12px;
  line-height: 1.5;
  margin: 2px 0 12px;
}
.sc-today-label {
  font-size: 12px;
  margin: 0 0 8px;
}
.sc-today-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 14px;
}
.sc-today-card {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1 1 340px;
  min-width: 0;
  text-align: left;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-left: 3px solid var(--brand);
  border-radius: var(--radius-sm);
  background: var(--card);
  color: inherit;
  cursor: pointer;
}
.sc-today-card:hover {
  background: var(--card-hover);
}
.sc-time {
  font-size: 12px;
  color: var(--brand);
  white-space: nowrap;
}
.sc-name {
  font-size: 13.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sc-sub {
  font-size: 11.5px;
  white-space: nowrap;
}
.sc-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
}
.sc-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(120px, 1fr));
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 6px;
}
.sc-col {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--soft);
  min-height: 220px;
  display: flex;
  flex-direction: column;
}
.sc-col.today {
  border-color: var(--brand-line);
  background: var(--brand-soft);
}
.sc-col-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 8px 6px;
  border-bottom: 1px solid var(--line);
  font-size: 12.5px;
}
.sc-today-dot {
  font-size: 10px;
  color: var(--brand);
  border: 1px solid var(--brand-line);
  border-radius: 999px;
  padding: 0 6px;
}
.sc-add {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--t2);
  cursor: pointer;
}
.sc-add:hover {
  background: var(--card-hover);
  color: var(--t1);
}
.sc-col-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
}
.sc-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  text-align: left;
  padding: 7px 8px;
  border: 1px solid var(--line);
  border-left: 3px solid var(--brand);
  border-radius: 8px;
  background: var(--card);
  color: inherit;
  cursor: pointer;
}
.sc-card:hover {
  background: var(--card-hover);
}
.sc-card-time {
  font-size: 10.5px;
  color: var(--t2);
}
.sc-card-name {
  font-size: 12.5px;
  line-height: 1.3;
  word-break: break-word;
}
.sc-card-sub {
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sc-card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}
.sc-tag {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--soft);
  color: var(--t2);
}
.sc-empty {
  font-size: 11.5px;
  text-align: center;
  padding: 14px 0;
}
.sc-modal {
  width: min(560px, 100%);
}
.sc-form {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sc-form-row {
  display: flex;
  gap: 10px;
}
.sc-form-row > .field {
  flex: 1;
  min-width: 0;
}
.sc-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
}
</style>
