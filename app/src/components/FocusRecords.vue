<script setup lang="ts">
/**
 * 专注记录：按天分组的时间轴 + 手动补记 / 删除 / 清空
 * 还原自 LearnView-ByneIRdr.js 的 FocusRecords 组件（data-v-cf942c30）。
 */
import { ref, reactive } from 'vue'
import Icon from '@/components/Icon.vue'
import { usePomodoroStore } from '@/stores/pomodoro'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { formatDuration, todayStr, hhmm } from '@/utils/format'

const pomo = usePomodoroStore()
const settings = useSettingsStore()
const ui = useUiStore()

/** 手动补记弹窗 */
const open = ref(false)
const form = reactive({ date: todayStr(), time: hhmm(), minutes: 25, task: '' })

/** 可选的专注目标名（未归档） */
function targetOptions() {
  return (settings.settings.focusTargets || []).filter((t) => t && !t.archived).map((t) => t.name)
}

function openManual() {
  form.date = todayStr()
  form.time = hhmm()
  form.minutes = 25
  form.task = ''
  open.value = true
}

async function submitManual() {
  const minutes = Math.round(Number(form.minutes))
  if (!Number.isFinite(minutes) || minutes < 1) {
    ui.err('时长请填 1 分钟以上')
    return
  }
  const saved = await pomo.addManualSession({
    date: form.date,
    time: form.time,
    minutes,
    task: form.task.trim(),
  })
  if (saved) {
    open.value = false
    ui.ok(`已补记 ${minutes} 分钟`)
  } else {
    ui.err('日期格式不对，应该是 2026-10-12 这样')
  }
}

async function removeRow(row: any) {
  if (
    await ui.confirm('删掉这条记录？', `${row.range} · ${row.dur} · ${row.task || '未绑定任务'}`, '删除')
  ) {
    await pomo.removeSession(row.id)
    ui.toast('已删掉 1 条记录')
  }
}

async function clearAll() {
  if (
    await ui.confirm(
      '清空全部专注记录？',
      `一共 ${pomo.allCount} 条，清空后学习时长统计也会一起归零。`,
      '清空',
    )
  ) {
    await pomo.clearSessions()
    ui.toast('专注记录已清空')
  }
}
</script>

<template>
  <div class="panel rec">
    <div class="rec-head">
      <Icon name="clock" :size="15" />
      <b>专注记录</b>
      <span class="muted rec-sub">共 {{ pomo.allCount }} 条</span>
      <span class="grow" />
      <button class="btn sm ghost" title="清空全部记录" :disabled="!pomo.allCount" @click="clearAll">
        <Icon name="trash" :size="14" />
      </button>
      <button class="btn sm ghost" title="手动补记一条" @click="openManual">
        <Icon name="plus" :size="14" />
      </button>
    </div>

    <div v-if="pomo.byDay.length" class="rec-scroll">
      <div v-for="group in pomo.byDay" :key="group.day" class="rec-day">
        <div class="rec-day-t">
          <span>{{ group.label }}</span>
          <span class="rec-day-s mono">{{ formatDuration(group.seconds) }}</span>
        </div>
        <div class="rec-list">
          <div v-for="row in group.rows" :key="row.id" class="rec-item">
            <div class="rec-rail">
              <span class="dot" :class="{ partial: !row.completed }">
                <Icon v-if="row.completed" name="check" :size="9" />
              </span>
            </div>
            <div class="rec-body">
              <div class="rec-top">
                <span class="rec-time">{{ row.range }}</span>
                <span class="rec-dur">{{ row.dur }}</span>
              </div>
              <div class="rec-task">
                <span class="dot2" />
                <span class="clamp-1">{{ row.task || '未绑定任务' }}</span>
                <button class="rec-del" title="删掉这条" @click="removeRow(row)">
                  <Icon name="x" :size="12" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="rec-empty">
      <Icon name="clock" :size="22" />
      <p class="muted">还没有专注记录。点左边目标行右边的 ▶ 开始一轮，或用右上角 ＋ 手动补一条。</p>
    </div>

    <div v-if="open" class="overlay" @click.self="open = false">
      <div class="modal" style="width: 420px">
        <h3 style="font-size: 15px">手动补记一条专注</h3>
        <div class="row" style="gap: 8px">
          <label class="add-lab">日期</label>
          <input v-model="form.date" class="input mono" type="date" style="flex: 1" />
        </div>
        <div class="row" style="gap: 8px">
          <label class="add-lab">开始</label>
          <input v-model="form.time" class="input mono" type="time" style="flex: 1" />
        </div>
        <div class="row" style="gap: 8px">
          <label class="add-lab">时长</label>
          <input
            v-model="form.minutes"
            class="input mono"
            type="number"
            min="1"
            max="600"
            style="width: 96px"
          />
          <span class="muted" style="font-size: 12px">分钟</span>
        </div>
        <div>
          <div class="muted" style="font-size: 11.5px; margin-bottom: 6px">做了什么（可留空）</div>
          <input
            v-model="form.task"
            class="input"
            type="text"
            maxlength="12"
            placeholder="例如：英语课 / 刷题"
          />
          <div v-if="targetOptions().length" class="row" style="gap: 6px; flex-wrap: wrap; margin-top: 8px">
            <span v-for="name in targetOptions()" :key="name" class="chip" @click="form.task = name">
              {{ name }}
            </span>
          </div>
        </div>
        <p class="muted" style="font-size: 12px; margin: 0">
          补记的时长会算进「总专注时长」和当天时长，番茄数也会 +1。结束时间按「开始 + 时长」记录。
        </p>
        <div class="row" style="justify-content: flex-end; gap: 8px">
          <button class="btn ghost" @click="open = false">取消</button>
          <button class="btn primary" @click="submitManual">
            <Icon name="check" :size="14" /> 记下来
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 来源: LearnView-DSahkCnj.css  scope: data-v-cf942c30 */
.rec {
  padding: 14px 16px 12px;
}
.rec-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.rec-head > .icon {
  color: var(--brand);
}
.rec-head b {
  font-size: 14px;
}
.rec-sub {
  font-size: 12px;
}
.rec-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
  color: var(--t3);
  padding: 34px 20px 30px;
}
.rec-empty p {
  margin: 0;
  font-size: 12.5px;
  max-width: 320px;
  line-height: 1.6;
}
.rec-scroll {
  max-height: 296px;
  overflow: auto;
  margin: 0 -4px;
  padding: 0 4px;
}
.rec-scroll::-webkit-scrollbar {
  width: 10px;
}
.rec-scroll::-webkit-scrollbar-thumb {
  background: var(--line-strong);
  border: 3px solid transparent;
  background-clip: padding-box;
  border-radius: 8px;
}
.rec-day {
  padding-top: 10px;
}
.rec-day-t {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--t3);
  padding: 0 0 8px 2px;
}
.rec-day-s {
  margin-left: auto;
  font-weight: 400;
  opacity: 0.85;
}
.rec-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.rec-item {
  display: flex;
  gap: 10px;
}
.rec-rail {
  position: relative;
  width: 14px;
  flex: none;
  display: flex;
  justify-content: center;
}
.rec-item:not(:last-child) .rec-rail:after {
  content: "";
  position: absolute;
  top: 18px;
  bottom: -14px;
  width: 1px;
  background: var(--line);
}
.rec-rail .dot {
  position: relative;
  z-index: 1;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--brand);
  color: var(--brand-fg);
  display: grid;
  place-items: center;
  font-size: 9px;
  margin-top: 2px;
}
.rec-rail .dot.partial {
  background: var(--card);
  border: 1.5px solid var(--line-strong);
}
.rec-body {
  flex: 1;
  min-width: 0;
}
.rec-top {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.rec-time {
  font-size: 12.5px;
  font-family: var(--mono);
  color: var(--t2);
}
.rec-dur {
  margin-left: auto;
  font-size: 12.5px;
  font-family: var(--mono);
  color: var(--t2);
}
.rec-task {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--t3);
  margin-top: 3px;
}
.rec-task .clamp-1 {
  min-width: 0;
}
.rec-task .dot2 {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
}
.rec-del {
  flex: none;
  width: 22px;
  height: 22px;
  margin-left: auto;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--t3);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 0.12s,
    color 0.12s,
    background 0.12s;
}
.rec-item:hover .rec-del {
  opacity: 1;
}
.rec-del:hover {
  background: var(--soft-hover);
  color: var(--danger);
}
.rec-del:focus-visible {
  opacity: 1;
}
.add-lab {
  width: 42px;
  flex: none;
  font-size: 12.5px;
  color: var(--t2);
}
</style>
