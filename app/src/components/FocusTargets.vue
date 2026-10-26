<script setup lang="ts">
/**
 * 专注目标管理：新增 / 改名 / 归档 / 删除，以及从目标行直接开一轮专注
 * 还原自 LearnView-ByneIRdr.js 的 FocusTargets 组件（data-v-327feb51）。
 */
import { ref, computed, nextTick } from 'vue'
import Icon from '@/components/Icon.vue'
import { usePomodoroStore } from '@/stores/pomodoro'
import { useSettingsStore, accentColor, makeFocusTarget, pickBrandFg, FOCUS_COLOR_KEYS } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { formatClock } from '@/utils/format'
import type { FocusTarget } from '@/types'

/** 目标名字数上限 */
const NAME_MAX = 12
/** 最多几个目标 */
const MAX_TARGETS = 12

const pomo = usePomodoroStore()
const settings = useSettingsStore()
const ui = useUiStore()

/** 当前 tab：坚持中 / 已归档 */
const tab = ref<'active' | 'archived'>('active')
/** 新建输入框是否展开 */
const adding = ref(false)
const draft = ref('')
const draftEl = ref<any>(null)
/** 正在改名的目标名（空 = 没有在改名） */
const renaming = ref('')
const renameDraft = ref('')
const renameEl = ref<any>(null)
/** 新建时选的颜色 */
const draftColor = ref('')

const targets = computed<FocusTarget[]>(() =>
  Array.isArray(settings.settings.focusTargets) ? settings.settings.focusTargets : [],
)
const activeTargets = computed(() => targets.value.filter((t) => !t.archived))
const archivedTargets = computed(() => targets.value.filter((t) => t.archived))
const shown = computed(() => (tab.value === 'archived' ? archivedTargets.value : activeTargets.value))
/** 当前绑定的目标名 */
const boundName = computed(() => (pomo.task && pomo.task.name) || '')
const todayByTarget = computed(() => pomo.todayByTarget)

function colorOf(t: FocusTarget) {
  return accentColor(t.color, settings.settings.theme)
}

/** 目标圆标的内联样式（底色 + 对比文字色） */
function markStyle(t: FocusTarget) {
  const bg = colorOf(t)
  return { background: bg, color: pickBrandFg(bg) }
}

/** 圆标里显示首字 */
function initial(name: string) {
  return String(name || '?').slice(0, 1)
}

/** 目标行右侧的「今日 25m · 2 轮」 */
function todayText(name: string) {
  const row = todayByTarget.value[name]
  if (!row || !row.seconds) return '今日 —'
  return `今日 ${formatClock(row.seconds)}${row.count > 1 ? ` · ${row.count} 轮` : ''}`
}

async function save(next: FocusTarget[]) {
  await settings.setFocusTargets(next)
}

function startAdd() {
  adding.value = true
  draft.value = ''
  draftColor.value = FOCUS_COLOR_KEYS[targets.value.length % FOCUS_COLOR_KEYS.length]
  nextTick(() => draftEl.value && draftEl.value.focus())
}

async function addTarget() {
  const name = draft.value.trim().slice(0, NAME_MAX)
  if (!name) {
    adding.value = false
    return
  }
  if (targets.value.length >= MAX_TARGETS) {
    ui.err(`最多 ${MAX_TARGETS} 个目标，先归档几个吧`)
    return
  }
  if (targets.value.some((t) => t.name === name)) {
    ui.err(`已经有「${name}」了`)
    return
  }
  const item = makeFocusTarget(name, targets.value.length)
  if (draftColor.value) item.color = draftColor.value
  await save([...targets.value, item])
  adding.value = false
  draft.value = ''
  ui.toast(`已添加「${name}」`)
}

/** 点目标名开始改名 */
function startRename(t: FocusTarget) {
  renaming.value = t.name
  renameDraft.value = t.name
  nextTick(() => {
    const el = renameEl.value
    const input = Array.isArray(el) ? el[0] : el
    if (input && input.focus) input.focus()
  })
}

async function commitRename(t: FocusTarget) {
  if (renaming.value !== t.name) return
  const name = renameDraft.value.trim().slice(0, NAME_MAX)
  renaming.value = ''
  if (!name || name === t.name) return
  if (targets.value.some((x) => x.name === name)) {
    ui.err(`已经有「${name}」了`)
    return
  }
  const old = t.name
  await save(targets.value.map((x) => (x.name === old ? { ...x, name } : x)))
  // 历史记录一起改名
  const n = await pomo.renameTask(old, name)
  ui.toast(n ? `已改名，${n} 条记录一起改了` : '已改名')
}

async function archive(t: FocusTarget) {
  await save(targets.value.map((x) => (x.name === t.name ? { ...x, archived: true } : x)))
  if (boundName.value === t.name && !pomo.running) pomo.clearTask()
  ui.toast(`「${t.name}」已归档，历史记录都还在`)
}

async function unarchive(t: FocusTarget) {
  await save(targets.value.map((x) => (x.name === t.name ? { ...x, archived: false } : x)))
  ui.toast(`「${t.name}」已回到坚持中`)
}

async function removeTarget(t: FocusTarget) {
  const stat = pomo.byTarget[t.name]
  const extra = stat && stat.count
    ? `它的 ${stat.count} 条专注记录会保留（显示成「${t.name}」）。`
    : ''
  if (
    await ui.confirm(`彻底删除「${t.name}」？`, `删除后不能再把它设成目标。${extra}`, '删除')
  ) {
    await save(targets.value.filter((x) => x.name !== t.name))
    ui.toast(`已删除「${t.name}」`)
  }
}

/** 点行尾 ▶ 开始这一轮专注 */
async function startFocus(t: FocusTarget) {
  const name = t.name
  if (pomo.running && boundName.value === name) {
    await pomo.primaryAction()
    return
  }
  if (pomo.running) {
    if (
      !(await ui.confirm(
        `切换到「${name}」？`,
        '当前这一轮的计时会先结束并记进专注记录。',
        '结束并开始',
      ))
    )
      return
    await pomo.finish(false)
  } else if (pomo.remain < pomo.totalSeconds) {
    if (
      !(await ui.confirm(
        `开始「${name}」？`,
        '有一轮没走完的计时，会先归零再开始。',
        '开始新的',
      ))
    )
      return
  }
  pomo.setMode('focus')
  pomo.reset()
  pomo.setTask({ name })
  pomo.start()
}
</script>

<template>
  <div class="ft-body">
    <div class="ft-head focus-head">
      <Icon name="target" :size="15" />
      <b>专注目标</b>
      <span class="muted ft-today">今日 {{ pomo.todayCount }} 轮 · {{ formatClock(pomo.todaySeconds) }}</span>
      <span class="grow" />
      <button class="btn sm ghost" title="新建目标" aria-label="新建目标" @click="startAdd">
        <Icon name="plus" :size="15" />
      </button>
    </div>

    <div class="ft-tabs">
      <button class="ft-tab" :class="{ on: tab === 'active' }" @click="tab = 'active'">
        坚持中 <span class="n">{{ activeTargets.length }}</span>
      </button>
      <button class="ft-tab" :class="{ on: tab === 'archived' }" @click="tab = 'archived'">
        已归档 <span class="n">{{ archivedTargets.length }}</span>
      </button>
      <span class="grow" />
    </div>

    <div v-if="adding" class="ft-add">
      <input
        ref="draftEl"
        v-model="draft"
        class="input"
        type="text"
        :maxlength="NAME_MAX"
        placeholder="目标名，比如 英语课 / 刷题"
        @keyup.enter="addTarget"
        @keyup.esc="adding = false"
      />
      <div class="ft-colors">
        <button
          v-for="key in FOCUS_COLOR_KEYS"
          :key="key"
          class="ft-swatch"
          :class="{ on: draftColor === key }"
          :style="{ background: accentColor(key, settings.settings.theme) }"
          :title="key"
          :aria-label="key"
          @click="draftColor = key"
        />
      </div>
      <div class="row" style="gap: 8px">
        <button class="btn sm primary" :disabled="!draft.trim()" @click="addTarget">添加</button>
        <button class="btn sm ghost" @click="adding = false">取消</button>
      </div>
    </div>

    <div v-if="shown.length" class="ft-list">
      <div
        v-for="t in shown"
        :key="t.name"
        class="ft-row"
        :class="{ on: boundName === t.name && pomo.mode === 'focus' }"
      >
        <span class="ft-mark" :style="markStyle(t)">{{ initial(t.name) }}</span>
        <input
          v-if="renaming === t.name"
          ref="renameEl"
          v-model="renameDraft"
          class="input ft-rename"
          type="text"
          :maxlength="NAME_MAX"
          @keyup.enter="commitRename(t)"
          @keyup.esc="renaming = ''"
          @blur="commitRename(t)"
        />
        <template v-else>
          <button class="ft-name" :title="t.name" @click="startRename(t)">{{ t.name }}</button>
          <span class="ft-time">{{ todayText(t.name) }}</span>
        </template>

        <template v-if="tab === 'archived'">
          <button class="ft-go" title="恢复到坚持中" aria-label="恢复" @click="unarchive(t)">
            <Icon name="refresh" :size="14" />
          </button>
          <button class="ft-go" title="彻底删除" aria-label="删除" @click="removeTarget(t)">
            <Icon name="trash" :size="14" />
          </button>
        </template>
        <template v-else>
          <button class="ft-arch" title="归档（历史记录都留着）" aria-label="归档" @click="archive(t)">
            <Icon name="archive" :size="14" />
          </button>
          <button
            class="ft-go"
            :class="{ running: pomo.running && boundName === t.name }"
            :title="pomo.running && boundName === t.name ? '结束这一轮' : `开始「${t.name}」`"
            :aria-label="pomo.running && boundName === t.name ? '结束这一轮' : '开始'"
            @click="startFocus(t)"
          >
            <Icon :name="pomo.running && boundName === t.name ? 'pause' : 'play'" :size="14" />
          </button>
        </template>
      </div>
    </div>

    <div v-else class="ft-empty">
      <p class="muted">
        {{ tab === 'archived' ? '还没有归档的目标。' : '还没有目标，点右上角 ＋ 加一个。' }}
      </p>
    </div>
  </div>
</template>

<style scoped>
/* 来源: LearnView-DSahkCnj.css  scope: data-v-327feb51 */
.ft-body {
  min-width: 0;
}
.ft-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
}
.ft-head > .icon {
  color: var(--brand);
  flex: none;
}
.ft-head b {
  font-size: 14px;
}
.ft-today {
  font-size: 12px;
  font-family: var(--mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ft-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 0 10px;
}
.ft-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 12.5px;
  color: var(--t2);
  background: var(--soft);
  border: 1px solid transparent;
  cursor: pointer;
}
.ft-tab:hover {
  color: var(--t1);
}
.ft-tab.on {
  background: var(--brand-soft);
  color: var(--brand);
  border-color: var(--brand-line);
  font-weight: 600;
}
.ft-tab .n {
  font-family: var(--mono);
  font-size: 11px;
  opacity: 0.8;
}
.ft-add {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  margin-bottom: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--soft);
}
.ft-colors {
  display: flex;
  gap: 6px;
}
.ft-swatch {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  padding: 0;
  cursor: pointer;
}
.ft-swatch.on {
  border-color: var(--card);
  box-shadow: 0 0 0 2px var(--brand);
}
.ft-empty {
  padding: 28px 10px 30px;
  text-align: center;
}
.ft-empty p {
  margin: 0;
  font-size: 12.5px;
}
.ft-list {
  display: flex;
  flex-direction: column;
}
.ft-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
}
.ft-row:hover {
  background: var(--card-hover);
}
.ft-row.on {
  background: var(--brand-soft);
}
.ft-row.on:before {
  content: "";
  position: absolute;
  left: -16px;
  top: 6px;
  bottom: 6px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--brand);
}
.ft-mark {
  width: 26px;
  height: 26px;
  flex: none;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 12.5px;
  font-weight: 700;
}
.ft-name {
  flex: 1;
  min-width: 0;
  text-align: left;
  font-size: 13.5px;
  color: inherit;
  background: transparent;
  border: 0;
  padding: 0;
  cursor: text;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ft-row.on .ft-name {
  font-weight: 600;
}
.ft-rename {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  font-size: 13px;
}
.ft-time {
  font-size: 12px;
  color: var(--t3);
  font-family: var(--mono);
  white-space: nowrap;
}
.ft-row.on .ft-time {
  color: var(--brand);
}
.ft-arch {
  flex: none;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--t3);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 0.12s,
    color 0.12s,
    background 0.12s;
}
.ft-row:hover .ft-arch {
  opacity: 1;
}
.ft-arch:hover {
  background: var(--soft-hover);
  color: var(--t1);
}
.ft-arch:focus-visible {
  opacity: 1;
}
.ft-go {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: none;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  color: var(--t2);
  cursor: pointer;
}
.ft-go:hover {
  border-color: var(--brand-line);
  color: var(--brand);
  background: var(--soft);
}
.ft-go.running {
  background: var(--brand);
  border-color: var(--brand);
  color: var(--brand-fg);
}
.ft-row.on .ft-go {
  border-color: var(--brand);
  color: var(--brand);
}
.ft-row.on .ft-go.running {
  color: var(--brand-fg);
}
</style>
