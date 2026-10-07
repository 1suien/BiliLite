<script setup>
import { ref, onMounted, computed } from 'vue'
import api from '../api'
import Icon from '../components/Icon.vue'
import { useSettingsStore, ACCENT_PRESETS } from '../stores/settings'
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
</style>
