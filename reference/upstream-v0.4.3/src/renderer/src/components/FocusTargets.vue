<script setup>
/**
 * 专注目标（学习页左栏）：目标列表 + 坚持中/已归档两个页签。
 *
 * 数据只有一个来源：settings.focusTargets（[{name,color,archived,createdAt}]）。
 * 旧的 settings.focusTasks 由 setFocusTargets 自动同步，飘层里的快捷任务还在读它。
 * 历史专注记录靠「任务名」关联，所以目标改名时要顺手把记录里的名字也改掉（pomo.renameTask）。
 */
import { computed, nextTick, ref } from 'vue'
import Icon from './Icon.vue'
import { usePomodoroStore } from '../stores/pomodoro'
import {
  useSettingsStore,
  DEFAULT_FOCUS_TARGETS,
  TARGET_COLOR_KEYS,
  brandFg,
  makeFocusTarget,
  targetHex
} from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { fmtDuration } from '../utils/format'

const pomo = usePomodoroStore()
const settings = useSettingsStore()
const ui = useUiStore()

const NAME_MAX = 12
const MAX_TARGETS = 12

const tab = ref('active') // active | archived
const adding = ref(false)
const draft = ref('')
const draftEl = ref(null)
const renaming = ref('') // 正在改名的目标名（空 = 没在改名）
const renameText = ref('')
const renameEl = ref(null)
/** 新建时选的色相，默认跟着目标数量轮换 */
const draftColor = ref('')

const all = computed(() =>
  Array.isArray(settings.settings.focusTargets) ? settings.settings.focusTargets : []
)
const activeList = computed(() => all.value.filter((t) => !t.archived))
const archivedList = computed(() => all.value.filter((t) => t.archived))
const list = computed(() => (tab.value === 'archived' ? archivedList.value : activeList.value))
const currentName = computed(() => (pomo.task && pomo.task.name) || '')
const today = computed(() => pomo.todayByTarget)

function hex(t) {
  return targetHex(t.color, settings.settings.theme)
}
function markStyle(t) {
  const bg = hex(t)
  return { background: bg, color: brandFg(bg) }
}
/** 圆标里放名字的第一个字（不用 emoji：Windows 上 emoji 一律彩色，会破坏黑白极简） */
function markText(name) {
  return String(name || '?').slice(0, 1)
}
function todayText(name) {
  const row = today.value[name]
  if (!row || !row.seconds) return '今日 —'
  return `今日 ${fmtDuration(row.seconds)}${row.count > 1 ? ` · ${row.count} 轮` : ''}`
}

async function save(next) {
  await settings.setFocusTargets(next)
}

function startAdd() {
  adding.value = true
  draft.value = ''
  draftColor.value = TARGET_COLOR_KEYS[all.value.length % TARGET_COLOR_KEYS.length]
  nextTick(() => draftEl.value && draftEl.value.focus())
}

async function commitAdd() {
  const name = draft.value.trim().slice(0, NAME_MAX)
  if (!name) {
    adding.value = false
    return
  }
  if (all.value.length >= MAX_TARGETS) {
    ui.err(`最多 ${MAX_TARGETS} 个目标，先归档几个吧`)
    return
  }
  if (all.value.some((t) => t.name === name)) {
    ui.err(`已经有「${name}」了`)
    return
  }
  const t = makeFocusTarget(name, all.value.length)
  if (draftColor.value) t.color = draftColor.value
  await save([...all.value, t])
  adding.value = false
  draft.value = ''
  ui.toast(`已添加「${name}」`)
}

function startRename(t) {
  renaming.value = t.name
  renameText.value = t.name
  // 注意：ref 写在 v-for 里，Vue 给的是数组（同一时刻只会有一个在改名）
  nextTick(() => {
    const el = renameEl.value
    const node = Array.isArray(el) ? el[0] : el
    if (node && node.focus) node.focus()
  })
}

async function commitRename(t) {
  // 回车和失焦都会触发；第一次进来就把 renaming 清空了，第二次直接返回，避免重复保存
  if (renaming.value !== t.name) return
  const next = renameText.value.trim().slice(0, NAME_MAX)
  renaming.value = ''
  if (!next || next === t.name) return
  if (all.value.some((x) => x.name === next)) {
    ui.err(`已经有「${next}」了`)
    return
  }
  const old = t.name
  await save(all.value.map((x) => (x.name === old ? { ...x, name: next } : x)))
  // 历史记录里的任务名跟着改，否则旧记录会挂在一个不存在的目标上
  const n = await pomo.renameTask(old, next)
  ui.toast(n ? `已改名，${n} 条记录一起改了` : '已改名')
}

async function archive(t) {
  await save(all.value.map((x) => (x.name === t.name ? { ...x, archived: true } : x)))
  if (currentName.value === t.name && !pomo.running) pomo.clearTask()
  ui.toast(`「${t.name}」已归档，历史记录都还在`)
}

async function restore(t) {
  await save(all.value.map((x) => (x.name === t.name ? { ...x, archived: false } : x)))
  ui.toast(`「${t.name}」已回到坚持中`)
}

async function remove(t) {
  const rows = pomo.byTarget[t.name]
  const extra = rows && rows.count ? `它的 ${rows.count} 条专注记录会保留（显示成「${t.name}」）。` : ''
  const ok = await ui.confirm(`彻底删除「${t.name}」？`, `删除后不能再把它设成目标。${extra}`, '删除')
  if (!ok) return
  await save(all.value.filter((x) => x.name !== t.name))
  ui.toast(`已删除「${t.name}」`)
}

async function resetDefault() {
  const ok = await ui.confirm('恢复成默认的四个目标？', '当前列表会被替换成 阅读 / 刷题 / 看课 / 整理笔记。', '恢复默认')
  if (!ok) return
  await save(DEFAULT_FOCUS_TARGETS.map((n, i) => makeFocusTarget(n, i)))
  ui.toast('已恢复默认目标')
}

/**
 * 点目标行右边的 ▶：
 *  - 正在跑这个目标 → 问一句要不要结束（不直接停，避免误触）；
 *  - 正在跑别的目标 → 先结束当前这轮再开始；
 *  - 没在跑但有一轮没走完 → 问一句要不要重新开始。
 */
async function act(t) {
  const name = t.name
  if (pomo.running && currentName.value === name) {
    await pomo.primaryAction()
    return
  }
  if (pomo.running) {
    const ok = await ui.confirm(`切换到「${name}」？`, '当前这一轮的计时会先结束并记进专注记录。', '结束并开始')
    if (!ok) return
    await pomo.finish(false)
  } else if (pomo.remain < pomo.totalSeconds) {
    const ok = await ui.confirm(`开始「${name}」？`, '有一轮没走完的计时，会先归零再开始。', '开始新的')
    if (!ok) return
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
      <span class="muted ft-today">今日 {{ pomo.todayCount }} 轮 · {{ fmtDuration(pomo.todaySeconds) }}</span>
      <span class="grow" />
      <button class="btn sm ghost" title="新建目标" aria-label="新建目标" @click="startAdd">
        <Icon name="plus" :size="15" />
      </button>
      <button class="btn sm ghost" title="恢复默认目标" aria-label="恢复默认目标" @click="resetDefault">
        <Icon name="refresh" :size="15" />
      </button>
    </div>

    <div class="ft-tabs">
      <button class="ft-tab" :class="{ on: tab === 'active' }" @click="tab = 'active'">
        坚持中 <span class="n">{{ activeList.length }}</span>
      </button>
      <button class="ft-tab" :class="{ on: tab === 'archived' }" @click="tab = 'archived'">
        已归档 <span class="n">{{ archivedList.length }}</span>
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
        @keyup.enter="commitAdd"
        @keyup.esc="adding = false"
      />
      <div class="ft-colors">
        <button
          v-for="k in TARGET_COLOR_KEYS"
          :key="k"
          class="ft-swatch"
          :class="{ on: draftColor === k }"
          :style="{ background: targetHex(k, settings.settings.theme) }"
          :title="k"
          :aria-label="k"
          @click="draftColor = k"
        />
      </div>
      <div class="row" style="gap: 8px">
        <button class="btn sm primary" :disabled="!draft.trim()" @click="commitAdd">添加</button>
        <button class="btn sm ghost" @click="adding = false">取消</button>
      </div>
    </div>

    <div v-if="!list.length" class="ft-empty">
      <p class="muted">
        {{ tab === 'archived' ? '还没有归档的目标。' : '还没有目标，点右上角 ＋ 加一个。' }}
      </p>
    </div>

    <div v-else class="ft-list">
      <div
        v-for="t in list"
        :key="t.name"
        class="ft-row"
        :class="{ on: currentName === t.name && pomo.mode === 'focus' }"
      >
        <span class="ft-mark" :style="markStyle(t)">{{ markText(t.name) }}</span>

        <template v-if="renaming === t.name">
          <input
            ref="renameEl"
            v-model="renameText"
            class="input ft-rename"
            type="text"
            :maxlength="NAME_MAX"
            @keyup.enter="commitRename(t)"
            @keyup.esc="renaming = ''"
            @blur="commitRename(t)"
          />
        </template>
        <template v-else>
          <button class="ft-name" :title="t.name" @click="startRename(t)">{{ t.name }}</button>
          <span class="ft-time">{{ todayText(t.name) }}</span>
        </template>

        <template v-if="tab === 'archived'">
          <button class="ft-go" title="恢复到坚持中" aria-label="恢复" @click="restore(t)">
            <Icon name="refresh" :size="14" />
          </button>
          <button class="ft-go" title="彻底删除" aria-label="删除" @click="remove(t)">
            <Icon name="trash" :size="14" />
          </button>
        </template>
        <template v-else>
          <button class="ft-arch" title="归档（历史记录都留着）" aria-label="归档" @click="archive(t)">
            <Icon name="archive" :size="14" />
          </button>
          <button
            class="ft-go"
            :class="{ running: pomo.running && currentName === t.name }"
            :title="pomo.running && currentName === t.name ? '结束这一轮' : `开始「${t.name}」`"
            :aria-label="pomo.running && currentName === t.name ? '结束这一轮' : '开始'"
            @click="act(t)"
          >
            <Icon :name="pomo.running && currentName === t.name ? 'pause' : 'play'" :size="14" />
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
/* 当前目标左侧那道品牌色条：panel 有 16px 内边距，所以往左顶出去对齐卡片边 */
.ft-row.on::before {
  content: '';
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
  transition: opacity 0.12s, color 0.12s, background 0.12s;
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
