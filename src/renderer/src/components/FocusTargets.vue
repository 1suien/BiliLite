<script setup>
/**
 * 专注目标面板（替代原来的「专注记录」）
 *
 * 和 TickTick 的「专注」一样：把想做的事列成目标，点一下就直接开始计时，
 * 不用先选任务再点开始。目标列表用的就是设置里那份 focusTasks
 * （和专注面板里「快捷任务」同一份数据，两边同步）。
 */
import { ref, computed, onMounted } from 'vue'
import Icon from './Icon.vue'
import { usePomodoroStore } from '../stores/pomodoro'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { fmtDuration } from '../utils/format'

const pomo = usePomodoroStore()
const settings = useSettingsStore()
const ui = useUiStore()

const QUICK_MAX = 8
const NAME_MAX = 12
const DEFAULT_TARGETS = ['阅读', '刷题', '看课', '整理笔记']

const editing = ref(false)
const draft = ref('')
const renaming = ref(-1)
const renameText = ref('')

const targets = computed(() => {
  const list = settings.settings.focusTasks
  // 只有「从来没有过」才回落到默认目标；被用户删空的空数组要保持为空，
  // 否则删光了又自己长回来，会让人以为删除没生效。
  const arr = Array.isArray(list) ? list : DEFAULT_TARGETS
  return arr.slice(0, QUICK_MAX)
})

/** 目标名 → 累计时长 / 轮数（按专注记录里的 task 聚合） */
const totals = computed(() => {
  const map = {}
  for (const s of pomo.sessions || []) {
    const name = (s && s.task) || '未绑定任务'
    if (!map[name]) map[name] = { seconds: 0, count: 0 }
    map[name].seconds += Number(s.seconds) || 0
    map[name].count += 1
  }
  return map
})

/** 当前绑定的目标名（没绑就是空串） */
const currentName = computed(() => (pomo.task && pomo.task.name) || '')

function totalText(name) {
  const t = totals.value[name]
  if (!t || !t.count) return '还没开始'
  return `${fmtDuration(t.seconds)} · ${t.count} 轮`
}

/** 行内「正在进行」的实时提示：目标行右侧显示已走的时长 */
function liveText(name) {
  if (pomo.running && currentName.value === name) return fmtDuration(pomo.elapsedSeconds)
  return ''
}

function save(list) {
  const clean = list.map((x) => String(x).trim()).filter(Boolean).slice(0, QUICK_MAX)
  settings.patch({ focusTasks: clean })
}

function toggleEdit() {
  editing.value = !editing.value
  renaming.value = -1
  draft.value = ''
}

function add() {
  const name = draft.value.trim()
  if (!name) return
  if (targets.value.includes(name)) {
    ui.err('已经有这个目标了')
    return
  }
  if (targets.value.length >= QUICK_MAX) {
    ui.err(`最多 ${QUICK_MAX} 个目标`)
    return
  }
  save([...targets.value, name])
  draft.value = ''
  ui.ok(`已添加「${name}」`)
}

function startRename(i) {
  renaming.value = i
  renameText.value = targets.value[i]
}

function commitRename(i) {
  if (renaming.value !== i) return
  const name = renameText.value.trim().slice(0, NAME_MAX)
  renaming.value = -1
  const old = targets.value[i]
  if (!name || name === old) return
  const list = [...targets.value]
  list[i] = name
  save(list)
  // 正在专注的就是它 → 跟着改名，否则这一轮的记录会挂到一个已经不存在的目标上
  if (currentName.value === old) pomo.setTask({ name })
}

function remove(i) {
  const name = targets.value[i]
  const list = targets.value.filter((_, k) => k !== i)
  save(list)
  ui.toast(`已删除「${name}」`)
}

/**
 * 点目标 = 开始专注。
 * 正在跑 / 跑了一半的情况先问一句，别让用户不小心丢掉手上的这一轮。
 */
async function startTarget(name) {
  if (pomo.running && currentName.value === name) {
    const ok = await ui.confirm(
      '结束这次专注？',
      `「${name}」已经专注 ${fmtDuration(pomo.elapsedSeconds)}，会按「部分完成」记进专注记录。`,
      '结束专注'
    )
    if (!ok) return
    await pomo.finish(false)
    return
  }
  if (pomo.running) {
    const ok = await ui.confirm(
      '切换到别的目标？',
      `正在专注「${currentName.value || '未绑定任务'}」。会先把它按「部分完成」记下来，再开始「${name}」。`,
      '结束并开始'
    )
    if (!ok) return
    await pomo.finish(false)
  } else if (pomo.remain < pomo.totalSeconds) {
    const ok = await ui.confirm(
      '开始新的一轮？',
      `「${currentName.value || '未绑定任务'}」这一轮已经走了 ${fmtDuration(pomo.elapsedSeconds)}，开始新的一轮会把它作废。`,
      '开始新的'
    )
    if (!ok) return
  }
  pomo.setTask({ name })
  pomo.setMode('focus')
  pomo.start()
}

onMounted(() => {
  if (!pomo.statsLoaded) pomo.loadStats().catch(() => {})
})
</script>

<template>
  <div class="panel ft">
    <div class="ft-head">
      <Icon name="target" :size="15" />
      <b>专注目标</b>
      <span class="muted ft-today">今日 {{ pomo.todayCount }} 轮 · {{ fmtDuration(pomo.todaySeconds) }}</span>
      <div class="grow" />
      <button class="btn sm ghost" @click="toggleEdit">
        <Icon :name="editing ? 'check' : 'list'" :size="14" /> {{ editing ? '完成' : '管理' }}
      </button>
    </div>

    <div class="ft-list">
      <div
        v-for="(t, i) in targets"
        :key="t"
        class="ft-row"
        :class="{ on: currentName === t && pomo.running }"
      >
        <span class="ft-mark"><Icon name="target" :size="14" /></span>

        <input
          v-if="editing && renaming === i"
          class="input ft-rename"
          :value="renameText"
          :maxlength="NAME_MAX"
          @input="renameText = $event.target.value"
          @keyup.enter="commitRename(i)"
          @blur="commitRename(i)"
        />
        <span
          v-else
          class="ft-name"
          :class="{ editable: editing }"
          :title="editing ? '点一下改名' : `开始专注「${t}」`"
          @click="editing ? startRename(i) : startTarget(t)"
        >
          {{ t }}
        </span>

        <span v-if="liveText(t)" class="ft-live mono">{{ liveText(t) }}</span>
        <span v-else class="muted ft-total">{{ totalText(t) }}</span>

        <button v-if="editing" class="btn sm ghost ft-del" title="删除这个目标" @click="remove(i)">
          <Icon name="trash" :size="14" />
        </button>
        <button
          v-else
          class="btn sm ft-go"
          :class="{ primary: currentName === t && pomo.running }"
          :title="currentName === t && pomo.running ? '结束这次专注' : `开始专注「${t}」`"
          @click="startTarget(t)"
        >
          <Icon :name="currentName === t && pomo.running ? 'pause' : 'play'" :size="14" />
          {{ currentName === t && pomo.running ? '结束' : '开始' }}
        </button>
      </div>
    </div>

    <p v-if="!targets.length" class="muted" style="margin: 0">还没有目标，点右上角「管理」加一个，比如「阅读」「刷题」。</p>

    <div v-if="editing" class="row ft-add">
      <input
        v-model="draft"
        class="input"
        :maxlength="NAME_MAX"
        placeholder="新增目标，回车确认"
        @keyup.enter="add"
      />
      <button class="btn sm primary" :disabled="!draft.trim() || targets.length >= QUICK_MAX" @click="add">
        <Icon name="plus" :size="14" /> 添加
      </button>
    </div>
  </div>
</template>

<style scoped>
.ft {
  margin-bottom: 18px;
  padding: 14px 16px 12px;
}
.ft-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.ft-head b {
  font-size: 14px;
}
/* 图标也跟着「专注」主题走品牌色，和 FocusPanel 的头一致 */
.ft-head > .icon {
  color: var(--brand);
}
.ft-today {
  font-size: 12px;
}
.ft-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ft-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  transition: background 0.13s, border-color 0.13s;
}
.ft-row:hover {
  background: var(--card-hover);
}
.ft-row.on {
  background: var(--brand-soft);
  border-color: transparent;
}
.ft-mark {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--soft);
  color: var(--t3);
  flex: none;
}
.ft-row.on .ft-mark {
  background: var(--brand);
  color: var(--brand-fg);
}
.ft-name {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.ft-name.editable {
  color: var(--brand);
}
.ft-total,
.ft-live {
  font-size: 12px;
  flex: none;
}
.ft-live {
  color: var(--brand);
}
.ft-rename {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  font-size: 13px;
}
.ft-go,
.ft-del {
  flex: none;
}
.ft-add {
  margin-top: 10px;
  gap: 8px;
}
</style>
