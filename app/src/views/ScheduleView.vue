<script setup lang="ts">
/**
 * 课表 /schedule（本机构建 0.4.29 重做）
 *
 * 0.4.12 ~ 0.4.28 是「周课表卡片 + 到点提醒」，回答不了「现在该做什么」。
 * 0.4.29 起改成时间块：一条 = 做什么 + 学习/休息 + 起止时间 + 星期（可多选）。
 *
 * 页面只有两块：
 *   1. 今日（默认）：现在卡片（内容 / 剩余时间 / 进度环）+ 下一项 + 今日时间轴（早晨/上午/下午/晚上）；
 *   2. 全周：7 列时间块，今天那列高亮。
 * 另外两个弹层：编辑时段（右侧抽屉）、从表格粘贴（WPS 四列一次搬进来）。
 *
 * 提醒仍走 stores/remind.ts 的右下角卡片 + 系统通知；这里只负责看和编辑。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import {
  PARTS,
  WEEKDAY_LABELS,
  durOf,
  fmtDur,
  minutesOf,
  pad2,
  parsePlanText,
  partOf,
  weekdayOf,
} from '@/stores/slots'
import { useSlotsStore } from '@/stores/slots'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { todayStr } from '@/utils/format'
import type { ScheduleSlot, SlotKind } from '@/types'

const slots = useSlotsStore()
const settings = useSettingsStore()
const ui = useUiStore()
const router = useRouter()

const tab = ref<'today' | 'week'>('today')
const today = computed(() => todayStr())
const todayWd = computed(() => weekdayOf(today.value))
const nowMin = ref(new Date().getHours() * 60 + new Date().getMinutes())
let timer = 0

const todayList = computed(() => slots.today)
const stat = computed(() => slots.statOf(todayList.value))
const progress = computed(() => (stat.value.total ? Math.round((stat.value.done / stat.value.total) * 100) : 0))

function isDoing(s: ScheduleSlot) {
  const a = minutesOf(s.start)
  const b = minutesOf(s.end)
  return a >= 0 && b >= 0 && nowMin.value >= a && nowMin.value < b
}

const current = computed(() => todayList.value.find((s) => isDoing(s)) || null)
const upcoming = computed(() => todayList.value.filter((s) => minutesOf(s.start) > nowMin.value))
const nextSlot = computed(() => upcoming.value[0] || null)
const nextList = computed(() => upcoming.value.slice(0, 2))

const groups = computed(() =>
  PARTS.map((part) => ({ part, items: todayList.value.filter((s) => partOf(s.start) === part) })).filter((g) => g.items.length),
)

const weekCols = computed(() =>
  WEEKDAY_LABELS.map((label, i) => ({
    label,
    weekday: i + 1,
    today: i + 1 === todayWd.value,
    list: slots.ofWeekday(i + 1),
  })),
)

const activeTargets = computed(() =>
  (Array.isArray(settings.settings.focusTargets) ? settings.settings.focusTargets : []).filter((t: any) => t && !t.archived),
)

/* ------------------------------ 状态 ------------------------------ */

function statusOf(s: ScheduleSlot) {
  return slots.statusOf(today.value, s)
}

function minutesLeftOf(s: ScheduleSlot) {
  const b = minutesOf(s.end)
  return b < 0 ? 0 : Math.max(0, b - nowMin.value)
}

const currentRemain = computed(() => {
  const s = current.value
  return s ? minutesLeftOf(s) : 0
})

const currentPct = computed(() => {
  const s = current.value
  if (!s) return 0
  const a = minutesOf(s.start)
  const b = minutesOf(s.end)
  if (a < 0 || b <= a) return 0
  return Math.min(100, Math.max(0, Math.round(((nowMin.value - a) / (b - a)) * 100)))
})

const ringBg = computed(() => {
  const pct = currentPct.value
  return `conic-gradient(var(--brand) 0 ${pct}%, var(--line) ${pct}% 100%)`
})

function fmtLeft(min: number) {
  const m = Math.max(0, Math.round(min))
  const h = Math.floor(m / 60)
  const r = m % 60
  return h ? `${h}:${pad2(r)}` : `${r} 分钟`
}

function startText(s: ScheduleSlot) {
  const diff = minutesOf(s.start) - nowMin.value
  if (diff <= 0) return '马上开始'
  if (diff < 60) return `${diff} 分钟后`
  return `${Math.floor(diff / 60)} 小时 ${diff % 60} 分后`
}

function normalizeBvid(text: string) {
  const m = /BV[0-9A-Za-z]{8,12}/.exec(String(text || ''))
  return m ? m[0] : ''
}

/* ------------------------------ 操作 ------------------------------ */

function startFocus(s: ScheduleSlot) {
  router.push({ path: '/learn', query: s.targetName ? { target: s.targetName } : {} })
}

function completeSlot(s: ScheduleSlot) {
  if (!s.id) return
  slots.setStatus(today.value, s.id, 'done')
  ui.ok(`已完成「${s.name}」`)
}

function skipSlot(s: ScheduleSlot) {
  if (!s.id) return
  slots.setStatus(today.value, s.id, 'skipped')
  ui.toast(`已跳过「${s.name}」`, 'info', 2000)
}

function undoSlot(s: ScheduleSlot) {
  if (!s.id) return
  // 显式记 todo：过去的时段按时间推断会变回 done，撤销就必须留一个标记
  slots.setStatus(today.value, s.id, 'todo')
}

/* ------------------------------ 编辑 ------------------------------ */

const editor = ref({
  open: false,
  id: 0,
  name: '',
  kind: 'study' as SlotKind,
  start: '08:00',
  end: '08:45',
  days: [1] as number[],
  targetName: '',
  bvid: '',
  remindOn: true,
  remindLead: 5,
  note: '',
})

const editorTitle = computed(() => (editor.value.id ? '编辑时段' : '添加时段'))

function openCreate(weekday = todayWd.value, seed?: { start?: string; end?: string }) {
  const start = seed?.start || '08:00'
  const end = seed?.end || '08:45'
  editor.value = {
    open: true,
    id: 0,
    name: '',
    kind: 'study',
    start,
    end,
    days: [weekday],
    targetName: '',
    bvid: '',
    remindOn: true,
    remindLead: 5,
    note: '',
  }
}

function openEdit(s: ScheduleSlot) {
  editor.value = {
    open: true,
    id: Number(s.id) || 0,
    name: s.name,
    kind: s.kind || 'study',
    start: s.start,
    end: s.end,
    days: Array.isArray(s.days) && s.days.length ? [...s.days] : [1],
    targetName: s.targetName || '',
    bvid: s.bvid || '',
    remindOn: !!s.remindOn,
    remindLead: Number(s.remindLead) || 0,
    note: s.note || '',
  }
}

function toggleDay(d: number) {
  const days = editor.value.days
  const i = days.indexOf(d)
  if (i >= 0) {
    if (days.length > 1) days.splice(i, 1)
  } else {
    days.push(d)
    days.sort((a, b) => a - b)
  }
}

async function saveSlot() {
  const e = editor.value
  if (!e.name.trim()) {
    ui.err('「做什么」不能为空，比如 新三 / 冥想 / 阅读')
    return
  }
  if (minutesOf(e.start) < 0 || minutesOf(e.end) < 0) {
    ui.err('起止时间要写成 HH:MM')
    return
  }
  if (minutesOf(e.end) <= minutesOf(e.start)) {
    ui.err('结束时间要晚于开始时间')
    return
  }
  // 同一天里和别的时段重叠时提醒一下（不阻止，学习/休息本来可能并排）
  const overlap = slots.list.find(
    (x) =>
      Number(x.id) !== Number(e.id) &&
      Array.isArray(x.days) &&
      x.days.some((d) => e.days.includes(Number(d))) &&
      minutesOf(x.start) < minutesOf(e.end) &&
      minutesOf(x.end) > minutesOf(e.start),
  )
  const rec = await slots.save({
    id: e.id || undefined,
    name: e.name,
    kind: e.kind,
    start: e.start,
    end: e.end,
    days: e.days,
    color: 'blue',
    targetName: e.targetName,
    bvid: normalizeBvid(e.bvid),
    remindOn: e.remindOn,
    remindLead: e.remindLead,
    note: e.note,
  })
  if (rec) {
    editor.value.open = false
    if (overlap) ui.toast(`和「${overlap.name}」重叠了，留意一下`, 'info', 3000)
  }
}

async function removeCurrent() {
  const e = editor.value
  if (!e.id) return
  const ok = await slots.remove(e.id)
  if (ok) editor.value.open = false
}

/* ------------------------------ 粘贴导入 ------------------------------ */

const paste = ref({ open: false, text: '', days: [1] as number[] })
const pastePreview = computed(() => parsePlanText(paste.value.text))

function openPaste() {
  paste.value = { open: true, text: '', days: [todayWd.value] }
}

function togglePasteDay(d: number) {
  const days = paste.value.days
  const i = days.indexOf(d)
  if (i >= 0) {
    if (days.length > 1) days.splice(i, 1)
  } else {
    days.push(d)
    days.sort((a, b) => a - b)
  }
}

async function generateFromPaste() {
  const rows = pastePreview.value.rows
  if (!rows.length) {
    ui.err('没识别到时段，检查一下是不是四列：开始 结束 做什么 类型')
    return
  }
  const days = paste.value.days
  let n = 0
  for (const d of days) {
    for (const r of rows) {
      if (minutesOf(r.end) <= minutesOf(r.start)) continue
      const rec = await slots.save(
        {
          name: r.name,
          kind: r.kind,
          start: r.start,
          end: r.end,
          days: [d],
          color: 'blue',
          remindOn: true,
          remindLead: 5,
        },
        { silent: true },
      )
      if (rec) n++
    }
  }
  paste.value.open = false
  ui.ok(`已生成 ${n} 个时段（${days.map((d) => WEEKDAY_LABELS[d - 1]).join('、')}）`)
}

/* ------------------------------ 生命周期 ------------------------------ */

onMounted(async () => {
  await settings.init()
  await slots.init()
  timer = window.setInterval(() => {
    nowMin.value = new Date().getHours() * 60 + new Date().getMinutes()
  }, 20 * 1000)
})

onUnmounted(() => {
  if (timer) window.clearInterval(timer)
})
</script>

<template>
  <div class="schedule-page">
    <div class="page-head">
      <h1>课表</h1>
      <span class="muted sc-sub">
        {{ WEEKDAY_LABELS[todayWd - 1] }} · 今日 {{ todayList.length }} 项
        <template v-if="stat.studyCount"> · 学习 {{ fmtDur(stat.plan) }}</template>
      </span>
      <span class="grow" />
      <div class="seg sc-seg">
        <button :class="{ on: tab === 'today' }" @click="tab = 'today'">今日</button>
        <button :class="{ on: tab === 'week' }" @click="tab = 'week'">全周</button>
      </div>
      <button class="btn sm" title="从表格粘贴" @click="openPaste()">
        <Icon name="list" :size="14" /> 粘贴
      </button>
      <button class="btn sm primary" title="添加时段" @click="openCreate()">
        <Icon name="plus" :size="14" /> 添加时段
      </button>
    </div>

    <template v-if="tab === 'today'">
      <div v-if="!todayList.length" class="sc-empty">
        <div class="sc-empty-icon"><Icon name="calendar" :size="26" /></div>
        <b>今天还没有计划</b>
        <p class="muted">把 WPS 里那张表复制过来（开始 · 结束 · 做什么 · 类型），或者手动加一个时段。</p>
        <div class="row" style="gap: 8px; justify-content: center">
          <button class="btn primary" @click="openPaste()">从表格粘贴</button>
          <button class="btn" @click="openCreate()">添加时段</button>
        </div>
      </div>

      <template v-else>
        <div class="sc-body">
          <div class="sc-main">
            <section v-if="current" class="now-card">
              <div class="now-main">
                <span class="chip-now"><i class="live-dot" />现在进行中</span>
                <div class="now-name">{{ current.name }}</div>
                <div class="now-meta">
                  <b>{{ current.start }} – {{ current.end }}</b> · {{ current.kind === 'break' ? '休息' : '学习' }}
                  {{ fmtDur(durOf(current)) }}
                  <template v-if="current.targetName"> · 关联「{{ current.targetName }}」</template>
                </div>
                <div class="now-btns">
                  <button class="btn primary" @click="startFocus(current)">开始专注</button>
                  <button class="btn ghost" @click="completeSlot(current)">标记完成</button>
                  <button class="btn ghost" @click="skipSlot(current)">跳过</button>
                </div>
              </div>
              <div class="ring" :style="{ background: ringBg }">
                <div class="ring-in">
                  <b>{{ fmtLeft(currentRemain) }}</b>
                  <span>剩余 · 已过 {{ currentPct }}%</span>
                </div>
              </div>
            </section>

            <section v-else class="now-card now-idle">
              <div class="now-main">
                <span class="chip-now idle"><i class="live-dot" />现在</span>
                <div class="now-name">{{ nextSlot ? '还不到下一项' : '今天的计划已经走完' }}</div>
                <div class="now-meta">
                  <template v-if="nextSlot">下一项 <b>{{ nextSlot.start }} {{ nextSlot.name }}</b>，{{ startText(nextSlot) }}开始</template>
                  <template v-else>想加点什么就点右上角「添加时段」。</template>
                </div>
              </div>
            </section>

            <div v-if="nextSlot" class="next-strip">
              <span class="next-tag">下一项</span>
              <b>{{ nextSlot.start }} – {{ nextSlot.end }} {{ nextSlot.name }}</b>
              <span class="muted">· {{ nextSlot.kind === 'break' ? '休息' : '学习' }} {{ fmtDur(durOf(nextSlot)) }} · {{ startText(nextSlot) }}开始</span>
            </div>

            <div class="tl">
              <template v-for="g in groups" :key="g.part">
                <div class="tl-sec">
                  <span>{{ g.part }}</span>
                  <i />
                </div>
                <div
                  v-for="s in g.items"
                  :key="'s' + s.id"
                  class="tl-item"
                  :class="[statusOf(s)]"
                  :data-slot="s.id"
                  :data-status="statusOf(s)"
                  @click="openEdit(s)"
                >
                  <span class="tl-time mono">{{ s.start }}–{{ s.end }}</span>
                  <span class="tl-dot" />
                  <span class="tl-name">
                    {{ s.name }}
                    <em>{{ s.kind === 'break' ? '休息' : '学习' }} {{ fmtDur(durOf(s)) }}</em>
                  </span>
                  <span class="tl-right">
                    <template v-if="statusOf(s) === 'doing'">
                      <button class="btn mini" @click.stop="startFocus(s)">专注</button>
                      <button class="btn mini ghost" @click.stop="skipSlot(s)">跳过</button>
                    </template>
                    <template v-else-if="statusOf(s) === 'done'">
                      <button class="tl-check" title="撤销" @click.stop="undoSlot(s)">✓</button>
                    </template>
                    <template v-else-if="statusOf(s) === 'skipped'">
                      <button class="tl-skip" title="撤销" @click.stop="undoSlot(s)">已跳过</button>
                    </template>
                    <span v-else class="tl-todo">待开始</span>
                  </span>
                </div>
              </template>
            </div>
          </div>

          <aside class="sc-aside">
            <div class="sc-card">
              <div class="sc-card-h">今日进度</div>
              <div class="stat-row">
                <div class="stat"><b>{{ stat.done }} / {{ stat.total }}</b><span>已完成</span></div>
                <div class="stat"><b>{{ fmtDur(stat.learned) }}</b><span>已学习</span></div>
                <div class="stat"><b>{{ fmtDur(stat.plan) }}</b><span>计划</span></div>
              </div>
              <div class="bar"><i :style="{ width: progress + '%' }" /></div>
              <div class="bar-label">
                <span>完成度 {{ progress }}%</span>
                <span v-if="nextSlot">下一项 {{ nextSlot.start }}</span>
              </div>
            </div>

            <div v-if="nextList.length" class="sc-card">
              <div class="sc-card-h">接下来</div>
              <div v-for="s in nextList" :key="'n' + s.id" class="next-row">
                <div class="next-time mono">{{ s.start }}<span>{{ startText(s) }}</span></div>
                <div class="next-name">
                  {{ s.name }}
                  <em>{{ s.kind === 'break' ? '休息' : '学习' }} {{ fmtDur(durOf(s)) }}</em>
                </div>
              </div>
            </div>

            <div class="sc-card">
              <div class="sc-card-h">提醒</div>
              <div class="tip">
                每个时段开始前 5 分钟弹右下角卡片（每条可单独改）；开始时刻可选系统通知。都走设置里的提醒开关。
              </div>
            </div>

            <div class="sc-card">
              <div class="sc-card-h">清理</div>
              <div class="row" style="gap: 8px; flex-wrap: wrap">
                <button class="btn sm ghost" @click="slots.clearAll(true)">清空今天</button>
              </div>
            </div>
          </aside>
        </div>
      </template>
    </template>

    <template v-else>
      <div class="week">
        <div v-for="col in weekCols" :key="col.weekday" class="wk-col" :class="{ today: col.today }">
          <div class="wk-head">
            <b>{{ col.label }}</b>
            <span>{{ col.today ? '今天' : col.list.length + ' 项' }}</span>
          </div>
          <div class="wk-body">
            <button
              v-for="s in col.list"
              :key="'w' + col.weekday + '-' + s.id"
              class="wk-blk"
              :class="{ brk: s.kind === 'break', live: col.today && isDoing(s) }"
              :title="`${s.name} ${s.start}–${s.end}`"
              @click="openEdit(s)"
            >
              <span class="wk-time mono">{{ s.start }}</span>
              <span class="wk-name">{{ s.name }}</span>
            </button>
            <div v-if="!col.list.length" class="wk-empty muted">—</div>
          </div>
        </div>
      </div>
    </template>

    <!-- 编辑时段：右侧抽屉 -->
    <div v-if="editor.open" class="overlay" @click.self="editor.open = false">
      <div class="drawer" role="dialog" aria-label="编辑时段">
        <div class="drawer-head">
          <h3>{{ editorTitle }}</h3>
          <p class="muted">{{ editor.start }} – {{ editor.end }} · {{ editor.days.map((d) => WEEKDAY_LABELS[d - 1]).join('、') }}</p>
        </div>

        <label class="field">
          <span>做什么</span>
          <input v-model="editor.name" class="input" name="slotName" type="text" maxlength="40" placeholder="新三 / 冥想 / 阅读 / 跟读…" />
        </label>

        <label class="field">
          <span>类型</span>
          <span class="seg2">
            <button :class="{ on: editor.kind === 'study' }" @click="editor.kind = 'study'">学习</button>
            <button :class="{ on: editor.kind === 'break' }" @click="editor.kind = 'break'">休息</button>
          </span>
        </label>

        <div class="row sc-form-row">
          <label class="field">
            <span>开始</span>
            <input v-model="editor.start" class="input" name="slotStart" type="time" />
          </label>
          <label class="field">
            <span>结束</span>
            <input v-model="editor.end" class="input" name="slotEnd" type="time" />
          </label>
        </div>

        <label class="field">
          <span>星期（可多选）</span>
          <span class="days">
            <button v-for="(label, i) in WEEKDAY_LABELS" :key="label" class="day-chip" :class="{ on: editor.days.includes(i + 1) }" @click="toggleDay(i + 1)">
              {{ label.slice(1) }}
            </button>
          </span>
        </label>

        <label class="field">
          <span>关联专注目标</span>
          <select v-model="editor.targetName" class="input" name="slotTarget">
            <option value="">不关联</option>
            <option v-for="t in activeTargets" :key="t.name" :value="t.name">{{ t.name }}</option>
          </select>
        </label>

        <label class="field">
          <span>关联 B 站视频（选填）</span>
          <input v-model="editor.bvid" class="input" name="slotBvid" type="text" maxlength="120" placeholder="BV 号或视频链接" />
        </label>

        <label class="field">
          <span>提醒</span>
          <span class="row" style="gap: 10px; align-items: center; flex-wrap: wrap">
            <label class="switch-line">
              <input v-model="editor.remindOn" type="checkbox" /> 开始前提醒
            </label>
            <span class="row" style="gap: 6px; align-items: center">
              <input v-model.number="editor.remindLead" class="input input-mini" type="number" min="0" max="60" step="5" /> 分钟
            </span>
          </span>
        </label>

        <label class="field">
          <span>备注</span>
          <textarea v-model="editor.note" class="input" rows="2" maxlength="200" placeholder="选填"></textarea>
        </label>

        <div class="drawer-foot">
          <button v-if="editor.id" class="btn danger" @click="removeCurrent">删除这个时段</button>
          <span class="grow" />
          <button class="btn" @click="editor.open = false">取消</button>
          <button class="btn primary" @click="saveSlot">保存</button>
        </div>
      </div>
    </div>

    <!-- 从表格粘贴 -->
    <div v-if="paste.open" class="overlay" @click.self="paste.open = false">
      <div class="paste-modal" role="dialog" aria-label="从表格粘贴">
        <h3>从表格粘贴计划</h3>
        <p class="muted" style="font-size: 12px; margin: 4px 0 12px">
          从 WPS / Excel 复制四列：开始 · 结束 · 做什么 · 类型；没有「类型」列时按关键词判断（冥想/休息/运动 = 休息）。
        </p>
        <div class="paste-body">
          <textarea
            v-model="paste.text"
            class="input paste-ta"
            name="pasteText"
            rows="10"
            placeholder="06:00 06:15 跟读 学习&#10;07:00 07:45 新三 学习&#10;07:45 08:00 冥想 休息"
          />
          <div class="paste-preview">
            <b>识别结果 · {{ pastePreview.rows.length }} 项</b>
            <div v-for="(r, i) in pastePreview.rows.slice(0, 6)" :key="'p' + i" class="pv">
              <i /> {{ r.start }}–{{ r.end }} {{ r.name }} · {{ r.kind === 'break' ? '休息' : '学习' }}
            </div>
            <div v-if="pastePreview.rows.length > 6" class="pv muted">… 还有 {{ pastePreview.rows.length - 6 }} 项</div>
            <div v-if="pastePreview.skipped" class="pv muted">跳过 {{ pastePreview.skipped }} 行（表头/分隔行）</div>
          </div>
        </div>
        <div class="paste-days">
          <span class="muted">添加到：</span>
          <button v-for="(label, i) in WEEKDAY_LABELS" :key="'pd' + i" class="day-chip" :class="{ on: paste.days.includes(i + 1) }" @click="togglePasteDay(i + 1)">
            {{ label.slice(1) }}
          </button>
        </div>
        <div class="row" style="justify-content: flex-end; gap: 8px; margin-top: 12px">
          <button class="btn" @click="paste.open = false">取消</button>
          <button class="btn primary" :disabled="!pastePreview.rows.length" @click="generateFromPaste">
            生成 {{ pastePreview.rows.length * paste.days.length }} 个时段
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.schedule-page {
  padding: 0 0 24px;
}
.sc-sub {
  font-size: 12.5px;
}
.sc-seg {
  display: inline-flex;
  background: var(--soft);
  border-radius: 10px;
  padding: 2px;
  gap: 2px;
}
.sc-seg button {
  border: 0;
  background: transparent;
  color: var(--t2);
  font-size: 12.5px;
  padding: 5px 12px;
  border-radius: 8px;
  cursor: pointer;
}
.sc-seg button.on {
  background: var(--card);
  color: var(--t1);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}

/* 空状态 */
.sc-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 46px 0 30px;
  text-align: center;
}
.sc-empty-icon {
  width: 54px;
  height: 54px;
  border-radius: 16px;
  background: var(--soft);
  display: grid;
  place-items: center;
  color: var(--t3);
}
.sc-empty p {
  font-size: 12.5px;
  margin-bottom: 6px;
}

/* 主体两栏 */
.sc-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 288px;
  gap: 20px;
  align-items: start;
  margin-top: 14px;
}
.sc-main {
  min-width: 0;
}
.sc-aside {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 现在卡片 */
.now-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 18px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius-md, 16px);
  padding: 18px 20px 16px 22px;
  overflow: hidden;
}
.now-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  background: var(--brand);
}
.now-main {
  flex: 1;
  min-width: 0;
}
.chip-now {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--brand);
  background: var(--brand-soft);
  padding: 3px 9px;
  border-radius: 999px;
}
.live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--brand);
}
.now-name {
  font-size: 30px;
  font-weight: 700;
  letter-spacing: -0.5px;
  margin: 10px 0 4px;
  line-height: 1.2;
}
.now-meta {
  font-size: 13px;
  color: var(--t2);
}
.now-meta b {
  color: var(--t1);
}
.now-btns {
  display: flex;
  gap: 8px;
  margin-top: 14px;
  flex-wrap: wrap;
}
.ring {
  position: relative;
  width: 108px;
  height: 108px;
  flex: 0 0 108px;
  border-radius: 50%;
  display: grid;
  place-items: center;
}
.ring::after {
  content: '';
  position: absolute;
  inset: 9px;
  background: var(--card);
  border-radius: 50%;
}
.ring-in {
  position: relative;
  z-index: 1;
  text-align: center;
}
.ring-in b {
  display: block;
  font-size: 18px;
  letter-spacing: -0.3px;
}
.ring-in span {
  font-size: 10.5px;
  color: var(--t3);
}
.now-idle {
  border-style: dashed;
}
.now-idle::before {
  background: var(--line-strong);
}
.chip-now.idle {
  color: var(--t2);
  background: var(--soft);
}
.chip-now.idle .live-dot {
  background: var(--t3);
}

.next-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 10px 2px 2px;
  font-size: 12.5px;
  color: var(--t2);
}
.next-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--soft);
  color: var(--t2);
}

/* 时间轴 */
.tl {
  margin-top: 8px;
}
.tl-sec {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 14px 2px 6px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--t3);
  letter-spacing: 0.5px;
}
.tl-sec i {
  flex: 1;
  height: 1px;
  background: var(--line);
}
.tl-item {
  display: grid;
  grid-template-columns: 96px 12px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: 10px;
  cursor: pointer;
  border: 1px solid transparent;
}
.tl-item:hover {
  background: var(--card-hover);
}
.tl-item.doing {
  background: var(--brand-soft);
}
.tl-time {
  font-size: 12px;
  color: var(--t3);
}
.tl-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--line-strong);
}
.tl-item.doing .tl-dot {
  background: var(--brand);
  box-shadow: 0 0 0 4px var(--brand-soft);
}
.tl-name {
  font-size: 13.5px;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tl-name em {
  font-style: normal;
  font-size: 11px;
  color: var(--t3);
  margin-left: 8px;
}
.tl-item.done .tl-name,
.tl-item.done .tl-time {
  color: var(--t2);
}
.tl-item.skipped .tl-name {
  text-decoration: line-through;
  color: var(--t3);
}
.tl-right {
  display: flex;
  align-items: center;
  gap: 6px;
}
.tl-todo {
  font-size: 11.5px;
  color: var(--t3);
}
.tl-check {
  border: 0;
  background: transparent;
  color: var(--ok);
  font-size: 13px;
  cursor: pointer;
  padding: 2px 4px;
}
.tl-skip {
  border: 0;
  background: transparent;
  color: var(--t3);
  font-size: 11.5px;
  cursor: pointer;
}
.tl-item.doing .tl-right {
  margin-right: 2px;
}

/* 右栏卡片 */
.sc-card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 13px;
  padding: 13px 14px;
}
.sc-card-h {
  font-size: 11px;
  font-weight: 600;
  color: var(--t3);
  letter-spacing: 0.5px;
  margin-bottom: 10px;
}
.stat-row {
  display: flex;
  gap: 6px;
}
.stat {
  flex: 1;
  text-align: center;
}
.stat b {
  font-size: 16px;
  letter-spacing: -0.3px;
}
.stat span {
  display: block;
  font-size: 10.5px;
  color: var(--t3);
  margin-top: 2px;
}
.bar {
  height: 5px;
  border-radius: 99px;
  background: var(--soft);
  overflow: hidden;
  margin-top: 10px;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--t1);
  border-radius: 99px;
  transition: width 0.3s;
}
.bar-label {
  display: flex;
  justify-content: space-between;
  font-size: 10.5px;
  color: var(--t3);
  margin-top: 6px;
}
.next-row {
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding: 5px 0;
}
.next-time {
  font-size: 13px;
  font-weight: 600;
  width: 62px;
  flex: 0 0 62px;
}
.next-time span {
  display: block;
  font-size: 10.5px;
  color: var(--t3);
  font-weight: 400;
}
.next-name {
  font-size: 12.5px;
  min-width: 0;
}
.next-name em {
  font-style: normal;
  font-size: 10.5px;
  color: var(--t3);
  margin-left: 5px;
}
.tip {
  font-size: 11.5px;
  color: var(--t3);
  line-height: 1.7;
}

/* 全周 */
.week {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 8px;
  margin-top: 14px;
}
.wk-col {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--card);
  min-height: 240px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.wk-col.today {
  border-color: var(--brand-line);
  background: var(--brand-soft);
}
.wk-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 8px 9px 6px;
  border-bottom: 1px solid var(--line);
  font-size: 12px;
}
.wk-head span {
  font-size: 10.5px;
  color: var(--t3);
}
.wk-col.today .wk-head b {
  color: var(--brand);
}
.wk-body {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 7px;
}
.wk-blk {
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: left;
  padding: 5px 7px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--soft);
  color: inherit;
  cursor: pointer;
}
.wk-blk:hover {
  background: var(--card-hover);
}
.wk-blk.brk {
  background: transparent;
  border-style: dashed;
}
.wk-blk.live {
  background: var(--brand);
  border-color: var(--brand);
  color: #fff;
}
.wk-time {
  font-size: 10px;
  color: var(--t3);
}
.wk-blk.live .wk-time {
  color: rgba(255, 255, 255, 0.8);
}
.wk-name {
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wk-empty {
  text-align: center;
  font-size: 11px;
  padding: 10px 0;
}

/* 抽屉 */
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(10, 10, 14, 0.34);
  z-index: 60;
  display: flex;
  align-items: stretch;
  justify-content: flex-end;
}
.drawer {
  width: min(430px, 100%);
  background: var(--bg-elev);
  border-left: 1px solid var(--line);
  padding: 20px 22px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  animation: slide-in 0.18s ease-out;
}
@keyframes slide-in {
  from {
    transform: translateX(20px);
    opacity: 0.6;
  }
}
.drawer-head h3 {
  font-size: 17px;
  margin: 0 0 4px;
}
.drawer-head p {
  font-size: 12px;
}
.drawer-foot {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}
.seg2 {
  display: inline-flex;
  background: var(--soft);
  border-radius: 10px;
  padding: 2px;
  width: 100%;
}
.seg2 button {
  flex: 1;
  border: 0;
  background: transparent;
  padding: 7px 0;
  border-radius: 8px;
  font-size: 12.5px;
  color: var(--t2);
  cursor: pointer;
}
.seg2 button.on {
  background: var(--card);
  color: var(--t1);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}
.sc-form-row {
  display: flex;
  gap: 10px;
}
.sc-form-row > .field {
  flex: 1;
  min-width: 0;
}
.days {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.day-chip {
  min-width: 34px;
  height: 32px;
  border-radius: 9px;
  border: 0;
  background: var(--soft);
  color: var(--t2);
  font-size: 12.5px;
  cursor: pointer;
}
.day-chip.on {
  background: var(--t1);
  color: #fff;
  font-weight: 600;
}
.switch-line {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
}
.input-mini {
  width: 62px;
  padding: 4px 8px;
}

/* 粘贴弹层 */
.paste-modal {
  width: min(760px, 100%);
  margin: auto;
  background: var(--bg-elev);
  border-radius: 16px;
  padding: 20px 22px;
  box-shadow: var(--shadow);
}
.paste-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: 14px;
}
.paste-ta {
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 12px;
  line-height: 1.7;
  resize: vertical;
  padding: 10px 12px;
}
.paste-preview {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 12px;
  height: 100%;
  overflow: hidden;
  font-size: 11.5px;
  color: var(--t2);
}
.paste-preview b {
  display: block;
  font-size: 11px;
  color: var(--t3);
  letter-spacing: 0.4px;
  margin-bottom: 8px;
}
.pv {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}
.pv i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ok);
  flex: 0 0 6px;
}
.paste-days {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 12px;
  font-size: 12px;
}

@media (max-width: 900px) {
  .sc-body {
    grid-template-columns: 1fr;
  }
  .paste-body {
    grid-template-columns: 1fr;
  }
  .week {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
