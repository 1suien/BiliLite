<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useHabitsStore, WEEK_HEAD } from '../stores/habits'
import { todayKey } from '../utils/format'
import Icon from '../components/Icon.vue'

const habits = useHabitsStore()

const FACES = ['🙂', '📖', '🏃', '🧘', '✍️', '🎧', '🌙', '☀️', '💪', '🍵', '🧹', '🎹']

/** 习惯前面的小表情：按名字固定挑一个（同一习惯每次都一样） */
function faceOf(h) {
  const s = String((h && h.name) || '')
  let n = 0
  for (let i = 0; i < s.length; i++) n = (n + s.charCodeAt(i)) % 997
  return FACES[n % FACES.length]
}

function weekdayOf(day) {
  const [y, m, d] = String(day || '').split('-').map(Number)
  const dt = new Date(y || 1970, (m || 1) - 1, d || 1)
  return `周${WEEK_HEAD[(dt.getDay() + 6) % 7]}`
}

const selectedId = computed(() => (habits.selected ? Number(habits.selected.id) : 0))
const cal = computed(() => habits.calendar(habits.viewMonth))
const groups = computed(() => habits.logGroups)
const selectedStats = computed(() => habits.selectedStats)
const activeCount = computed(() => habits.activeHabits.length)
const archivedCount = computed(() => habits.archivedHabits.length)

function statsOf(id) {
  return habits.statsOf(id)
}

const form = ref({ open: false, id: 0, name: '', targetDays: 100, remindAt: '08:00', remindOn: false, note: '' })
const formTitle = computed(() => (form.value.id ? '编辑习惯' : '新建习惯'))

function openNew() {
  form.value = { open: true, id: 0, name: '', targetDays: 100, remindAt: '08:00', remindOn: true, note: '' }
}

function openEdit(h) {
  form.value = {
    open: true,
    id: Number(h.id) || 0,
    name: h.name || '',
    targetDays: Number(h.targetDays) || 100,
    remindAt: /^\d{2}:\d{2}$/.test(String(h.remindAt || '')) ? h.remindAt : '08:00',
    remindOn: Boolean(h.remindOn),
    note: h.note || ''
  }
}

async function save() {
  const payload = {
    name: String(form.value.name || '').trim(),
    targetDays: Number(form.value.targetDays) || 100,
    remindAt: String(form.value.remindAt || ''),
    remindOn: Boolean(form.value.remindOn),
    note: String(form.value.note || '')
  }
  if (!payload.name) {
    habits.create({ name: '' })
    return
  }
  if (form.value.id) await habits.update(form.value.id, payload)
  else await habits.create(payload)
  form.value.open = false
}

/** 月历上点一天：补打 / 取消（未来的日子点不动） */
async function pickDay(cell) {
  if (!cell || cell.future || !selectedId.value) return
  await habits.toggle(selectedId.value, cell.day)
}

async function toggleToday(id) {
  await habits.toggle(id, todayKey())
}

// 手机/桌面同步：换日子就把日历跟过去（默认就看今天所在月）
watch(
  () => habits.selectedId,
  () => {
    if (!habits.viewMonth) habits.focusMonthOf(todayKey())
  }
)

onMounted(async () => {
  await habits.init()
  habits.focusMonthOf(todayKey())
  // 冒烟/排查用的探针：只读或直接驱动 store，不走界面
  // executeJavaScript 的结果要能过结构化克隆，而 Pinia 的 state 是 reactive 代理（克隆代理会抛
  // 「An object could not be cloned.」），所以统一先 JSON 走一遍变成纯数据再返回。
  const plain = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v))
  window.__habitProbe = () => plain({
    hash: location.hash,
    tab: habits.tab,
    counts: { active: activeCount.value, archived: archivedCount.value, logs: habits.logCount },
    today: { day: todayKey(), done: habits.todayDone, total: habits.activeHabits.length },
    selected: habits.selected ? { id: Number(habits.selected.id), name: habits.selected.name } : null,
    viewMonth: habits.viewMonth,
    calendar: { label: cal.value.label, done: cal.value.weeks.flat().filter((c) => c && c.done).map((c) => c.day) },
    habits: habits.habits.map((h) => {
      const st = statsOf(h.id)
      return {
        id: Number(h.id),
        name: h.name,
        targetDays: Number(h.targetDays) || 0,
        remindAt: h.remindAt || '',
        remindOn: Boolean(h.remindOn),
        archived: Number(h.archived) || 0,
        total: st.total,
        streak: st.streak,
        best: st.best,
        monthDone: st.monthDone,
        monthRate: Math.round(st.monthRate * 1000) / 1000,
        todayDone: st.todayDone
      }
    }),
    logGroups: groups.value.map((g) => ({ date: g.date, names: g.items.map((i) => i.name) })),
    lastReminder: habits.lastReminder,
    fired: habits.firedFor()
  })
  window.__habitRemindCheck = (hhmm, day) => plain(habits.checkReminders(hhmm, day))
  // runReminders 是 async 的：直接把 Promise 交给 executeJavaScript 会 clone 成 `{}`（Promise 没有可枚举字段），
  // 所以这里自己 then 一下，把结果放进 window.__habitRemindResult 让冒烟轮询取值。
  window.__habitRemindAt = (hhmm, day) => {
    window.__habitRemindResult = null
    habits
      .runReminders(hhmm, day, { notify: true })
      .then((r) => {
        window.__habitRemindResult = plain(r)
      })
      .catch((err) => {
        window.__habitRemindResult = { error: String((err && err.message) || err) }
      })
    return true
  }
  // 冒烟用：把 App 起的 30 秒自动巡检停掉，免得它在我们手动断言之前先把习惯标成「今天提醒过」
  window.__habitRemindStop = () => {
    habits.stopReminders()
    return true
  }
  window.__habitRemindReset = () => {
    try {
      localStorage.removeItem('study-bili-habit-remind')
    } catch (err) {
      /* 忽略 */
    }
    habits.lastReminder = null
    return true
  }
})

onBeforeUnmount(() => {
  for (const k of ['__habitProbe', '__habitRemindCheck', '__habitRemindAt', '__habitRemindStop', '__habitRemindReset']) {
    try {
      window[k] = null
    } catch (err) {
      /* 忽略 */
    }
  }
})
</script>

<template>
  <div class="habit-page">
    <div class="page-head">
      <h1>习惯打卡</h1>
      <div class="row" style="gap: 8px">
        <span class="muted hb-today">今天 {{ habits.todayDone }}/{{ habits.activeHabits.length }}</span>
        <button class="btn sm" title="清空所有习惯与记录" @click="habits.clearAll()">
          <Icon name="trash" :size="14" /> 清空
        </button>
        <button class="btn primary" @click="openNew"><Icon name="plus" :size="15" /> 新建习惯</button>
      </div>
    </div>

    <div class="hb-wrap">
      <div class="card hb-left">
        <div class="tabs hb-tabs">
          <div class="tab" :class="{ on: habits.tab === 'active' }" @click="habits.setTab('active')">
            坚持中 {{ activeCount }}
          </div>
          <div class="tab" :class="{ on: habits.tab === 'archived' }" @click="habits.setTab('archived')">
            已归档 {{ archivedCount }}
          </div>
        </div>

        <div v-if="!habits.list.length" class="empty">
          {{ habits.tab === 'archived' ? '还没有归档的习惯。' : '还没有习惯，点右上角「新建习惯」加一个。' }}
        </div>

        <div
          v-for="h in habits.list"
          :key="h.id"
          class="hb-row"
          :class="{ on: Number(h.id) === habits.selectedId, off: !!h.archived }"
          @click="habits.select(h.id)"
        >
          <span class="hb-face">{{ faceOf(h) }}</span>
          <span class="hb-info">
            <span class="hb-name clamp-1">{{ h.name }}</span>
            <span class="hb-sub muted">
              {{ statsOf(h.id).total }} 天共坚持
              <template v-if="h.remindOn && h.remindAt"> · {{ h.remindAt }} 提醒</template>
            </span>
          </span>
          <span class="hb-dots">
            <span
              v-for="d in statsOf(h.id).last7"
              :key="d.day"
              class="hb-dot"
              :class="{ on: d.done, today: d.today }"
              :title="d.day + (d.done ? ' 已打卡' : ' 未打卡')"
            />
          </span>
          <span class="hb-count">
            <b>{{ statsOf(h.id).total }}</b>
            <em>/{{ Number(h.targetDays) || 100 }}</em>
          </span>
          <button
            class="btn sm hb-check"
            :class="statsOf(h.id).todayDone ? 'ghost' : 'primary'"
            @click.stop="toggleToday(h.id)"
          >
            {{ statsOf(h.id).todayDone ? '已打卡' : '打卡' }}
          </button>
        </div>
      </div>

      <div class="hb-right">
        <div v-if="!habits.selected" class="card empty">左边选一个习惯，这里看它的月历和统计。</div>
        <template v-else>
          <div class="card hb-detail">
            <div class="row hb-detail-head">
              <span class="hb-face big">{{ faceOf(habits.selected) }}</span>
              <span class="grow">
                <b>{{ habits.selected.name }}</b>
                <span class="muted hb-detail-sub">
                  目标 {{ selectedStats.target }} 天
                  <template v-if="habits.selected.remindOn && habits.selected.remindAt"> · 每天 {{ habits.selected.remindAt }} 提醒</template>
                  <template v-else> · 没开提醒</template>
                </span>
              </span>
              <button class="btn sm" @click="openEdit(habits.selected)">编辑</button>
              <button class="btn sm" @click="habits.archive(habits.selected.id, !habits.selected.archived)">
                {{ habits.selected.archived ? '恢复' : '归档' }}
              </button>
              <button class="btn sm danger" @click="habits.remove(habits.selected.id)">删除</button>
            </div>

            <div class="hb-stats">
              <div class="hb-stat">
                <span class="k">月打卡</span>
                <span class="v">{{ selectedStats.monthDone }} <small>天</small></span>
              </div>
              <div class="hb-stat">
                <span class="k">总打卡</span>
                <span class="v">{{ selectedStats.total }} <small>天</small></span>
              </div>
              <div class="hb-stat">
                <span class="k">月完成率</span>
                <span class="v">{{ Math.round(selectedStats.monthRate * 100) }} <small>%</small></span>
              </div>
              <div class="hb-stat">
                <span class="k">当前连续</span>
                <span class="v">{{ selectedStats.streak }} <small>天</small></span>
              </div>
            </div>

            <div class="hb-goal">
              <div class="hb-goal-bar"><i :style="{ width: Math.round(selectedStats.dayRate * 100) + '%' }" /></div>
              <span class="muted">
                目标 {{ selectedStats.target }} 天 · 已坚持 {{ selectedStats.total }} 天 · 最长连续 {{ selectedStats.best }} 天
                <template v-if="selectedStats.achieved"> · 已达成 🎉</template>
              </span>
            </div>
          </div>

          <div class="card hb-cal">
            <div class="row hb-cal-head">
              <button class="btn sm ghost" title="上个月" @click="habits.monthMove(-1)"><Icon name="left" :size="14" /></button>
              <b class="grow hb-cal-title">{{ cal.label }}</b>
              <button class="btn sm ghost" title="下个月" @click="habits.monthMove(1)"><Icon name="right" :size="14" /></button>
            </div>
            <div class="hb-week">
              <span v-for="w in WEEK_HEAD" :key="w">{{ w }}</span>
            </div>
            <div class="hb-grid">
              <template v-for="(w, wi) in cal.weeks" :key="wi">
                <span
                  v-for="(c, ci) in w"
                  :key="wi + '-' + ci"
                  class="hb-cell"
                  :class="{ blank: !c, done: c && c.done, today: c && c.today, future: c && c.future }"
                  :title="c ? c.day : ''"
                  @click="pickDay(c)"
                >
                  <span v-if="c">{{ c.num }}</span>
                </span>
              </template>
            </div>
            <div class="muted hb-cal-tip">点某一天可以补打或取消（未来的日子点不动）</div>
          </div>

          <div class="card hb-logs">
            <div class="row hb-logs-head">
              <b class="grow">打卡日志</b>
              <span class="muted">{{ habits.logCount }} 条</span>
            </div>
            <div v-if="!groups.length" class="empty">还没有打卡记录。</div>
            <div v-for="g in groups" :key="g.date" class="hb-log-day">
              <span class="hb-log-date mono">{{ g.date }} {{ weekdayOf(g.date) }}</span>
              <span class="hb-log-items">
                <span v-for="it in g.items" :key="it.id + '-' + it.at" class="chip plain">{{ it.name }}</span>
              </span>
            </div>
          </div>
        </template>
      </div>
    </div>

    <div v-if="form.open" class="overlay" @click.self="form.open = false">
      <div class="modal" style="width: 400px">
        <h3>{{ formTitle }}</h3>
        <label class="field">
          <span>习惯名</span>
          <input v-model="form.name" class="input" name="name" placeholder="比如 早中晚跟读" />
        </label>
        <label class="field">
          <span>目标天数</span>
          <input v-model="form.targetDays" class="input" name="targetDays" type="number" min="1" max="9999" />
        </label>
        <label class="field">
          <span>到点提醒</span>
          <span class="row" style="gap: 8px">
            <input v-model="form.remindAt" class="input" name="remindAt" type="time" style="width: 132px" />
            <label class="hb-switch">
              <input v-model="form.remindOn" type="checkbox" name="remindOn" />
              提醒我
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
  background: var(--soft);
  border-color: var(--line-strong);
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
