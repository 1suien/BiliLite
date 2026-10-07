<script setup>
import { ref, onMounted, computed } from 'vue'
import api from '../api'
import Icon from '../components/Icon.vue'
import {
  useSettingsStore,
  ACCENT_PRESETS,
  THEME_COLORS,
  THEME_NAME_MAX,
  defaultThemeColors,
  themeColorValue
} from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useAuthStore } from '../stores/auth'
import { useLearnStore } from '../stores/learn'
import { QN_LABEL, QN_ORDER } from '../utils/quality'

const settings = useSettingsStore()
const ui = useUiStore()
const auth = useAuthStore()
const learn = useLearnStore()

const busy = ref(false)

const ACCENTS = Object.keys(ACCENT_PRESETS).map((k) => ({ key: k, ...ACCENT_PRESETS[k] }))

const qualityOptions = computed(() =>
  QN_ORDER.filter((q) => QN_LABEL[q]).map((q) => ({ qn: q, label: QN_LABEL[q] }))
)

function swatchColor(a) {
  return settings.settings.theme === 'light' ? a.light : a.dark
}

function setTheme(t) {
  settings.patch({ theme: t })
}

/* ---------- 自定义主题 ---------- */
const setName = ref('')

/** 界面上每个颜色该显示的值（缺的键回落到当前基底主题） */
function themeValue(key) {
  return themeColorValue(settings.settings.themeCustom, key, settings.settings.theme)
}

function toggleCustomTheme() {
  if (settings.settings.themeOn) settings.resetCustomTheme()
  else settings.enableCustomTheme()
}

/** 取色器拖动时只预览（不落盘，避免每移动一格就写一次设置） */
function onColorInput(key, e) {
  settings.previewThemeColor(key, e.target.value)
}

function onColorChange(key, e) {
  const v = String(e.target.value || '').trim()
  settings.setThemeColor(key, v).then((ok) => {
    if (!ok) ui.err('颜色要写成 6 位十六进制，如 #7fd68a')
  })
}

/** 把这 7 个色恢复成当前深色/浅色底色的默认值 */
function resetColors() {
  settings.patch({ themeOn: true, themeCustom: defaultThemeColors(settings.settings.theme) })
}

async function saveSet() {
  const ok = await settings.saveThemeSet(setName.value)
  if (ok) {
    ui.ok('已保存主题套装')
    setName.value = ''
  } else {
    ui.err(`给这套主题起个名字（最多 ${THEME_NAME_MAX} 个字）`)
  }
}

async function delSet(s) {
  const yes = await ui.confirm(`删除主题套装「${s.name}」？`, '当前颜色不会被改掉，只是删掉这套存档。')
  if (!yes) return
  await settings.removeThemeSet(s.id)
  ui.ok('已删除')
}

async function pickBackupDir() {
  try {
    const dir = await api.sys.pickFile()
    if (!dir) return
    settings.patch({ backupPath: dir })
    ui.ok('备份目录已设置')
  } catch (err) {
    ui.err(err.message)
  }
}

async function writeBackup() {
  if (!settings.settings.backupPath) {
    ui.err('请先选择备份目录')
    return
  }
  busy.value = true
  try {
    const { db } = await import('../db')
    const [progress, daily, notes, shelf] = await Promise.all([
      db.progress.toArray(),
      db.daily.toArray(),
      db.notes.toArray(),
      db.shelf.toArray()
    ])
    const payload = {
      app: 'study-bili',
      version: '0.1.0',
      exportedAt: new Date().toISOString(),
      user: auth.loggedIn ? { mid: auth.user.mid, uname: auth.user.uname } : null,
      progress,
      daily,
      notes,
      shelf
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const file = await api.backup.write(
      settings.settings.backupPath,
      `bililite-learn-${stamp}.json`,
      JSON.stringify(payload, null, 2)
    )
    ui.ok('已写入：' + file)
  } catch (err) {
    ui.err(err.message || '备份失败')
  } finally {
    busy.value = false
  }
}

function revealBackup() {
  if (!settings.settings.backupPath) {
    ui.err('还没有选择备份目录')
    return
  }
  api.sys.revealPath(settings.settings.backupPath).catch((e) => ui.err(e.message))
}

function resetAll() {
  ui.confirm('恢复默认设置？', '播放、外观设置会回到初始值，学习数据不受影响。').then((ok) => {
    if (!ok) return
    settings.patch({
      theme: 'dark',
      accent: 'mono',
      defaultQuality: 80,
      autoNext: true,
      seekStep: 5,
      playerVolume: 0.8,
      hideDanmakuArea: true,
      autoMark: true,
      autoCheckin: true
    })
    ui.ok('已恢复默认设置')
  })
}

onMounted(() => {
  settings.init()
  learn.init().catch(() => {})
})
</script>

<template>
  <div>
    <div class="page-head">
      <h1>设置</h1>
      <p>全部设置保存在本机，卸载前建议在「数据」里导出一份。</p>
    </div>

    <!-- 外观 -->
    <section class="panel" style="margin-bottom: 16px">
      <h2 class="sec">外观</h2>
      <div class="field">
        <label>主题</label>
        <div class="row" style="gap: 8px">
          <button class="chip" :class="{ on: settings.settings.theme === 'dark' }" @click="setTheme('dark')">
            <Icon name="monitor" :size="13" /> 深色
          </button>
          <button class="chip" :class="{ on: settings.settings.theme === 'light' }" @click="setTheme('light')">
            <Icon name="zap" :size="13" /> 浅色
          </button>
        </div>
      </div>
      <div class="field">
        <label>强调色</label>
        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <button
            v-for="a in ACCENTS"
            :key="a.key"
            class="swatch"
            :class="{ on: settings.settings.accent === a.key }"
            :style="{ background: swatchColor(a) }"
            :title="a.label"
            @click="settings.patch({ accent: a.key })"
          />
          <input
            class="input mono"
            style="width: 120px"
            :value="settings.settings.accent"
            @change="settings.patch({ accent: $event.target.value.trim() })"
          />
        </div>
        <p class="hint">可以点色板，也可以直接填 6 位十六进制色值（如 #7fd68a）。</p>
      </div>
    </section>

    <!-- 自定义主题 -->
    <section class="panel" style="margin-bottom: 16px">
      <h2 class="sec">自定义主题</h2>
      <div class="field">
        <label>开关</label>
        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <button class="chip" :class="{ on: settings.settings.themeOn }" @click="toggleCustomTheme()">
            <Icon name="palette" :size="13" />
            {{ settings.settings.themeOn ? '已启用（点此关掉）' : '启用自定义主题' }}
          </button>
          <button v-if="settings.settings.themeOn" class="chip plain" @click="resetColors()">
            <Icon name="refresh" :size="13" /> 恢复这套底色
          </button>
        </div>
        <p class="hint">
          启用后，下面这几个颜色会覆盖内置的深色/浅色配色；悬停底色、三级文字、强边框、骨架屏这些不单独让你填，按你选的色自动推出来，免得配色打架。
        </p>
      </div>

      <div v-if="settings.settings.themeOn" class="field">
        <label>颜色</label>
        <div class="colors">
          <div v-for="c in THEME_COLORS" :key="c.key" class="crow">
            <span class="clabel">{{ c.label }}</span>
            <input
              class="cpick"
              type="color"
              :value="themeValue(c.key)"
              :title="`选择${c.label}`"
              @input="onColorInput(c.key, $event)"
              @change="onColorChange(c.key, $event)"
            />
            <input
              class="input mono ctext"
              :value="themeValue(c.key)"
              @change="onColorChange(c.key, $event)"
            />
          </div>
        </div>
        <p class="hint">点色块打开取色器即时预览，或直接填 6 位十六进制色值（如 #7fd68a）。</p>
      </div>

      <div v-if="settings.settings.themeOn" class="field">
        <label>主题套装</label>
        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <input
            v-model="setName"
            class="input grow"
            :maxlength="THEME_NAME_MAX"
            placeholder="给这套主题起个名字"
            @keyup.enter="saveSet()"
          />
          <button class="btn primary" :disabled="!setName.trim()" @click="saveSet()">保存</button>
        </div>
        <div
          v-if="settings.settings.themeSets.length"
          class="row"
          style="gap: 8px; flex-wrap: wrap; margin-top: 10px"
        >
          <button
            v-for="s in settings.settings.themeSets"
            :key="s.id"
            class="chip"
            :class="{ on: settings.settings.themeSetId === s.id }"
            :title="`套用「${s.name}」`"
            @click="settings.applyThemeSet(s.id)"
          >
            {{ s.name }}
            <i class="chip-x" @click.stop="delSet(s)">✕</i>
          </button>
        </div>
        <p class="hint">
          最多 {{ THEME_NAME_MAX }} 个字，可以存多套随时切换（同名覆盖）。改一套已有的：先点它套用，改完颜色再用同名保存。
        </p>
      </div>
    </section>

    <!-- 播放 -->
    <section class="panel" style="margin-bottom: 16px">
      <h2 class="sec">播放</h2>
      <div class="field">
        <label>默认清晰度</label>
        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <button
            v-for="o in qualityOptions"
            :key="o.qn"
            class="chip"
            :class="{ on: settings.settings.defaultQuality === o.qn }"
            @click="settings.patch({ defaultQuality: o.qn })"
          >
            {{ o.label }}
          </button>
        </div>
        <p class="hint">未登录时 B 站只给到 360P，登录后可用 1080P；4K / HDR 需要大会员。</p>
      </div>

      <div class="field">
        <label>自动连播下一 P</label>
        <button class="chip" :class="{ on: settings.settings.autoNext }" @click="settings.patch({ autoNext: !settings.settings.autoNext })">
          {{ settings.settings.autoNext ? '已开启' : '已关闭' }}
        </button>
      </div>

      <div class="field">
        <label>快进 / 快退步长</label>
        <div class="row" style="gap: 8px">
          <button
            v-for="s in [3, 5, 10, 15]"
            :key="s"
            class="chip"
            :class="{ on: settings.settings.seekStep === s }"
            @click="settings.patch({ seekStep: s })"
          >
            {{ s }} 秒
          </button>
        </div>
      </div>

      <div class="field">
        <label>默认音量（{{ Math.round(settings.settings.playerVolume * 100) }}%）</label>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          style="width: 240px"
          :value="settings.settings.playerVolume"
          @input="settings.patch({ playerVolume: Number($event.target.value) })"
        />
      </div>

      <div class="field">
        <label>自动标记完成</label>
        <button class="chip" :class="{ on: settings.settings.autoMark }" @click="settings.patch({ autoMark: !settings.settings.autoMark })">
          {{ settings.settings.autoMark ? '已开启' : '已关闭' }}
        </button>
        <p class="hint">播放超过 95% 时把该 P 记成「已完成」。</p>
      </div>

      <div class="field">
        <label>自动打卡</label>
        <button class="chip" :class="{ on: settings.settings.autoCheckin }" @click="settings.patch({ autoCheckin: !settings.settings.autoCheckin })">
          {{ settings.settings.autoCheckin ? '已开启' : '已关闭' }}
        </button>
        <p class="hint">开启后观看满 5 分钟自动完成当天打卡；学习页的「连续签到」卡就按这些记录算。</p>
      </div>
    </section>

    <!-- 数据 -->
    <section class="panel" style="margin-bottom: 16px">
      <h2 class="sec">数据</h2>
      <div class="field">
        <label>备份目录</label>
        <div class="row" style="gap: 8px">
          <input class="input mono grow" :value="settings.settings.backupPath || '（未设置）'" readonly />
          <button class="btn" @click="pickBackupDir"><Icon name="folder" :size="14" /> 选择</button>
          <button class="btn ghost" :disabled="!settings.settings.backupPath" @click="revealBackup">
            <Icon name="external" :size="14" /> 打开
          </button>
        </div>
      </div>
      <div class="field">
        <label>导出学习数据</label>
        <div class="row" style="gap: 8px">
          <button class="btn primary" :disabled="busy" @click="writeBackup">
            <span v-if="busy" class="spinner" /><Icon v-else name="down" :size="14" /> 写入 JSON 备份
          </button>
          <span class="hint">内容：进度 {{ learn.totalVideos }} 条 · 清单 {{ learn.shelf.length }} 条 · 累计 {{ (learn.totalSeconds / 3600).toFixed(2) }} h</span>
        </div>
      </div>
      <div class="field">
        <label>恢复默认</label>
        <button class="btn ghost" @click="resetAll"><Icon name="refresh" :size="14" /> 重置设置</button>
      </div>
    </section>

    <!-- 关于 -->
    <section class="panel">
      <h2 class="sec">关于</h2>
      <p class="hint" style="line-height: 1.8">
        BiliLite v0.1.0 · Electron + Vue 3 · 本地优先。<br />
        界面与交互参考开源项目
        <a href="#" @click.prevent="api.sys.openExternal('https://github.com/ywmoyue/biliuwp-lite').catch(() => {})">biliuwp-lite / BiliLite</a>
        的「学习专注」思路重新实现。<br />
        本软件仅用于个人学习用途，不提供任何下载、破解或绕过大会员能力；所有视频、音频均直接来自 B 站官方接口，版权归原作者所有。<br />
        登录凭证（Cookie）用系统 DPAPI 加密后保存在本机，不会上传到任何第三方服务器。
      </p>
    </section>
  </div>
</template>

<style scoped>
.sec {
  font-size: 13px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--t2);
  margin-bottom: 14px;
}
.swatch {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2px solid var(--line-strong);
  cursor: pointer;
  padding: 0;
}
.swatch.on {
  box-shadow: 0 0 0 3px var(--soft-hover);
  border-color: var(--t1);
}
.hint {
  font-size: 12px;
  color: var(--t3);
  margin-top: 6px;
}
/* 自定义主题：一色一行（标签 / 取色器 / 十六进制输入） */
.colors {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(216px, 1fr));
  gap: 8px 14px;
}
.crow {
  display: flex;
  align-items: center;
  gap: 8px;
}
.clabel {
  flex: none;
  width: 62px;
  font-size: 12.5px;
  color: var(--t2);
}
.cpick {
  flex: none;
  width: 30px;
  height: 26px;
  padding: 0;
  border: 2px solid var(--line-strong);
  border-radius: 6px;
  background: none;
  cursor: pointer;
}
.cpick::-webkit-color-swatch-wrapper {
  padding: 2px;
}
.cpick::-webkit-color-swatch {
  border: none;
  border-radius: 3px;
}
.ctext {
  width: 96px;
}
</style>
