<script setup lang="ts">
/**
 * 习惯打卡页 /habit
 *
 * 还原自 HabitView-Dj73W_T2.js：
 * 左列是习惯列表（坚持中 / 已归档 两个 tab），右列是选中习惯的
 * 统计、月历和打卡日志；新建/编辑走一个 modal。
 * 状态与业务逻辑都在 useHabitsStore 里，这里只负责呈现。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useHabitsStore, WEEKDAYS } from '@/stores/habits'
import Icon from '@/components/Icon.vue'
import { todayStr } from '@/utils/format'

const store = useHabitsStore()

/** 习惯没有头像，用名字哈希稳定挑一个 emoji 当"脸" */
const EMOJI = ['🙂', '📖', '🏃', '🧘', '✍️', '🎧', '🌙', '☀️', '💪', '🍵', '🧹', '🎹']

function faceOf(habit: any) {
  const name = String((habit && habit.name) || '')
  let sum = 0
  for (let i = 0; i < name.length; i++) sum = (sum + name.charCodeAt(i)) % 997
  return EMOJI[sum % EMOJI.length]
}

/** "2024-05-03" → "周五" */
function weekdayOf(day: string) {
  const [y, m, d] = String(day || '')
    .split('-')
    .map(Number)
  const date = new Date(y || 1970, (m || 1) - 1, d || 1)
  return `周${WEEKDAYS[(date.getDay() + 6) % 7]}`
}

const selectedId = computed(() => (store.selected ? Number(store.selected.id) : 0))
const cal = computed(() => store.calendar(store.viewMonth))
const logGroups = computed(() => store.logGroups)
const stats = computed(() => store.selectedStats || ({} as any))
const activeCount = computed(() => store.activeHabits.length)
const archivedCount = computed(() => store.archivedHabits.length)

function statsOf(id: number | string) {
  return store.statsOf(id)
}

const form = ref({
  open: false,
  id: 0,
  name: '',
  targetDays: 100,
  remindAt: '08:00',
  remindOn: false,
  note: '',
})
const modalTitle = computed(() => (form.value.id ? '编辑习惯' : '新建习惯'))

function openCreate() {
  form.value = {
    open: true,
    id: 0,
    name: '',
    targetDays: 100,
    remindAt: '08:00',
    remindOn: true,
    note: '',
  }
}

function openEdit(habit: any) {
  form.value = {
    open: true,
    id: Number(habit.id) || 0,
    name: habit.name || '',
    targetDays: Number(habit.targetDays) || 100,
    remindAt: /^\d{2}:\d{2}$/.test(String(habit.remindAt || '')) ? habit.remindAt : '08:00',
    remindOn: !!habit.remindOn,
    note: habit.note || '',
  }
}

async function save() {
  const payload = {
    name: String(form.value.name || '').trim(),
    targetDays: Number(form.value.targetDays) || 100,
    remindAt: String(form.value.remindAt || ''),
    remindOn: !!form.value.remindOn,
    note: String(form.value.note || ''),
  }
  // 名字为空交给 store 去校验报错（"习惯名不能为空"）
  if (!payload.name) {
    store.create({ name: '' })
    return
  }
  if (form.value.id) {
    await store.update(form.value.id, payload)
  } else {
    await store.create(payload)
  }
  form.value.open = false
}

/** 月历点格子：空格 / 未来 / 没选中习惯都不响应 */
async function toggleDay(cell: any) {
  if (!cell || cell.future || !selectedId.value) return
  await store.toggle(selectedId.value, cell.day)
}

async function toggleToday(id: number | string) {
  await store.toggle(id, todayStr())
}

// 切到没有月份的习惯时（比如刚建完），把月历拉回本月
watch(
  () => store.selectedId,
  () => {
    if (!store.viewMonth) store.focusMonthOf(todayStr())
  },
)

onMounted(async () => {
  await store.init()
  store.focusMonthOf(todayStr())

  // 原构建里留给自动化的探针（APK 中同样存在，保留）
  const raw = (value: any) => JSON.parse(JSON.stringify(value === undefined ? null : value))
  ;(window as any).__habitProbe = () =>
    raw({
      hash: location.hash,
      tab: store.tab,
      counts: { active: activeCount.value, archived: archivedCount.value, logs: store.logCount },
      today: { day: todayStr(), done: store.todayDone, total: store.activeHabits.length },
      selected: store.selected
        ? { id: Number(store.selected.id), name: store.selected.name }
        : null,
      viewMonth: store.viewMonth,
      calendar: {
        label: cal.value.label,
        done: cal.value.weeks.flat().filter((c: any) => c && c.done).map((c: any) => c.day),
      },
      habits: store.habits.map((h: any) => {
        const s = statsOf(h.id)
        return {
          id: Number(h.id),
          name: h.name,
          targetDays: Number(h.targetDays) || 0,
          remindAt: h.remindAt || '',
          remindOn: !!h.remindOn,
          archived: Number(h.archived) || 0,
          total: s.total,
          streak: s.streak,
          best: s.best,
          monthDone: s.monthDone,
          monthRate: Math.round(s.monthRate * 1e3) / 1e3,
          todayDone: s.todayDone,
        }
      }),
      logGroups: logGroups.value.map((g: any) => ({
        date: g.date,
        names: g.items.map((i: any) => i.name),
      })),
      lastReminder: store.lastReminder,
      fired: store.firedFor(),
    })
  ;(window as any).__habitRemindCheck = (at: any, day: any) =>
    raw(store.checkReminders(at, day))
  ;(window as any).__habitRemindAt = (at: any, day: any) => {
    ;(window as any).__habitRemindResult = null
    store
      .runReminders(at, day, { notify: true })
      .then((res: any) => {
        ;(window as any).__habitRemindResult = raw(res)
      })
      .catch((e: any) => {
        ;(window as any).__habitRemindResult = { error: String((e && e.message) || e) }
      })
    return true
  }
  ;(window as any).__habitRemindStop = () => (store.stopReminders(), true)
  ;(window as any).__habitRemindReset = () => {
    try {
      localStorage.removeItem('study-bili-habit-remind')
    } catch {}
    store.lastReminder = null
    return true
  }
})

onBeforeUnmount(() => {
  for (const key of [
    '__habitProbe',
    '__habitRemindCheck',
    '__habitRemindAt',
    '__habitRemindStop',
    '__habitRemindReset',
  ]) {
    try {
      ;(window as any)[key] = null
    } catch {}
  }
})
</script>

<template>
  <div class="habit-page">
    <div class="page-head">
      <h1>习惯打卡</h1>
      <span class="muted hb-today">
        今天 {{ store.todayDone }}/{{ store.activeHabits.length }}
      </span>
      <div class="grow"></div>
      <div class="row" style="gap: 8px; flex: none">
        <button class="btn sm" title="清空所有习惯与记录" @click="store.clearAll()">
          <Icon name="trash" :size="14" /> 清空
        </button>
        <button class="btn primary" @click="openCreate">
          <Icon name="plus" :size="15" /> 新建习惯
        </button>
      </div>
    </div>

    <div class="hb-wrap">
      <div class="card hb-left">
        <div class="tabs hb-tabs">
          <div
            :class="['tab', { on: store.tab === 'active' }]"
            @click="store.setTab('active')"
          >
            坚持中 {{ activeCount }}
          </div>
          <div
            :class="['tab', { on: store.tab === 'archived' }]"
            @click="store.setTab('archived')"
          >
            已归档 {{ archivedCount }}
          </div>
        </div>

        <div v-if="!store.list.length" class="empty">
          {{
            store.tab === 'archived'
              ? '还没有归档的习惯。'
              : '还没有习惯，点右上角「新建习惯」加一个。'
          }}
        </div>

        <div
          v-for="habit in store.list"
          :key="habit.id"
          :class="[
            'hb-row',
            { on: Number(habit.id) === store.selectedId, off: !!habit.archived },
          ]"
          @click="store.select(habit.id)"
        >
          <span class="hb-face">{{ faceOf(habit) }}</span>
          <span class="hb-info">
            <span class="hb-name clamp-1">{{ habit.name }}</span>
            <span class="hb-sub muted">
              {{ statsOf(habit.id).total }} 天共坚持
              <template v-if="habit.remindOn && habit.remindAt">
                · {{ habit.remindAt }} 提醒
              </template>
            </span>
          </span>
          <span class="hb-dots">
            <span
              v-for="d in statsOf(habit.id).last7"
              :key="d.day"
              :class="['hb-dot', { on: d.done, today: d.today }]"
              :title="d.day + (d.done ? ' 已打卡' : ' 未打卡')"
            ></span>
          </span>
          <span class="hb-count">
            <b>{{ statsOf(habit.id).total }}</b>
            <em>/{{ Number(habit.targetDays) || 100 }}</em>
          </span>
          <button
            :class="['btn sm hb-check', statsOf(habit.id).todayDone ? 'ghost' : 'primary']"
            @click.stop="toggleToday(habit.id)"
          >
            {{ statsOf(habit.id).todayDone ? '已打卡' : '打卡' }}
          </button>
        </div>
      </div>

      <div class="hb-right">
        <template v-if="store.selected">
          <div class="card hb-detail">
            <div class="row hb-detail-head">
              <span class="hb-face big">{{ faceOf(store.selected) }}</span>
              <span class="grow">
                <b>{{ store.selected.name }}</b>
                <span class="muted hb-detail-sub">
                  目标 {{ stats.target }} 天
                  <template v-if="store.selected.remindOn && store.selected.remindAt">
                    · 每天 {{ store.selected.remindAt }} 提醒
                  </template>
                  <template v-else>· 没开提醒</template>
                </span>
              </span>
              <button class="btn sm" @click="openEdit(store.selected)">编辑</button>
              <button
                class="btn sm"
                @click="store.archive(store.selected.id, !store.selected.archived)"
              >
                {{ store.selected.archived ? '恢复' : '归档' }}
              </button>
              <button class="btn sm danger" @click="store.remove(store.selected.id)">
                删除
              </button>
            </div>

            <div class="hb-stats">
              <div class="hb-stat">
                <span class="k">月打卡</span>
                <span class="v">{{ stats.monthDone }} <small>天</small></span>
              </div>
              <div class="hb-stat">
                <span class="k">总打卡</span>
                <span class="v">{{ stats.total }} <small>天</small></span>
              </div>
              <div class="hb-stat">
                <span class="k">月完成率</span>
                <span class="v">{{ Math.round(stats.monthRate * 100) }} <small>%</small></span>
              </div>
              <div class="hb-stat">
                <span class="k">当前连续</span>
                <span class="v">{{ stats.streak }} <small>天</small></span>
              </div>
            </div>

            <div class="hb-goal">
              <div class="hb-goal-bar">
                <i :style="{ width: Math.round(stats.dayRate * 100) + '%' }"></i>
              </div>
              <span class="muted">
                目标 {{ stats.target }} 天 · 已坚持 {{ stats.total }} 天 · 最长连续
                {{ stats.best }} 天
                <template v-if="stats.achieved"> · 已达成 🎉</template>
              </span>
            </div>
          </div>

          <div class="card hb-cal">
            <div class="row hb-cal-head">
              <button class="btn sm ghost" title="上个月" @click="store.monthMove(-1)">
                <Icon name="left" :size="14" />
              </button>
              <b class="grow hb-cal-title">{{ cal.label }}</b>
              <button class="btn sm ghost" title="下个月" @click="store.monthMove(1)">
                <Icon name="right" :size="14" />
              </button>
            </div>
            <div class="hb-week">
              <span v-for="w in WEEKDAYS" :key="w">{{ w }}</span>
            </div>
            <div class="hb-grid">
              <template v-for="(week, wi) in cal.weeks" :key="wi">
                <template v-for="(cell, ci) in week" :key="wi + '-' + ci">
                  <span
                    :class="[
                      'hb-cell',
                      {
                        blank: !cell,
                        done: cell && cell.done,
                        today: cell && cell.today,
                        future: cell && cell.future,
                      },
                    ]"
                    :title="cell ? cell.day : ''"
                    @click="toggleDay(cell)"
                  >
                    <span v-if="cell">{{ cell.num }}</span>
                  </span>
                </template>
              </template>
            </div>
            <div class="muted hb-cal-tip">点某一天可以补打或取消（未来的日子点不动）</div>
          </div>

          <div class="card hb-logs">
            <div class="row hb-logs-head">
              <b class="grow">打卡日志</b>
              <span class="muted">{{ store.logCount }} 条</span>
            </div>
            <div v-if="!logGroups.length" class="empty">还没有打卡记录。</div>
            <div v-for="group in logGroups" :key="group.date" class="hb-log-day">
              <span class="hb-log-date mono">{{ group.date }} {{ weekdayOf(group.date) }}</span>
              <span class="hb-log-items">
                <span v-for="item in group.items" :key="item.id + '-' + item.at" class="chip plain">
                  {{ item.name }}
                </span>
              </span>
            </div>
          </div>
        </template>

        <div v-else class="card empty">左边选一个习惯，这里看它的月历和统计。</div>
      </div>
    </div>

    <div v-if="form.open" class="overlay" @click.self="form.open = false">
      <div class="modal" style="width: 400px">
        <h3>{{ modalTitle }}</h3>
        <label class="field">
          <span>习惯名</span>
          <input v-model="form.name" class="input" name="name" placeholder="比如 早中晚跟读" />
        </label>
        <label class="field">
          <span>目标天数</span>
          <input
            v-model="form.targetDays"
            class="input"
            name="targetDays"
            type="number"
            min="1"
            max="9999"
          />
        </label>
        <label class="field">
          <span>到点提醒</span>
          <span class="row" style="gap: 8px">
            <input
              v-model="form.remindAt"
              class="input"
              name="remindAt"
              type="time"
              style="width: 132px"
            />
            <label class="hb-switch">
              <input v-model="form.remindOn" type="checkbox" name="remindOn" /> 提醒我
            </label>
          </span>
        </label>
        <div class="row" style="justify-content: flex-end">
          <button class="btn" @click="form.open = false">取消</button>
          <button class="btn primary" name="save" @click="save">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 来源: HabitView-CNkejDFh.css  scope: data-v-3679c9c1 */
.habit-page {
  padding: 0 0 24px;
}
.hb-today {
  font-size: 12.5px;
}
.hb-wrap {
  display: grid;
  grid-template-columns: minmax(380px, 1fr) minmax(320px, 420px);
  gap: 14px;
  align-items: start;
}
@media (max-width: 1100px) {
  .hb-wrap {
    grid-template-columns: 1fr;
  }
}
.hb-left {
  padding: 6px 6px 10px;
}
.hb-tabs {
  padding: 4px 8px 0;
}
.hb-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  border: 1px solid transparent;
}
.hb-row:hover {
  background: var(--card-hover);
}
.hb-row.on {
  background: var(--brand-soft);
  border-color: transparent;
}
.hb-row.on:before {
  content: "";
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--brand);
}
.hb-row.off .hb-name {
  color: var(--t3);
}
.hb-face {
  font-size: 17px;
  line-height: 1;
  width: 22px;
  text-align: center;
}
.hb-face.big {
  font-size: 24px;
  width: 30px;
}
.hb-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.hb-name {
  font-size: 13.5px;
}
.hb-sub {
  font-size: 11.5px;
}
.hb-dots {
  display: flex;
  gap: 5px;
}
.hb-dot {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--soft);
  border: 1px solid var(--line);
}
.hb-dot.on {
  background: var(--ok);
  border-color: transparent;
}
.hb-dot.today {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ok) 30%, transparent);
}
.hb-count {
  font-size: 12px;
  color: var(--t2);
  min-width: 62px;
  text-align: right;
}
.hb-count b {
  color: var(--t1);
}
.hb-count em {
  color: var(--t3);
  font-style: normal;
}
.hb-check {
  min-width: 64px;
}
.hb-right {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.hb-detail {
  padding: 12px 14px;
}
.hb-detail-head {
  align-items: flex-start;
  gap: 8px;
}
.hb-detail-sub {
  display: block;
  font-size: 12px;
}
.hb-stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin: 12px 0;
}
.hb-stat {
  background: var(--soft);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.hb-stat .k {
  font-size: 11.5px;
  color: var(--t2);
}
.hb-stat .v {
  font-size: 18px;
  font-weight: 600;
}
.hb-stat .v small {
  font-size: 11.5px;
  font-weight: 400;
  color: var(--t2);
}
.hb-goal {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11.5px;
}
.hb-goal-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--soft);
  overflow: hidden;
}
.hb-goal-bar i {
  display: block;
  height: 100%;
  background: var(--ok);
}
.hb-cal {
  padding: 12px 14px;
}
.hb-cal-title {
  text-align: center;
}
.hb-week,
.hb-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}
.hb-week {
  margin: 10px 0 6px;
}
.hb-week span {
  text-align: center;
  font-size: 11.5px;
  color: var(--t3);
}
.hb-cell {
  aspect-ratio: 1 / 1;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 12.5px;
  color: var(--t2);
  background: var(--soft);
  cursor: pointer;
  user-select: none;
}
.hb-cell.blank {
  background: transparent;
  cursor: default;
}
.hb-cell.done {
  background: var(--ok);
  color: #fff;
  font-weight: 600;
}
.hb-cell.today {
  box-shadow: inset 0 0 0 2px var(--t1);
}
.hb-cell.future {
  color: var(--t3);
  cursor: default;
}
.hb-cal-tip {
  margin-top: 8px;
  font-size: 11.5px;
}
.hb-logs {
  padding: 12px 14px;
}
.hb-logs-head {
  margin-bottom: 8px;
}
.hb-log-day {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 6px 0;
  border-top: 1px solid var(--line);
  font-size: 12.5px;
}
.hb-log-date {
  color: var(--t2);
  min-width: 108px;
  font-size: 12px;
}
.hb-log-items {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.hb-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--t2);
}
</style>
