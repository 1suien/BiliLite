<script setup lang="ts">
/**
 * 设置页：外观 / 播放 / 数据 / 关于
 * 还原自 SettingsView-oeXwRCVu.js（scope data-v-77fffa58）
 */
import { computed, onMounted, ref } from 'vue'
import Icon from '@/components/Icon.vue'
import { bili } from '@/bridge'
import { db } from '@/db'
import { ACCENTS, useSettingsStore } from '@/stores/settings'
import { useAuthStore } from '@/stores/auth'
import { useLearnStore } from '@/stores/learn'
import { useUiStore } from '@/stores/ui'

/**
 * 清晰度映射（还原自 quality-gN7BsY4u.js）。
 * 播放器另有一份同样的表，本页只用它画「默认清晰度」按钮，故就近定义。
 */
const QUALITY_LABELS: Record<number, string> = {
  6: '240P',
  16: '360P',
  32: '480P',
  64: '720P',
  74: '720P60',
  80: '1080P',
  100: '智能修复',
  112: '1080P+',
  116: '1080P60',
  120: '4K',
  125: 'HDR',
  126: '杜比视界',
  127: '8K',
}
/** 从高到低的展示顺序 */
const QUALITY_ORDER = [127, 126, 125, 120, 116, 112, 100, 80, 74, 64, 32, 16, 6]

const settings = useSettingsStore()
const ui = useUiStore()
const auth = useAuthStore()
const learn = useLearnStore()

/** 设置对象（原实现里是 n.settings） */
const conf = computed(() => settings.settings)

/** 正在写备份 */
const busy = ref(false)
/** 桥上报的版本号 */
const version = ref('')

/** 强调色预设列表：{ key, label, dark, light } */
const accentList = Object.keys(ACCENTS).map((key) => ({ key, ...ACCENTS[key] }))

/** 可选清晰度（只保留有中文名的） */
const qualityList = computed(() =>
  QUALITY_ORDER.filter((qn) => QUALITY_LABELS[qn]).map((qn) => ({ qn, label: QUALITY_LABELS[qn] })),
)

/** 取该强调色在当前主题下的色值 */
function accentColorOf(item: { dark: string; light: string }) {
  return conf.value.theme === 'light' ? item.light : item.dark
}

/** 色块上的勾/文字该用黑还是白（亮度阈值 0.6） */
function fgOn(color: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(color)
  if (!m) return '#ffffff'
  const v = parseInt(m[1], 16)
  const luma =
    (0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255
  return luma > 0.6 ? '#0a0a0b' : '#ffffff'
}

/** 当前强调色（自定义 hex 或预设色） */
const accentValue = computed(() => {
  const raw = String(conf.value.accent || 'mono')
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase()
  const item = ACCENTS[raw] || ACCENTS.mono
  return conf.value.theme === 'light' ? item.light : item.dark
})

/** 当前强调色是不是自定义 hex */
const isCustomAccent = computed(() => /^#[0-9a-f]{6}$/i.test(String(conf.value.accent || '')))

/** 手填色值：不合法就还原输入框并提示 */
function onAccentInput(e: Event) {
  const el = e.target as HTMLInputElement
  const val = String(el.value || '').trim()
  if (!/^#[0-9a-f]{6}$/i.test(val)) {
    el.value = accentValue.value
    ui.err('请填 6 位十六进制色值，例如 #7fd68a')
    return
  }
  settings.patch({ accent: val.toLowerCase() })
}

function setTheme(theme: 'dark' | 'light') {
  settings.patch({ theme })
}

/** 音量滑杆（0~1） */
function onVolumeInput(e: Event) {
  settings.patch({ playerVolume: Number((e.target as HTMLInputElement).value) })
}

/** 选备份目录 */
async function pickBackupDir() {
  try {
    const dir = await bili.sys.pickFile()
    if (!dir) return
    settings.patch({ backupPath: dir })
    ui.ok('备份目录已设置')
  } catch (e: any) {
    ui.err(e.message)
  }
}

/** 导出 JSON 备份：进度 / 每日时长 / 笔记 / 清单 */
async function exportBackup() {
  if (!conf.value.backupPath) {
    ui.err('请先选择备份目录')
    return
  }
  busy.value = true
  try {
    const [progress, daily, notes, shelf] = await Promise.all([
      db.progress.toArray(),
      db.daily.toArray(),
      db.notes.toArray(),
      db.shelf.toArray(),
    ])
    const payload = {
      app: 'study-bili',
      version: '0.1.0',
      exportedAt: new Date().toISOString(),
      user: auth.loggedIn ? { mid: auth.user.mid, uname: auth.user.uname } : null,
      progress,
      daily,
      notes,
      shelf,
    }
    // 文件名里的时间：2026-10-25T12-00-00
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const path = await bili.backup.write(
      conf.value.backupPath,
      `bililite-learn-${stamp}.json`,
      JSON.stringify(payload, null, 2),
    )
    ui.ok('已写入：' + path)
  } catch (e: any) {
    ui.err(e.message || '备份失败')
  } finally {
    busy.value = false
  }
}

/** 在文件管理器里打开备份目录 */
function openBackupDir() {
  if (!conf.value.backupPath) {
    ui.err('还没有选择备份目录')
    return
  }
  bili.sys.revealPath(conf.value.backupPath).catch((e: any) => ui.err(e.message))
}

/** 是否安卓：安卓没有真正的目录选择，导出位置由系统「保存到」面板决定 */
const isAndroid = computed(() => bili.platform === 'android')

/** 导入备份用的隐藏 file input 与进度标记 */
const importEl = ref<HTMLInputElement | null>(null)
const importing = ref(false)

function pickImportFile() {
  importEl.value?.click()
}

/**
 * 把备份数据合并进本地库。
 * 合并规则：进度同 key 取 updatedAt 较新、每日时长同一天取较大值、清单同 bvid 取较新、笔记按 bvid+cid+at+text 去重补齐。
 */
async function mergeBackup(payload: any) {
  const added = { progress: 0, daily: 0, notes: 0, shelf: 0 }

  if (Array.isArray(payload.progress)) {
    for (const row of payload.progress) {
      if (!row || !row.key || !row.bvid) continue
      const key = String(row.key)
      const old = await db.progress.get(key)
      if (!old || (Number(row.updatedAt) || 0) > (Number(old.updatedAt) || 0)) {
        await db.progress.put({ ...row, key })
        added.progress++
      }
    }
  }

  if (Array.isArray(payload.daily)) {
    for (const row of payload.daily) {
      if (!row || !row.date) continue
      const date = String(row.date)
      const old = await db.daily.get(date)
      const next = {
        date,
        seconds: Math.max(Number(old?.seconds) || 0, Number(row.seconds) || 0),
        videos: Math.max(Number(old?.videos) || 0, Number(row.videos) || 0),
      }
      if (!old || next.seconds !== old.seconds || next.videos !== old.videos) {
        await db.daily.put(next)
        added.daily++
      }
    }
  }

  if (Array.isArray(payload.shelf)) {
    for (const row of payload.shelf) {
      if (!row || !row.bvid) continue
      const bvid = String(row.bvid)
      const old = await db.shelf.get(bvid)
      if (!old || (Number(row.at) || 0) >= (Number(old.at) || 0)) {
        await db.shelf.put({ ...row, bvid })
        added.shelf++
      }
    }
  }

  if (Array.isArray(payload.notes)) {
    const exist = await db.notes.toArray()
    const seen = new Set(
      exist.map(
        (n) => `${n.bvid}|${Number(n.cid) || 0}|${Number(n.at) || 0}|${String(n.text || '')}`,
      ),
    )
    for (const row of payload.notes) {
      if (!row || !row.bvid) continue
      const bvid = String(row.bvid)
      const cid = Number(row.cid) || 0
      const at = Number(row.at) || Date.now()
      const stamp = `${bvid}|${cid}|${at}|${String(row.text || '')}`
      if (seen.has(stamp)) continue
      await db.notes.add({ ...row, bvid, cid, at })
      seen.add(stamp)
      added.notes++
    }
  }

  return added
}

/** 选一份导出的 JSON 备份 → 确认 → 合并恢复 */
async function onImportFile(e: Event) {
  const el = e.target as HTMLInputElement
  const file = el.files && el.files[0]
  el.value = ''
  if (!file) return
  if (!/\.json$/i.test(file.name)) return ui.err('请选择 .json 备份文件')
  if (file.size > 32 * 1024 * 1024) return ui.err('备份文件太大（上限 32MB）')

  let payload: any
  try {
    payload = JSON.parse(await file.text())
  } catch {
    return ui.err('备份文件不是合法 JSON')
  }
  if (!payload || payload.app !== 'study-bili') {
    return ui.err('这不是 BiliLite 的学习数据备份（缺少 app 标记）')
  }
  const p = Array.isArray(payload.progress) ? payload.progress.length : 0
  const d = Array.isArray(payload.daily) ? payload.daily.length : 0
  const n = Array.isArray(payload.notes) ? payload.notes.length : 0
  const s = Array.isArray(payload.shelf) ? payload.shelf.length : 0
  if (!p && !d && !n && !s) return ui.err('备份文件里没有可恢复的数据')

  const yes = await ui.confirm(
    '打开这份备份？',
    `${file.name}\n进度 ${p} 条 · 每日时长 ${d} 条 · 笔记 ${n} 条 · 清单 ${s} 条。\n与现有数据合并：同一条取较新/较大值，不会删除现有记录。`,
  )
  if (!yes) return

  importing.value = true
  try {
    const added = await mergeBackup(payload)
    // force=true：学习页 store 可能已缓存旧数据，这里必须重读
    await learn.init(true).catch(() => {})
    ui.ok(
      `已恢复：进度 +${added.progress} · 每日时长 +${added.daily} · 笔记 +${added.notes} · 清单 +${added.shelf}`,
    )
  } catch (err: any) {
    ui.err(err.message || '恢复失败')
  } finally {
    importing.value = false
  }
}

/** 恢复默认设置（只重置播放/外观，不动学习数据） */
function resetSettings() {
  ui.confirm('恢复默认设置？', '播放、外观设置会回到初始值，学习数据不受影响。').then((yes) => {
    if (!yes) return
    settings.patch({
      theme: 'dark',
      accent: 'mono',
      defaultQuality: 80,
      autoNext: true,
      seekStep: 5,
      playerVolume: 0.8,
      hideDanmakuArea: true,
      autoMark: true,
      autoCheckin: true,
    })
    ui.ok('已恢复默认设置')
  })
}

onMounted(() => {
  settings.init()
  learn.init().catch(() => {})
  // 版本号来自数据桥
  bili
    .ping()
    .then((res) => {
      if (res && res.version) version.value = String(res.version)
    })
    .catch(() => {})
})
</script>

<template>
  <div>
    <div class="page-head">
      <h1>设置</h1>
      <p>全部设置保存在本机，卸载前建议在「数据」里导出一份。</p>
    </div>

    <section class="panel" style="margin-bottom: 16px">
      <h2 class="sec">外观</h2>
      <div class="field">
        <label>主题</label>
        <div class="row" style="gap: 8px">
          <button class="chip" :class="{ on: conf.theme === 'dark' }" @click="setTheme('dark')">
            <Icon name="moon" :size="13" /> 深色
          </button>
          <button class="chip" :class="{ on: conf.theme === 'light' }" @click="setTheme('light')">
            <Icon name="sun" :size="13" /> 浅色
          </button>
        </div>
      </div>
      <div class="field">
        <label>强调色</label>
        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <button
            v-for="a in accentList"
            :key="a.key"
            class="swatch"
            :class="{ on: conf.accent === a.key }"
            :style="{ background: accentColorOf(a), color: fgOn(accentColorOf(a)) }"
            :title="a.label + ' · ' + accentColorOf(a)"
            :aria-label="a.label"
            @click="settings.patch({ accent: a.key })"
          >
            <Icon v-if="conf.accent === a.key" name="check" :size="15" />
          </button>
          <input
            class="input mono accent-hex"
            :class="{ custom: isCustomAccent }"
            :value="accentValue"
            :title="isCustomAccent ? '自定义色值' : '当前预设：' + conf.accent"
            placeholder="#rrggbb"
            aria-label="自定义强调色"
            @change="onAccentInput"
          />
        </div>
        <p class="hint">
          点色板换预设；也可以直接填 6 位十六进制色值（如 #7fd68a）改成自定义色。
        </p>
      </div>
    </section>

    <section class="panel" style="margin-bottom: 16px">
      <h2 class="sec">播放</h2>
      <div class="field">
        <label>默认清晰度</label>
        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <button
            v-for="q in qualityList"
            :key="q.qn"
            class="chip"
            :class="{ on: conf.defaultQuality === q.qn }"
            @click="settings.patch({ defaultQuality: q.qn })"
          >
            {{ q.label }}
          </button>
        </div>
        <p class="hint">未登录时 B 站只给到 360P，登录后可用 1080P；4K / HDR 需要大会员。</p>
      </div>
      <div class="field">
        <label>自动连播下一 P</label>
        <button class="chip" :class="{ on: conf.autoNext }" @click="settings.patch({ autoNext: !conf.autoNext })">
          {{ conf.autoNext ? '已开启' : '已关闭' }}
        </button>
      </div>
      <div class="field">
        <label>快进 / 快退步长</label>
        <div class="row" style="gap: 8px">
          <button
            v-for="step in [3, 5, 10, 15]"
            :key="step"
            class="chip"
            :class="{ on: conf.seekStep === step }"
            @click="settings.patch({ seekStep: step })"
          >
            {{ step }} 秒
          </button>
        </div>
      </div>
      <div class="field">
        <label>默认音量（{{ Math.round(conf.playerVolume * 100) }}%）</label>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          style="width: 240px"
          :value="conf.playerVolume"
          @input="onVolumeInput"
        />
      </div>
      <div class="field">
        <label>自动标记完成</label>
        <button class="chip" :class="{ on: conf.autoMark }" @click="settings.patch({ autoMark: !conf.autoMark })">
          {{ conf.autoMark ? '已开启' : '已关闭' }}
        </button>
        <p class="hint">播放超过 95% 时把该 P 记成「已完成」。</p>
      </div>
      <div class="field">
        <label>自动打卡</label>
        <button
          class="chip"
          :class="{ on: conf.autoCheckin }"
          @click="settings.patch({ autoCheckin: !conf.autoCheckin })"
        >
          {{ conf.autoCheckin ? '已开启' : '已关闭' }}
        </button>
        <p class="hint">
          开启后观看满 5 分钟自动完成当天打卡；学习页的「连续签到」卡就按这些记录算。
        </p>
      </div>
    </section>

    <section class="panel" style="margin-bottom: 16px">
      <h2 class="sec">数据</h2>
      <div v-if="!isAndroid" class="field">
        <label>备份目录</label>
        <div class="row" style="gap: 8px">
          <input class="input mono grow" :value="conf.backupPath || '（未设置）'" readonly />
          <button class="btn" @click="pickBackupDir">
            <Icon name="folder" :size="14" /> 选择
          </button>
          <button class="btn ghost" :disabled="!conf.backupPath" @click="openBackupDir">
            <Icon name="external" :size="14" /> 打开
          </button>
        </div>
      </div>
      <div v-else class="field">
        <label>备份位置</label>
        <p class="hint">
          安卓上不用先选目录：点「写入 JSON 备份」后由系统「保存到」面板决定存哪（文档 / 网盘 / 微信都行）。
        </p>
      </div>
      <div class="field">
        <label>导出学习数据</label>
        <div class="row" style="gap: 8px">
          <button class="btn primary" :disabled="busy" @click="exportBackup">
            <span v-if="busy" class="spinner" />
            <Icon v-else name="down" :size="14" /> 写入 JSON 备份
          </button>
          <span class="hint">
            内容：进度 {{ learn.totalVideos }} 条 · 清单 {{ learn.shelf.length }} 条 · 累计
            {{ (learn.totalSeconds / 3600).toFixed(2) }} h
          </span>
        </div>
      </div>
      <div class="field">
        <label>恢复学习数据</label>
        <div class="row" style="gap: 8px">
          <button class="btn" :disabled="importing" @click="pickImportFile">
            <span v-if="importing" class="spinner" />
            <Icon v-else name="folder" :size="14" /> 打开 JSON 备份…
          </button>
          <span class="hint">选一份导出的 .json，与现有数据合并恢复（进度 / 笔记 / 清单都在）。</span>
        </div>
        <input
          ref="importEl"
          type="file"
          accept=".json,application/json"
          style="display: none"
          @change="onImportFile"
        />
      </div>
      <div class="field">
        <label>恢复默认</label>
        <button class="btn ghost" @click="resetSettings">
          <Icon name="refresh" :size="14" /> 重置设置
        </button>
      </div>
    </section>

    <section class="panel">
      <h2 class="sec">关于</h2>
      <p class="about-line">
        <b>BiliLite</b>
        <span class="ver mono">v{{ version || '—' }}</span>
        <span class="muted">· Electron + Vue 3 · 本地优先</span>
      </p>
      <p class="hint" style="line-height: 1.8">
        界面与交互参考开源项目
        <a href="#" @click.prevent="bili.sys.openExternal('https://github.com/ywmoyue/biliuwp-lite').catch(() => {})">biliuwp-lite / BiliLite</a>
        的「学习专注」思路重新实现。<br />
        本软件仅用于个人学习用途，不提供任何下载、破解或绕过大会员能力；所有视频、音频均直接来自 B
        站官方接口，版权归原作者所有。<br />
        登录凭证（Cookie）用系统 DPAPI 加密后保存在本机，不会上传到任何第三方服务器。
      </p>
    </section>
  </div>
</template>

<style scoped>
.sec {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  letter-spacing: 0.04em;
  color: var(--t2);
  margin-bottom: 14px;
}
.sec:before {
  content: "";
  width: 3px;
  height: 13px;
  border-radius: 2px;
  background: var(--brand);
}
.swatch {
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 2px solid var(--line-strong);
  cursor: pointer;
  padding: 0;
  transition:
    transform 0.1s,
    box-shadow 0.13s,
    border-color 0.13s;
}
.swatch:hover {
  transform: scale(1.06);
}
.swatch.on {
  border-color: transparent;
  box-shadow:
    0 0 0 2px var(--card),
    0 0 0 4px var(--brand);
}
.accent-hex {
  width: 118px;
  font-size: 12px;
}
.accent-hex.custom {
  border-color: var(--brand-line);
  color: var(--brand);
}
.about-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 10px;
  font-size: 15px;
}
.about-line .ver {
  font-size: 12px;
  color: var(--t3);
}
.hint {
  font-size: 12px;
  color: var(--t3);
  margin-top: 6px;
}
</style>
