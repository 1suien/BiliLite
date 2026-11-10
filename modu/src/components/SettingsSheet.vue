<script setup lang="ts">
import type { ReaderSettings } from '@/db'

const props = defineProps<{ settings: ReaderSettings }>()
const emit = defineEmits<{
  (e: 'update', s: ReaderSettings): void
  (e: 'close'): void
}>()

function patch(p: Partial<ReaderSettings>) {
  emit('update', { ...props.settings, ...p })
}

const THEMES = [
  { key: 'paper', name: '纸白', bg: '#f8f4ea', ink: '#26221b' },
  { key: 'sepia', name: '米黄', bg: '#efe0c3', ink: '#3d3323' },
  { key: 'green', name: '松绿', bg: '#e7efe3', ink: '#232b25' },
  { key: 'night', name: '夜间', bg: '#151515', ink: '#b8b2a6' },
] as const
</script>

<template>
  <Transition name="fade" appear>
    <div class="scrim" @click="emit('close')" />
  </Transition>
  <Transition name="sheet" appear>
    <div class="sheet settings-sheet" @click.stop>
      <h3>阅读设置</h3>

      <div class="row">
        <span class="label">主题</span>
        <div class="themes">
          <button
            v-for="t in THEMES"
            :key="t.key"
            class="theme-dot"
            :class="{ on: settings.theme === t.key }"
            :style="{ background: t.bg, color: t.ink }"
            :title="t.name"
            @click="patch({ theme: t.key })"
          >
            {{ t.name }}
          </button>
        </div>
      </div>

      <div class="row">
        <span class="label">字号</span>
        <div class="stepper">
          <button class="step" :disabled="settings.fontSize <= 14" @click="patch({ fontSize: settings.fontSize - 1 })">A−</button>
          <span class="val">{{ settings.fontSize }}</span>
          <button class="step" :disabled="settings.fontSize >= 30" @click="patch({ fontSize: settings.fontSize + 1 })">A+</button>
        </div>
      </div>

      <div class="row">
        <span class="label">行距</span>
        <div class="seg">
          <button
            v-for="lh in [1.6, 1.9, 2.2]"
            :key="lh"
            class="seg-item"
            :class="{ on: Math.abs(settings.lineHeight - lh) < 0.01 }"
            @click="patch({ lineHeight: lh })"
          >
            {{ lh === 1.6 ? '紧凑' : lh === 1.9 ? '适中' : '宽松' }}
          </button>
        </div>
      </div>

      <div class="row">
        <span class="label">字体</span>
        <div class="seg">
          <button class="seg-item" :class="{ on: settings.fontFamily === 'serif' }" @click="patch({ fontFamily: 'serif' })">宋体</button>
          <button class="seg-item" :class="{ on: settings.fontFamily === 'sans' }" @click="patch({ fontFamily: 'sans' })">黑体</button>
        </div>
      </div>

      <div class="row">
        <span class="label">边距</span>
        <div class="seg">
          <button class="seg-item" :class="{ on: settings.margin <= 18 }" @click="patch({ margin: 16 })">窄</button>
          <button class="seg-item" :class="{ on: settings.margin > 18 && settings.margin < 26 }" @click="patch({ margin: 22 })">中</button>
          <button class="seg-item" :class="{ on: settings.margin >= 26 }" @click="patch({ margin: 30 })">宽</button>
        </div>
      </div>

      <div class="row">
        <span class="label">翻页</span>
        <div class="seg">
          <button class="seg-item" :class="{ on: settings.pageAnim === 'slide' }" @click="patch({ pageAnim: 'slide' })">滑动</button>
          <button class="seg-item" :class="{ on: settings.pageAnim === 'fade' }" @click="patch({ pageAnim: 'fade' })">淡入</button>
        </div>
      </div>

      <div class="divider" />

      <div class="row">
        <div class="label-group">
          <span class="label">逐句聚焦</span>
          <span class="desc">只高亮当前句，其余变淡</span>
        </div>
        <button
          class="switch"
          :class="{ on: settings.focusMode }"
          role="switch"
          :aria-checked="settings.focusMode"
          @click="patch({ focusMode: !settings.focusMode })"
        >
          <i />
        </button>
      </div>

      <div class="row">
        <div class="label-group">
          <span class="label">阅读常亮</span>
          <span class="desc">读书时屏幕不自动熄灭</span>
        </div>
        <button
          class="switch"
          :class="{ on: settings.keepAwake }"
          role="switch"
          :aria-checked="settings.keepAwake"
          @click="patch({ keepAwake: !settings.keepAwake })"
        >
          <i />
        </button>
      </div>

      <p class="hint">设置会自动保存，下次打开还是这套。</p>
    </div>
  </Transition>
</template>

<style scoped>
.settings-sheet {
  color: var(--ink);
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 9px 0;
}
.label-group {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.label {
  font-size: 14px;
  color: var(--ink-2);
  flex: 0 0 auto;
  letter-spacing: 0.04em;
}
.desc {
  font-size: 11px;
  color: var(--muted);
  letter-spacing: 0.02em;
}
.divider {
  height: 1px;
  background: var(--line);
  margin: 8px 0 2px;
}
.themes {
  display: flex;
  gap: 8px;
}
.theme-dot {
  width: 52px;
  height: 38px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid rgba(120, 100, 70, 0.25);
  transition: transform 0.12s ease;
}
.theme-dot.on {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  transform: scale(1.03);
}
.stepper {
  display: flex;
  align-items: center;
  gap: 6px;
}
.step {
  height: 38px;
  min-width: 52px;
  border-radius: 11px;
  background: var(--surface-2);
  font-size: 14px;
  font-weight: 600;
}
.step:disabled {
  opacity: 0.35;
}
.val {
  min-width: 30px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  font-size: 15px;
  font-weight: 600;
}
.seg {
  display: flex;
  background: var(--surface-2);
  border-radius: 11px;
  padding: 3px;
  gap: 2px;
}
.seg-item {
  height: 32px;
  padding: 0 12px;
  border-radius: 9px;
  font-size: 13px;
  color: var(--ink-2);
  transition: background 0.15s ease, color 0.15s ease;
}
.seg-item.on {
  background: var(--surface);
  color: var(--ink);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(60, 48, 28, 0.14);
}
.switch {
  width: 46px;
  height: 28px;
  border-radius: 999px;
  background: var(--line-strong);
  position: relative;
  transition: background 0.18s ease;
  flex: 0 0 auto;
}
.switch i {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.22);
  transition: transform 0.18s cubic-bezier(0.32, 0.72, 0, 1);
}
.switch.on {
  background: var(--accent);
}
.switch.on i {
  transform: translateX(18px);
}
.hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--muted);
  text-align: center;
}
</style>
