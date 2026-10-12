<script setup>
/**
 * 专注模块的容器：两栏布局 + 底部常驻计时条 + 全屏大圆环 + 绑定目标弹层 + 快捷键。
 *
 * 分工：目标列表在 FocusTargets，右栏概览/记录在 FocusOverview + FocusRecords。
 * 冒烟测试依赖的钩子（别顺手改名）：
 *   .focus[data-elapsed] / .focus-head .muted（今日 N 轮）/ .focus-clock / .focus-settings input
 *   .focus button 里文本为 开始专注|结束专注 的计时条按钮、文本为 绑定任务|更换 的按钮
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from './Icon.vue'
import FocusTargets from './FocusTargets.vue'
import FocusOverview from './FocusOverview.vue'
import FocusRecords from './FocusRecords.vue'
import { usePomodoroStore } from '../stores/pomodoro'
import { useSettingsStore, DEFAULT_FOCUS_TARGETS, makeFocusTarget } from '../stores/settings'
import { useLearnStore } from '../stores/learn'
import { useUiStore } from '../stores/ui'
import { fmtDuration } from '../utils/format'

const pomo = usePomodoroStore()
const settings = useSettingsStore()
const learn = useLearnStore()
const ui = useUiStore()

const QUICK_MAX = 12
const QUICK_NAME_MAX = 12
const DUR_MIN = 1
const DUR_MAX = 180

const pickOpen = ref(false)
const customName = ref('')
const taskEdit = ref(false)
const newTask = ref('')
const editingIdx = ref(-1)

const showSettings = ref(false)
const focusInput = ref(pomo.focusMin)
const breakInput = ref(pomo.breakMin)
const isFull = ref(false)
const rootEl = ref(null)

const bindLocked = computed(() => pomo.running)
const shelfItems = computed(() => (learn.shelf || []).slice(0, 60))

/** 目标列表（绑定弹层里的 chips 就是它，和左栏是同一份数据） */
const targets = computed(() =>
  Array.isArray(settings.settings.focusTargets) ? settings.settings.focusTargets : []
)
const pickNames = computed(() => targets.value.filter((t) => !t.archived).map((t) => t.name))

const clockText = computed(() => fmtDuration(pomo.running ? pomo.remain : pomo.totalSeconds))

/** 计时条上的进度百分比（没在跑就是 0） */
const pct = computed(() => {
  const total = pomo.totalSeconds || 0
  if (total <= 0) return 0
  const left = pomo.running ? pomo.remain : total
  const used = Math.max(0, Math.min(total, total - left))
  return Math.round((used / total) * 100)
})

const barName = computed(() => {
  if (pomo.mode === 'break') return pomo.running ? '休息中 · 起来走两步' : '休息时间'
  const n = (pomo.task && pomo.task.name) || ''
  if (pomo.running) return n ? `${n} · 正在专注` : '正在专注（未绑定目标）'
  return n ? n : '选一个目标开始'
})

// ── 绑定目标弹层 ────────────────────────────────────────────────
function openPicker() {
  customName.value = (pomo.task && pomo.task.name) || ''
  taskEdit.value = false
  newTask.value = ''
  editingIdx.value = -1
  pickOpen.value = true
}
function toggleTaskEdit() {
  taskEdit.value = !taskEdit.value
  newTask.value = ''
  editingIdx.value = -1
}
function startRename(i) {
  editingIdx.value = i
  newTask.value = pickNames.value[i] || ''
}
function clearQuickEdit() {
  editingIdx.value = -1
  newTask.value = ''
}
async function saveQuick() {
  const name = newTask.value.trim().slice(0, QUICK_NAME_MAX)
  if (!name) return
  const list = targets.value.slice()
  if (editingIdx.value >= 0) {
    const old = pickNames.value[editingIdx.value]
    const at = list.findIndex((t) => t.name === old)
    if (at < 0) return
    if (list.some((t) => t.name === name && t.name !== old)) {
      ui.err(`已经有「${name}」了`)
      return
    }
    list[at] = { ...list[at], name }
    await settings.setFocusTargets(list)
    await pomo.renameTask(old, name)
    if (customName.value === old) customName.value = name
  } else {
    if (list.some((t) => t.name === name)) {
      ui.err(`已经有「${name}」了`)
      return
    }
    if (list.length >= QUICK_MAX) {
      ui.err(`最多 ${QUICK_MAX} 个目标`)
      return
    }
    list.push(makeFocusTarget(name, list.length))
    await settings.setFocusTargets(list)
  }
  clearQuickEdit()
}
async function removeQuick(i) {
  const name = pickNames.value[i]
  if (!name) return
  await settings.setFocusTargets(targets.value.filter((t) => t.name !== name))
  clearQuickEdit()
}
async function resetQuick() {
  await settings.setFocusTargets(DEFAULT_FOCUS_TARGETS.map((n, i) => makeFocusTarget(n, i)))
  clearQuickEdit()
}
function useQuick(q) {
  customName.value = q
}
function saveTask() {
  const name = customName.value.trim().slice(0, 60)
  if (name) pomo.setTask({ name })
  else pomo.clearTask()
  pickOpen.value = false
}
function unbind() {
  pomo.clearTask()
  pickOpen.value = false
}

// ── 时长设置 ───────────────────────────────────────────────────
const clampDur = (v) => Math.max(DUR_MIN, Math.min(DUR_MAX, Math.round(Number(v) || DUR_MIN)))
function applyDurations() {
  if (pomo.running) {
    ui.toast('计时进行中不能改时长，先暂停')
    focusInput.value = pomo.focusMin
    breakInput.value = pomo.breakMin
    return
  }
  const f = clampDur(focusInput.value)
  const b = clampDur(breakInput.value)
  focusInput.value = f
  breakInput.value = b
  pomo.setDurations({ focusMin: f, breakMin: b })
  // 改完要让「还没开始的那一轮」跟着变长/变短，否则时钟还是老数字
  pomo.reset()
}
function onDurInput(kind, e) {
  const v = Number(e.target.value)
  if (kind === 'focus') focusInput.value = v
  else breakInput.value = v
  applyDurations()
}
function resetDurations() {
  focusInput.value = 45
  breakInput.value = 20
  applyDurations()
}
function toggleSettings() {
  showSettings.value = !showSettings.value
}

function toggleFull() {
  isFull.value = !isFull.value
}

// ── 快捷键 ─────────────────────────────────────────────────────
function onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return
  const el = e.target
  const tag = el && el.tagName
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (el && el.isContentEditable)
  if (e.key === 'Escape') {
    if (pickOpen.value) pickOpen.value = false
    else if (showSettings.value) showSettings.value = false
    else if (isFull.value) isFull.value = false
    return
  }
  if (typing) return
  if (ui.confirmState && ui.confirmState.open) return
  // 焦点停在本模块的按钮上时别抢空格（空格本来是「按下按钮」）
  const root = rootEl.value
  if (root && root.contains(el) && tag === 'BUTTON') return
  if (e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault()
    pomo.primaryAction()
  } else if (e.key === 'r' || e.key === 'R') {
    if (!pomo.running) pomo.reset()
  }
}

onMounted(() => {
  focusInput.value = pomo.focusMin
  breakInput.value = pomo.breakMin
  if (!pomo.statsLoaded) pomo.loadStats().catch(() => {})
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="rootEl" class="focus" :data-elapsed="pomo.elapsedSeconds">
    <div class="focus-layout">
      <!-- 左栏：目标列表 + 底部常驻计时条 -->
      <div class="panel ft">
        <FocusTargets />

        <div class="ft-sep" />

        <div class="focus-bar" :class="{ rest: pomo.mode === 'break', on: pomo.running }">
          <button class="fb-play" :title="pomo.primaryLabel" @click="pomo.primaryAction()">
            <Icon :name="pomo.running ? 'pause' : 'play'" :size="16" />
            <!-- 图标按钮也得有名字：屏幕阅读器要读，冒烟测试按这两个字找按钮 -->
            <span class="sr-only">{{ pomo.primaryLabel }}</span>
          </button>
          <div class="fb-main">
            <div class="fb-top">
              <span class="fb-name">{{ barName }}</span>
              <button v-if="!pomo.running" class="fb-bind" title="更换专注目标" @click="openPicker">
                <Icon name="target" :size="14" />
                <!-- 文字要留在 DOM 里：冒烟按「更换 / 绑定任务」找这个按钮 -->
                <span class="sr-only">{{ pomo.task ? '更换' : '绑定任务' }}</span>
              </button>
              <span class="fb-clock focus-clock mono">{{ clockText }}</span>
            </div>
            <div class="fb-track"><i :style="{ width: pct + '%' }" /></div>
          </div>
          <button
            class="btn sm ghost"
            :title="showSettings ? '收起时长设置' : '设置时长'"
            aria-label="时长设置"
            @click="toggleSettings"
          >
            <Icon name="settings" :size="14" />
          </button>
          <button class="btn sm ghost" title="全屏专注（大圆环）" aria-label="全屏专注" @click="toggleFull">
            <Icon name="expand" :size="14" />
          </button>
        </div>

        <div v-if="showSettings" class="focus-settings">
          <div class="row" style="gap: 8px">
            <label class="fs-lab">专注时长</label>
            <input
              :value="focusInput"
              class="input mono"
              type="number"
              :min="DUR_MIN"
              :max="DUR_MAX"
              style="width: 76px"
              @input="onDurInput('focus', $event)"
              @change="onDurInput('focus', $event)"
            />
            <span class="muted" style="font-size: 12px">分钟</span>
          </div>
          <div class="row" style="gap: 8px">
            <label class="fs-lab">休息时长</label>
            <input
              :value="breakInput"
              class="input mono"
              type="number"
              :min="DUR_MIN"
              :max="DUR_MAX"
              style="width: 76px"
              @input="onDurInput('break', $event)"
              @change="onDurInput('break', $event)"
            />
            <span class="muted" style="font-size: 12px">分钟</span>
            <button class="btn sm ghost" style="margin-left: auto" @click="resetDurations">恢复 45 / 20</button>
          </div>
          <p class="muted" style="font-size: 11.5px; margin: 0">
            范围 {{ DUR_MIN }} ~ {{ DUR_MAX }} 分钟。计时进行中不能改，先结束或重置。
          </p>
        </div>
      </div>

      <!-- 右栏：概览 + 记录 -->
      <div class="focus-right">
        <FocusOverview />
        <FocusRecords />
      </div>
    </div>

    <!-- 全屏专注：只剩一个大圆环 -->
    <div v-if="isFull" class="focus-full">
      <div class="ring" :style="{ '--p': pct }">
        <div class="ring-in">
          <div class="ring-clock mono">{{ clockText }}</div>
          <div class="ring-mode">{{ pomo.mode === 'break' ? '休息' : '专注' }}</div>
          <div class="ring-task">{{ (pomo.task && pomo.task.name) || '未绑定目标' }}</div>
        </div>
      </div>
      <div class="row" style="gap: 10px">
        <button class="btn primary" @click="pomo.primaryAction()">{{ pomo.primaryLabel }}</button>
        <button class="btn ghost" @click="pomo.reset()">重置</button>
        <button class="btn ghost" @click="toggleFull()">退出全屏</button>
      </div>
      <p class="muted" style="font-size: 12px">空格 开始 / 结束 · R 重置 · Esc 退出全屏</p>
    </div>

    <!-- 绑定本轮专注目标 -->
    <div v-if="pickOpen" class="overlay" @click.self="pickOpen = false">
      <div class="modal" style="width: 460px">
        <h3 style="font-size: 15px">绑定本轮专注目标</h3>
        <div>
          <div class="muted" style="font-size: 11.5px; margin-bottom: 6px">手输任务名</div>
          <input
            v-model="customName"
            class="input"
            type="text"
            maxlength="60"
            placeholder="例如：线代第 3 章 / 背 50 个单词"
          />
          <div class="row" style="gap: 6px; flex-wrap: wrap; margin-top: 8px">
            <span
              v-for="(q, i) in pickNames"
              :key="q + i"
              class="chip"
              :class="{ 'chip-edit': taskEdit }"
              @click="taskEdit ? startRename(i) : useQuick(q)"
            >
              {{ q }}<i v-if="taskEdit" class="chip-x" title="删掉这个目标" @click.stop="removeQuick(i)">✕</i>
            </span>
            <span class="chip" :class="{ on: taskEdit }" @click="toggleTaskEdit()">
              {{ taskEdit ? '完成' : '＋ 自定义' }}
            </span>
          </div>
          <div v-if="taskEdit" class="row" style="gap: 6px; margin-top: 8px">
            <input
              v-model="newTask"
              class="input grow"
              type="text"
              :maxlength="QUICK_NAME_MAX"
              placeholder="目标名（12 字以内）"
              @keyup.enter="saveQuick"
            />
            <button class="btn sm" :disabled="!newTask.trim()" @click="saveQuick()">
              {{ editingIdx >= 0 ? '保存' : '添加' }}
            </button>
            <button v-if="editingIdx >= 0" class="btn sm ghost" @click="clearQuickEdit()">取消</button>
            <button class="btn sm ghost" title="恢复成默认的四个" @click="resetQuick()">恢复默认</button>
          </div>
          <p v-if="taskEdit" class="muted" style="font-size: 11.5px; margin: 6px 0 0">
            点目标名可以改名，点 ✕ 删除，最多 {{ QUICK_MAX }} 个、每个 {{ QUICK_NAME_MAX }} 字。
          </p>
        </div>
        <div>
          <div class="muted" style="font-size: 11.5px; margin-bottom: 6px">
            或从学习清单里选（{{ shelfItems.length }} / {{ (learn.shelf || []).length }}）
          </div>
          <div class="task-list">
            <div v-if="!shelfItems.length" class="muted" style="font-size: 12.5px; padding: 6px 2px">
              学习清单还是空的，去播放页把要学的视频「加入学习清单」。
            </div>
            <button
              v-for="it in shelfItems"
              :key="it.bvid"
              class="task-item"
              :class="{ on: customName === it.title }"
              @click="useQuick(it.title)"
            >
              {{ it.title }}
            </button>
          </div>
        </div>
        <div class="row" style="justify-content: flex-end; gap: 8px">
          <button class="btn ghost" @click="unbind">不绑定</button>
          <button class="btn ghost" @click="pickOpen = false">取消</button>
          <button class="btn primary" :disabled="bindLocked" @click="saveTask">
            <Icon name="check" :size="14" /> 确定
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.focus-layout {
  display: grid;
  grid-template-columns: minmax(320px, 384px) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.focus-right {
  min-width: 0;
}
.ft {
  padding: 14px 16px 12px;
}
.ft-sep {
  height: 1px;
  background: var(--line);
  margin: 10px 0 12px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/* ── 计时条 ── */
.focus-bar {
  display: flex;
  align-items: center;
  gap: 10px;
}
.fb-play {
  position: relative;
  width: 38px;
  height: 38px;
  flex: none;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--accent);
  color: var(--accent-fg);
  border: 0;
  cursor: pointer;
  transition: filter 0.13s, transform 0.08s;
}
.fb-play:hover {
  filter: brightness(0.92);
}
.fb-play:active {
  transform: translateY(1px);
}
.focus-bar.rest .fb-play {
  background: var(--ok);
  color: #06121f;
}
.fb-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fb-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.fb-name {
  font-size: 12.5px;
  color: var(--t3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-bind {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--t3);
  cursor: pointer;
  transition: background 0.13s, color 0.13s;
}
.fb-bind:hover {
  background: var(--soft);
  color: var(--brand);
}
.fb-clock {
  margin-left: auto;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.5px;
  white-space: nowrap;
}
.focus-bar.rest .fb-clock {
  color: var(--ok);
}
.fb-track {
  height: 4px;
  border-radius: 999px;
  background: var(--line-strong);
  overflow: hidden;
}
.fb-track i {
  display: block;
  height: 100%;
  background: var(--brand);
  transition: width 0.25s linear;
}
.focus-bar.rest .fb-track i {
  background: var(--ok);
}

/* ── 时长设置 ── */
.focus-settings {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--soft);
}
.fs-lab {
  width: 60px;
  flex: none;
  font-size: 12.5px;
  color: var(--t2);
}

/* ── 全屏大圆环 ── */
.focus-full {
  position: fixed;
  inset: 0;
  z-index: 55;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 22px;
}
.ring {
  --p: 0;
  position: relative;
  width: 264px;
  height: 264px;
  border-radius: 50%;
  background: conic-gradient(var(--brand) calc(var(--p) * 1%), var(--line) 0);
  display: grid;
  place-items: center;
  box-shadow: var(--shadow);
}
.ring-in {
  position: absolute;
  inset: 10px;
  border-radius: 50%;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
}
.ring-clock {
  font-size: 46px;
  font-weight: 700;
  letter-spacing: 1px;
}
.ring-mode {
  font-size: 12.5px;
  color: var(--t3);
}
.ring-task {
  font-size: 12.5px;
  color: var(--t2);
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 绑定弹层里的学习清单 ── */
.task-list {
  max-height: 200px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.task-item {
  text-align: left;
  padding: 7px 9px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: transparent;
  color: var(--t2);
  font-size: 12.5px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-item:hover {
  background: var(--card-hover);
  color: var(--t1);
}
.task-item.on {
  border-color: var(--brand-line);
  background: var(--brand-soft);
  color: var(--t1);
}

@media (max-width: 900px) {
  .focus-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
