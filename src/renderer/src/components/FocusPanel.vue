<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import FocusRing from './FocusRing.vue'
import BiliImage from './BiliImage.vue'
import Icon from './Icon.vue'
import { usePomodoroStore } from '../stores/pomodoro'
import { useLearnStore } from '../stores/learn'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { fmtDuration } from '../utils/format'

/* ── TickTick 风格的「专注」面板 ──────────────────────────────────────
   左边是圆环进度 + 大号倒计时，右边是模式切换、开始/暂停/重置，以及
   「本轮专注目标」的任务绑定。计时本身在 store 里，切页不会中断。 */

const pomo = usePomodoroStore()
const learn = useLearnStore()
const settings = useSettingsStore()
const ui = useUiStore()

// ── 时长设置（默认收起，点右上角齿轮展开）──────────────────
// 输入只在失焦/回车时提交（@change）；value 超范围会被 store 夹回默认值。
// 计时进行中不让改：否则「本轮到底算几分钟」会前后不一致。
const showSettings = ref(false)
const focusInput = ref(pomo.focusMin)
const shortInput = ref(pomo.shortMin)
const longInput = ref(pomo.longMin)
const DUR_RANGE = '1 ~ 180'
const MODES = [
  { key: 'focus', label: '专注' },
  { key: 'short', label: '短休息' },
  { key: 'long', label: '长休息' }
]

function applyDurations() {
  pomo.setDurations({ focusMin: focusInput.value, shortMin: shortInput.value, longMin: longInput.value })
  focusInput.value = pomo.focusMin
  shortInput.value = pomo.shortMin
  longInput.value = pomo.longMin
}
function resetDurations() {
  pomo.setDurations({ focusMin: 25, shortMin: 5, longMin: 15 })
  focusInput.value = pomo.focusMin
  shortInput.value = pomo.shortMin
  longInput.value = pomo.longMin
}
function toggleSettings() {
  if (pomo.running) {
    ui.toast('计时进行中不能改时长，先暂停')
    return
  }
  showSettings.value = !showSettings.value
}

// ── 全屏沉浸（TickTick 的「全屏专注」）────────────────────
const rootEl = ref(null)
const isFull = ref(false)

function syncFull() {
  isFull.value = Boolean(document.fullscreenElement)
}
async function toggleFull() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else if (rootEl.value && rootEl.value.requestFullscreen) await rootEl.value.requestFullscreen()
  } catch {
    /* 全屏被拒绝就算了，不影响计时 */
  }
}

// ── 任务绑定 ───────────────────────────────────────────────
const SHELF_LIMIT = 60
/** 快捷任务的出厂值；用户改过就存在 settings.focusTasks 里 */
const DEFAULT_QUICK_TASKS = ['阅读', '刷题', '看课', '整理笔记']
const QUICK_MAX = 8
const QUICK_NAME_MAX = 12
const pickOpen = ref(false)
const pickedBvid = ref('')
const customName = ref('')
const shelfItems = computed(() => learn.shelf.slice(0, SHELF_LIMIT))
const bindLocked = computed(() => pomo.running)

// 快捷任务：默认四个，可增删改名（点「＋ 自定义」进编辑态）
const quickTasks = computed(() => {
  const v = settings.settings.focusTasks
  return Array.isArray(v) && v.length ? v : DEFAULT_QUICK_TASKS
})
const taskEdit = ref(false)
const newTask = ref('')
const editingIdx = ref(-1)

function toggleTaskEdit() {
  taskEdit.value = !taskEdit.value
  newTask.value = ''
  editingIdx.value = -1
}
function startRename(i) {
  newTask.value = quickTasks.value[i] || ''
  editingIdx.value = i
}
function clearQuickEdit() {
  newTask.value = ''
  editingIdx.value = -1
}
async function saveQuick() {
  const name = newTask.value.trim()
  if (!name) return
  if (name.length > QUICK_NAME_MAX) {
    ui.toast(`快捷任务最多 ${QUICK_NAME_MAX} 个字`)
    return
  }
  const list = quickTasks.value.slice()
  if (editingIdx.value >= 0) list[editingIdx.value] = name
  else {
    if (list.length >= QUICK_MAX) {
      ui.toast(`最多 ${QUICK_MAX} 个快捷任务，先删掉一个再加`)
      return
    }
    if (list.some((x) => x.toLowerCase() === name.toLowerCase())) {
      ui.toast('已经有这个快捷任务了')
      return
    }
    list.push(name)
  }
  await settings.patch({ focusTasks: list })
  clearQuickEdit()
}
async function removeQuick(i) {
  const list = quickTasks.value.slice()
  list.splice(i, 1)
  await settings.patch({ focusTasks: list })
  if (editingIdx.value === i) clearQuickEdit()
  else if (editingIdx.value > i) editingIdx.value -= 1
}
async function resetQuick() {
  await settings.patch({ focusTasks: DEFAULT_QUICK_TASKS.slice() })
  clearQuickEdit()
}

function openPicker() {
  if (bindLocked.value) return
  pickedBvid.value = (pomo.task && pomo.task.bvid) || ''
  customName.value = (pomo.task && !pomo.task.bvid && pomo.task.name) || ''
  taskEdit.value = false
  clearQuickEdit()
  pickOpen.value = true
}

function saveTask() {
  const name = customName.value.trim()
  if (pickedBvid.value) {
    const it = learn.shelf.find((x) => x.bvid === pickedBvid.value)
    if (it) {
      pomo.setTask({ name: it.title || it.bvid, bvid: it.bvid, cover: it.cover || '' })
      pickOpen.value = false
      return
    }
  }
  if (name) {
    pomo.setTask({ name })
    pickOpen.value = false
    return
  }
  pomo.clearTask()
  pickOpen.value = false
}

function useQuick(name) {
  pickedBvid.value = ''
  customName.value = name
}

function unbind() {
  if (bindLocked.value) return
  pomo.clearTask()
}

onMounted(() => {
  syncFull()
  document.addEventListener('fullscreenchange', syncFull)
  window.addEventListener('keydown', onKey)
  // LearnView 挂载时已经拉过清单和统计了，这里只兜底（比如别处单独用这个面板）
  if (!pomo.statsLoaded) pomo.loadStats().catch(() => {})
})

onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', syncFull)
  window.removeEventListener('keydown', onKey)
})

/** 键盘快捷键：空格 开始/暂停 · R 重置 · S 结束本轮 · Esc 关弹层
    只在学习页真的显示了面板、且焦点不在输入框/按钮上时生效 */
function onKey(e) {
  if (e.key === 'Escape') {
    if (pickOpen.value) pickOpen.value = false
    else if (showSettings.value) showSettings.value = false
    return
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return
  if (!rootEl.value || !rootEl.value.isConnected) return
  // 全局确认框开着的时候别抢按键（否则 S 会再弹一个确认框，把前一个的 Promise 顶掉）
  if (ui.confirmState && ui.confirmState.open) return
  const el = e.target
  const tag = el && el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (el && el.isContentEditable)) return
  // 焦点在面板里的按钮上时，空格/回车应该是「点这个按钮」，别抢
  if (tag === 'BUTTON' && rootEl.value.contains(el)) return
  const k = e.key
  if (k === ' ' || k === 'Spacebar') {
    e.preventDefault()
    pomo.toggle()
  } else if (k === 'r' || k === 'R') {
    if (!pomo.running) pomo.reset()
  } else if (k === 's' || k === 'S') {
    finishRound()
  }
}

/** 「结束本轮」：专注阶段把已专注的部分也记上（< 30 秒不记），休息阶段直接跳过 */
async function finishRound() {
  const secs = pomo.elapsedSeconds
  if (pomo.mode === 'focus' && secs >= 30) {
    const ok = await ui.confirm('结束本轮专注？', `已专注 ${fmtDuration(secs)}，会按「部分完成」记进专注记录。`, '结束本轮')
    if (!ok) return
  }
  pomo.finish(false)
}
</script>

<template>
  <div ref="rootEl" class="panel focus" :class="{ full: isFull }">
    <div class="row focus-head">
      <Icon name="zap" :size="15" />
      <strong style="font-size: 13.5px">专注</strong>
      <span class="muted" style="font-size: 12px">今日 {{ pomo.todayCount }} 轮 · {{ fmtDuration(pomo.todaySeconds) }}</span>
      <span class="grow" />
      <span class="chip plain" title="本轮已经专注的时长（含暂停前累计的部分）">
        <Icon name="clock" :size="12" /> 本轮 {{ fmtDuration(pomo.elapsedSeconds) }}
      </span>
      <button class="btn sm ghost" :title="isFull ? '退出全屏' : '全屏专注'" @click="toggleFull">
        <Icon name="expand" :size="13" /> {{ isFull ? '退出全屏' : '全屏' }}
      </button>
      <button
        class="btn sm ghost"
        :disabled="pomo.running"
        :title="pomo.running ? '计时进行中不能改时长，先暂停' : showSettings ? '收起时长设置' : '设置时长'"
        @click="toggleSettings"
      >
        <Icon name="settings" :size="13" />
      </button>
    </div>

    <div v-if="showSettings" class="row focus-settings">
      <span class="muted" style="font-size: 11.5px">时长（分钟，{{ DUR_RANGE }}）</span>
      <label>专注 <input v-model.number="focusInput" class="input" type="number" min="1" max="180" @change="applyDurations" /></label>
      <label>短休 <input v-model.number="shortInput" class="input" type="number" min="1" max="180" @change="applyDurations" /></label>
      <label>长休 <input v-model.number="longInput" class="input" type="number" min="1" max="180" @change="applyDurations" /></label>
      <button class="btn sm ghost" title="恢复 25 / 5 / 15" @click="resetDurations">恢复默认</button>
      <span class="grow" />
      <span class="muted" style="font-size: 11.5px">每 4 轮专注进入一次长休息</span>
    </div>

    <div class="focus-body">
      <FocusRing
        :progress="pomo.progress"
        :clock="pomo.clock"
        :running="pomo.running"
        :mode-label="pomo.modeLabel"
        :task="pomo.taskLabel"
        :size="210"
      />

      <div class="focus-side">
        <div class="row" style="gap: 6px; flex-wrap: wrap">
          <span
            v-for="m in MODES"
            :key="m.key"
            class="chip"
            :class="{ on: pomo.mode === m.key }"
            :title="pomo.running ? '计时进行中先暂停，或点「结束本轮」再切换' : `切到${m.label}`"
            @click="pomo.setMode(m.key)"
          >
            {{ m.label }}
          </span>
          <span class="grow" />
          <span class="muted mono" style="font-size: 11.5px">{{ pomo.focusMin }} / {{ pomo.shortMin }} / {{ pomo.longMin }} 分钟</span>
        </div>

        <div class="focus-bar"><i :style="{ width: Math.round(pomo.progress * 100) + '%' }" /></div>

        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <button class="btn primary" style="min-width: 96px" title="空格" @click="pomo.toggle()">
            <Icon :name="pomo.running ? 'pause' : 'play'" :size="15" />
            {{ pomo.running ? '暂停' : pomo.remain < pomo.totalSeconds ? '继续' : '开始专注' }}
          </button>
          <button class="btn ghost" title="R" @click="pomo.reset()"><Icon name="refresh" :size="14" /> 重置</button>
          <button class="btn ghost" title="S · 提前结束这一轮" @click="finishRound">
            {{ pomo.mode === 'focus' ? '结束本轮' : '跳过休息' }}
          </button>
          <span class="grow" />
          <span class="muted" style="font-size: 11.5px">专注结束自动计入学习时长</span>
        </div>
        <p class="muted" style="margin: 0; font-size: 11.5px">
          空格 开始 / 暂停 · R 重置 · S 结束本轮；提前结束的专注只要超过 30 秒也会按「部分完成」记下来。
        </p>

        <!-- 任务绑定 -->
        <div class="focus-task" :class="{ locked: bindLocked }">
          <div class="row" style="gap: 8px">
            <Icon name="bookmark" :size="14" />
            <span class="muted" style="font-size: 11.5px; flex: none">本轮专注目标</span>
            <span v-if="pomo.task" class="taskname clamp-1" :title="pomo.task.name">{{ pomo.task.name }}</span>
            <span v-else class="muted clamp-1" style="font-size: 12.5px">未绑定 · 这轮专注不计到具体任务上</span>
            <span class="grow" />
            <button class="btn sm" :disabled="bindLocked" @click="openPicker">
              <Icon name="plus" :size="12" /> {{ pomo.task ? '更换' : '绑定任务' }}
            </button>
            <button v-if="pomo.task" class="btn sm ghost" :disabled="bindLocked" title="解绑" @click="unbind">
              <Icon name="x" :size="12" />
            </button>
          </div>
          <p v-if="bindLocked" class="muted hint">计时进行中不能改目标，暂停或结束后再换。</p>
          <p v-else class="muted hint">可以从「学习清单」里挑一个视频，也可以手输任务名（例如：线代第 3 章）。</p>
        </div>
      </div>
    </div>

    <!-- 任务选择弹层 -->
    <div v-if="pickOpen" class="overlay" @click.self="pickOpen = false">
      <div class="modal" style="width: 460px">
        <h3 style="font-size: 15px">绑定本轮专注目标</h3>

        <div>
          <div class="muted" style="font-size: 11.5px; margin-bottom: 6px">手输任务名</div>
          <input v-model="customName" class="input" type="text" maxlength="60" placeholder="例如：线代第 3 章 / 背 50 个单词" />
          <div class="row" style="gap: 6px; flex-wrap: wrap; margin-top: 8px">
            <span
              v-for="(q, i) in quickTasks"
              :key="q + i"
              class="chip"
              :class="{ 'chip-edit': taskEdit }"
              :title="taskEdit ? '点一下改名' : '点一下填进上面的输入框'"
              @click="taskEdit ? startRename(i) : useQuick(q)"
            >
              {{ q }}<i v-if="taskEdit" class="chip-x" title="删掉这个快捷任务" @click.stop="removeQuick(i)">✕</i>
            </span>
            <span class="chip" :class="{ on: taskEdit }" title="自定义这些快捷任务" @click="toggleTaskEdit()">
              {{ taskEdit ? '完成' : '＋ 自定义' }}
            </span>
          </div>
          <div v-if="taskEdit" class="row" style="gap: 6px; margin-top: 8px">
            <input
              v-model="newTask"
              class="input grow"
              type="text"
              :maxlength="QUICK_NAME_MAX"
              :placeholder="editingIdx >= 0 ? '改好后点「保存」' : '新的快捷任务名，回车添加'"
              @keyup.enter="saveQuick"
            />
            <button class="btn sm" :disabled="!newTask.trim()" @click="saveQuick()">
              {{ editingIdx >= 0 ? '保存' : '添加' }}
            </button>
            <button v-if="editingIdx >= 0" class="btn sm ghost" @click="clearQuickEdit()">取消</button>
            <button class="btn sm ghost" title="恢复成默认的四个" @click="resetQuick()">恢复默认</button>
          </div>
          <p v-if="taskEdit" class="muted hint" style="margin-top: 6px">
            点任务名可以改名，点 ✕ 删除，最多 {{ QUICK_MAX }} 个、每个 {{ QUICK_NAME_MAX }} 字。
          </p>
        </div>

        <div>
          <div class="muted" style="font-size: 11.5px; margin-bottom: 6px">
            或从学习清单里选（{{ shelfItems.length }} / {{ learn.shelf.length }}）
          </div>
          <div v-if="!shelfItems.length" class="muted" style="font-size: 12.5px; padding: 8px 0">
            学习清单还是空的，可以在视频页点「加入学习清单」，或者直接手输任务名。
          </div>
          <div v-else class="task-list">
            <div
              v-for="it in shelfItems"
              :key="it.bvid"
              class="task-item"
              :class="{ on: pickedBvid === it.bvid }"
              @click="pickedBvid = pickedBvid === it.bvid ? '' : it.bvid"
            >
              <BiliImage :src="it.cover" :alt="it.title" />
              <div class="grow" style="min-width: 0">
                <div class="clamp-1" style="font-size: 12.5px">{{ it.title }}</div>
                <div class="muted clamp-1" style="font-size: 11px">{{ it.upName || '未知 UP' }}</div>
              </div>
              <Icon v-if="pickedBvid === it.bvid" name="check" :size="15" />
            </div>
          </div>
        </div>

        <div class="row" style="justify-content: flex-end; gap: 8px">
          <button class="btn ghost" @click="pomo.clearTask(); pickOpen = false">不绑定</button>
          <button class="btn ghost" @click="pickOpen = false">取消</button>
          <button class="btn primary" @click="saveTask"><Icon name="check" :size="14" /> 确定</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.focus {
  margin: 18px 0 0;
}
/* 全屏沉浸：黑底、居中、去掉面板边框 */
.focus.full {
  margin: 0;
  height: 100%;
  border: 0;
  border-radius: 0;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.focus-head {
  margin-bottom: 12px;
}
.focus.full .focus-head {
  position: fixed;
  top: 14px;
  right: 18px;
  margin: 0;
  z-index: 5;
}
.focus-settings {
  gap: 12px;
  flex-wrap: wrap;
  padding: 8px 10px;
  margin-bottom: 12px;
  border-radius: var(--radius-sm);
  background: var(--soft);
}
.focus-settings label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--t2);
}
.focus-settings .input {
  width: 64px;
  padding: 3px 6px;
  font-size: 12px;
}

.focus-body {
  display: flex;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
}
.focus.full .focus-body {
  justify-content: center;
  gap: 40px;
}
.focus-side {
  flex: 1;
  min-width: 300px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  justify-content: center;
}
.focus.full .focus-side {
  flex: 0 1 420px;
}
.focus-bar {
  height: 6px;
  border-radius: 999px;
  background: var(--soft);
  overflow: hidden;
}
.focus-bar i {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width 0.25s linear;
}

/* ── 任务绑定 ─────────────────────────────── */
.focus-task {
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius);
  padding: 10px 12px;
  background: var(--bg-elev);
}
.focus-task.locked {
  border-style: solid;
  opacity: 0.75;
}
.focus-task .hint {
  margin: 6px 0 0;
  font-size: 11.5px;
}
.taskname {
  font-size: 12.5px;
  color: var(--t1);
  max-width: 320px;
}

/* ── 选择弹层里的清单 ─────────────────────── */
.task-list {
  max-height: 240px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-right: 2px;
}
.task-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  cursor: pointer;
}
.task-item:hover {
  background: var(--soft);
}
/* 缩略图在列表里要有个固定尺寸（BiliImage 的根节点是 img 或占位 div） */
.task-item :deep(img),
.task-item :deep(.ph) {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: 5px;
}
.task-item.on {
  background: var(--soft-hover);
  border-color: var(--accent);
}
</style>
