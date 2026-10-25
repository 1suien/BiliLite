<script setup lang="ts">
/** 专注计时面板：任务绑定、正计时/番茄钟、开始结束、全屏圆环 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import Icon from '@/components/Icon.vue'
import FocusTargets from '@/components/FocusTargets.vue'
import FocusOverview from '@/components/FocusOverview.vue'
import FocusRecords from '@/components/FocusRecords.vue'
import { useSettingsStore, makeFocusTarget, DEFAULT_FOCUS_TASKS } from '@/stores/settings'
import { usePomodoroStore } from '@/stores/pomodoro'
import { useLearnStore } from '@/stores/learn'
import { useUiStore } from '@/stores/ui'
import { formatClock } from '@/utils/format'

/** 最多能建几个目标 */
const MAX_TARGETS = 12
/** 目标名字数上限 */
const NAME_MAX = 12
const MIN_MINUTES = 1
const MAX_MINUTES = 180

const pomo = usePomodoroStore()
const settings = useSettingsStore()
const learn = useLearnStore()
const ui = useUiStore()

/** 绑定目标弹窗 */
const bindOpen = ref(false)
const bindName = ref('')
/** 目标 chip 的「编辑模式」 */
const chipEdit = ref(false)
const chipDraft = ref('')
/** 正在改名的目标下标（-1 = 新增） */
const editIndex = ref(-1)
/** 时长设置展开 */
const showSettings = ref(false)
const focusDraft = ref(pomo.focusMin)
const breakDraft = ref(pomo.breakMin)
/** 全屏圆环 */
const full = ref(false)
const rootEl = ref<any>(null)

const running = computed(() => pomo.running)
/** 学习清单里可绑定的视频（最多 60 个） */
const shelfPreview = computed(() => (learn.shelf || []).slice(0, 60))
const targets = computed(() =>
  Array.isArray(settings.settings.focusTargets) ? settings.settings.focusTargets : [],
)
const targetNames = computed(() => targets.value.filter((t) => !t.archived).map((t) => t.name))
/** 面板上显示的时钟 */
const clockText = computed(() => formatClock(pomo.running ? pomo.remain : pomo.totalSeconds))
/** 进度百分比（0~100） */
const percent = computed(() => {
  const total = pomo.totalSeconds || 0
  if (total <= 0) return 0
  const left = pomo.running ? pomo.remain : total
  const done = Math.max(0, Math.min(total, total - left))
  return Math.round((done / total) * 100)
})
/** 顶部状态文案 */
const statusText = computed(() => {
  if (pomo.mode === 'break') {
    return pomo.running ? '休息中 · 起来走两步' : '休息时间'
  }
  const name = (pomo.task && pomo.task.name) || ''
  if (pomo.running) return name ? `${name} · 正在专注` : '正在专注（未绑定目标）'
  return name || '选一个目标开始'
})

function openBind() {
  bindName.value = (pomo.task && pomo.task.name) || ''
  chipEdit.value = false
  chipDraft.value = ''
  editIndex.value = -1
  bindOpen.value = true
}

function toggleChipEdit() {
  chipEdit.value = !chipEdit.value
  chipDraft.value = ''
  editIndex.value = -1
}

function startEdit(i: number) {
  editIndex.value = i
  chipDraft.value = targetNames.value[i] || ''
}

function cancelEdit() {
  editIndex.value = -1
  chipDraft.value = ''
}

/** 新增 / 改名目标 */
async function saveTarget() {
  const name = chipDraft.value.trim().slice(0, NAME_MAX)
  if (!name) return
  const next = targets.value.slice()
  if (editIndex.value >= 0) {
    const old = targetNames.value[editIndex.value]
    const at = next.findIndex((t) => t.name === old)
    if (at < 0) return
    if (next.some((t) => t.name === name && t.name !== old)) {
      ui.err(`已经有「${name}」了`)
      return
    }
    next[at] = { ...next[at], name }
    await settings.setFocusTargets(next)
    await pomo.renameTask(old, name)
    if (bindName.value === old) bindName.value = name
  } else {
    if (next.some((t) => t.name === name)) {
      ui.err(`已经有「${name}」了`)
      return
    }
    if (next.length >= MAX_TARGETS) {
      ui.err(`最多 ${MAX_TARGETS} 个目标`)
      return
    }
    next.push(makeFocusTarget(name, next.length))
    await settings.setFocusTargets(next)
  }
  cancelEdit()
}

/** 删掉某个目标（历史记录保留） */
async function removeTarget(i: number) {
  const name = targetNames.value[i]
  if (!name) return
  await settings.setFocusTargets(targets.value.filter((t) => t.name !== name))
  cancelEdit()
}

async function restoreDefaults() {
  await settings.setFocusTargets(DEFAULT_FOCUS_TASKS.map((n, i) => makeFocusTarget(n, i)))
  cancelEdit()
}

function pickName(name: string) {
  bindName.value = name
}

function confirmBind() {
  const name = bindName.value.trim().slice(0, 60)
  if (name) pomo.setTask({ name })
  else pomo.clearTask()
  bindOpen.value = false
}

function unbind() {
  pomo.clearTask()
  bindOpen.value = false
}

const clampMinutes = (v: any) =>
  Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, Math.round(Number(v) || MIN_MINUTES)))

/** 应用时长设置（计时中不允许改） */
function applyDurations() {
  if (pomo.running) {
    ui.toast('计时进行中不能改时长，先暂停')
    focusDraft.value = pomo.focusMin
    breakDraft.value = pomo.breakMin
    return
  }
  const f = clampMinutes(focusDraft.value)
  const b = clampMinutes(breakDraft.value)
  focusDraft.value = f
  breakDraft.value = b
  pomo.setDurations({ focusMin: f, breakMin: b })
  pomo.reset()
}

function onDurationInput(which: 'focus' | 'break', e: Event) {
  const v = Number((e.target as HTMLInputElement).value)
  if (which === 'focus') focusDraft.value = v
  else breakDraft.value = v
  applyDurations()
}

function reset4520() {
  focusDraft.value = 45
  breakDraft.value = 20
  applyDurations()
}

function toggleSettings() {
  showSettings.value = !showSettings.value
}

function toggleFull() {
  full.value = !full.value
}

/** 全局快捷键：空格 开始/结束、R 重置、Esc 关浮层 */
function onKeydown(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey || e.altKey) return
  const target = e.target as HTMLElement | null
  const tag = target && target.tagName
  const typing =
    tag === 'INPUT' || tag === 'TEXTAREA' || (target && (target as any).isContentEditable)
  if (e.key === 'Escape') {
    if (bindOpen.value) bindOpen.value = false
    else if (showSettings.value) showSettings.value = false
    else if (full.value) full.value = false
    return
  }
  if (typing || (ui.confirmState && ui.confirmState.open)) return
  const root = rootEl.value
  // 焦点在面板内的按钮上时，空格交给按钮自己处理
  if (root && root.contains(target) && tag === 'BUTTON') return
  if (e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault()
    pomo.primaryAction()
  } else if (e.key === 'r' || e.key === 'R') {
    if (!pomo.running) pomo.reset()
  }
}

onMounted(() => {
  focusDraft.value = pomo.focusMin
  breakDraft.value = pomo.breakMin
  if (!pomo.statsLoaded) pomo.loadStats().catch(() => {})
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div ref="rootEl" class="focus" :data-elapsed="pomo.elapsedSeconds">
    <div class="focus-layout">
      <div class="panel ft">
        <FocusTargets />
        <div class="ft-sep" />
        <div class="focus-bar" :class="{ rest: pomo.mode === 'break', on: pomo.running }">
          <button class="fb-play" :title="pomo.primaryLabel" @click="pomo.primaryAction()">
            <Icon :name="pomo.running ? 'pause' : 'play'" :size="16" />
            <span class="sr-only">{{ pomo.primaryLabel }}</span>
          </button>
          <div class="fb-main">
            <div class="fb-top">
              <span class="fb-name">{{ statusText }}</span>
              <button v-if="!pomo.running" class="fb-bind" title="更换专注目标" @click="openBind">
                <Icon name="target" :size="14" />
                <span class="sr-only">{{ pomo.task ? '更换' : '绑定任务' }}</span>
              </button>
              <span class="fb-clock focus-clock mono">{{ clockText }}</span>
            </div>
            <div class="fb-track">
              <i :style="{ width: percent + '%' }" />
            </div>
          </div>
          <button
            class="btn sm ghost"
            :title="showSettings ? '收起时长设置' : '设置时长'"
            aria-label="时长设置"
            @click="toggleSettings"
          >
            <Icon name="settings" :size="14" />
          </button>
          <button
            class="btn sm ghost"
            title="全屏专注（大圆环）"
            aria-label="全屏专注"
            @click="toggleFull"
          >
            <Icon name="expand" :size="14" />
          </button>
        </div>
        <div v-if="showSettings" class="focus-settings">
          <div class="row" style="gap: 8px">
            <label class="fs-lab">专注时长</label>
            <input
              :value="focusDraft"
              class="input mono"
              type="number"
              :min="MIN_MINUTES"
              :max="MAX_MINUTES"
              style="width: 76px"
              @input="onDurationInput('focus', $event)"
              @change="onDurationInput('focus', $event)"
            />
            <span class="muted" style="font-size: 12px">分钟</span>
          </div>
          <div class="row" style="gap: 8px">
            <label class="fs-lab">休息时长</label>
            <input
              :value="breakDraft"
              class="input mono"
              type="number"
              :min="MIN_MINUTES"
              :max="MAX_MINUTES"
              style="width: 76px"
              @input="onDurationInput('break', $event)"
              @change="onDurationInput('break', $event)"
            />
            <span class="muted" style="font-size: 12px">分钟</span>
            <button class="btn sm ghost" style="margin-left: auto" @click="reset4520">
              恢复 45 / 20
            </button>
          </div>
          <p class="muted" style="font-size: 11.5px; margin: 0">
            范围 {{ MIN_MINUTES }} ~ {{ MAX_MINUTES }} 分钟。计时进行中不能改，先结束或重置。
          </p>
        </div>
      </div>
      <div class="focus-right">
        <FocusOverview />
        <FocusRecords />
      </div>
    </div>

    <div v-if="full" class="focus-full">
      <div class="ring" :style="{ '--p': percent }">
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

    <div v-if="bindOpen" class="overlay" @click.self="bindOpen = false">
      <div class="modal" style="width: 460px">
        <h3 style="font-size: 15px">绑定本轮专注目标</h3>
        <div>
          <div class="muted" style="font-size: 11.5px; margin-bottom: 6px">手输任务名</div>
          <input
            v-model="bindName"
            class="input"
            type="text"
            maxlength="60"
            placeholder="例如：线代第 3 章 / 背 50 个单词"
          />
          <div class="row" style="gap: 6px; flex-wrap: wrap; margin-top: 8px">
            <span
              v-for="(name, i) in targetNames"
              :key="name + i"
              class="chip"
              :class="{ 'chip-edit': chipEdit }"
              @click="chipEdit ? startEdit(i) : pickName(name)"
            >
              {{ name }}
              <i
                v-if="chipEdit"
                class="chip-x"
                title="删掉这个目标"
                @click.stop="removeTarget(i)"
                >✕</i
              >
            </span>
            <span class="chip" :class="{ on: chipEdit }" @click="toggleChipEdit()">
              {{ chipEdit ? '完成' : '＋ 自定义' }}
            </span>
          </div>
          <div v-if="chipEdit" class="row" style="gap: 6px; margin-top: 8px">
            <input
              v-model="chipDraft"
              class="input grow"
              type="text"
              :maxlength="NAME_MAX"
              placeholder="目标名（12 字以内）"
              @keyup.enter="saveTarget()"
            />
            <button class="btn sm" :disabled="!chipDraft.trim()" @click="saveTarget()">
              {{ editIndex >= 0 ? '保存' : '添加' }}
            </button>
            <button v-if="editIndex >= 0" class="btn sm ghost" @click="cancelEdit()">取消</button>
            <button class="btn sm ghost" title="恢复成默认的四个" @click="restoreDefaults()">
              恢复默认
            </button>
          </div>
          <p v-if="chipEdit" class="muted" style="font-size: 11.5px; margin: 6px 0 0">
            点目标名可以改名，点 ✕ 删除，最多 {{ MAX_TARGETS }} 个、每个 {{ NAME_MAX }} 字。
          </p>
        </div>
        <div>
          <div class="muted" style="font-size: 11.5px; margin-bottom: 6px">
            或从学习清单里选（{{ shelfPreview.length }} / {{ (learn.shelf || []).length }}）
          </div>
          <div class="task-list">
            <div v-if="!shelfPreview.length" class="muted" style="font-size: 12.5px; padding: 6px 2px">
              学习清单还是空的，去播放页把要学的视频「加入学习清单」。
            </div>
            <button
              v-for="item in shelfPreview"
              :key="item.bvid"
              class="task-item"
              :class="{ on: bindName === item.title }"
              @click="pickName(item.title)"
            >
              {{ item.title }}
            </button>
          </div>
        </div>
        <div class="row" style="justify-content: flex-end; gap: 8px">
          <button class="btn ghost" @click="unbind">不绑定</button>
          <button class="btn ghost" @click="bindOpen = false">取消</button>
          <button class="btn primary" :disabled="running" @click="confirmBind">
            <Icon name="check" :size="14" /> 确定
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 来源: LearnView-DSahkCnj.css  scope: data-v-8e66c095 */
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
  transition:
    filter 0.13s,
    transform 0.08s;
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
  transition:
    background 0.13s,
    color 0.13s;
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
  }}
</style>
