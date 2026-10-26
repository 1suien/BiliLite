<script setup lang="ts">
/**
 * 播放页
 * 还原自 VideoView-B4FS9Q24.js（页面本体 + 同 chunk 内的 PartList/CollectModal 子组件）
 *
 * 路由：/video/:bvid?p=&t=
 *   p = 分P 序号（从 1 开始）
 *   t = 起播秒数（小窗/进度回跳时带上）
 *
 * 页面职责：
 *  - 拉视频详情/分P，选初始分P（优先级：query.p > query.cid > 本地学习进度）
 *  - 拉 playurl 并装进 DASH 内核；清晰度、倍速、音量、静音、全屏、键盘快捷键
 *  - 进度条（点击/拖动 seek）、已缓冲进度、学习进度定时落库（learn.addSeconds/save）
 *  - 字幕：在线字幕（bili.video.subtitle）+ 本地字幕文件（srt/vtt/ass，存 db.subs）
 *  - 学习清单、本机收藏（CollectModal）、加入 UP 管理、小窗播放
 *  - 相关推荐、笔记（db.notes）、播放结束自动下一 P
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import EmptyBlock from '@/components/EmptyBlock.vue'
import BiliImage from '@/components/BiliImage.vue'
import Icon from '@/components/Icon.vue'
import PartList from '@/components/PartList.vue'
import CollectModal from '@/components/CollectModal.vue'
import { bili } from '@/bridge'
import { createDashPlayer, type DashPlayer } from '@/player/dash'
import { qualityName, sortQualities } from '@/player/quality'
import { formatClock, formatCount, formatDateTime, parseSec } from '@/utils/format'
import { db, listLocalSubs, putLocalSub, removeLocalSub } from '@/db'
import { useLearnStore } from '@/stores/learn'
import { useCollectStore } from '@/stores/collect'
import { useUpsStore, UNGROUPED } from '@/stores/ups'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { useAuthStore } from '@/stores/auth'
import { useMiniStore } from '@/stores/mini'
import type { SubtitleCue, SubtitleTrack, VideoDetail, VideoPage } from '@/types'

const route = useRoute()
const router = useRouter()

const learn = useLearnStore()
const collect = useCollectStore()
const ups = useUpsStore()
const settings = useSettingsStore()
const ui = useUiStore()
const auth = useAuthStore()
const mini = useMiniStore()
/**
 * 本页实例打开的视频 bvid（路由参数会随着离开播放页变空，自动缩窗时要用这个稳定的值）
 * 本机定制 0.4.8
 */
let openedBvid = ''
/**
 * 从小窗收回本页时续播的位置（本机定制 0.4.11）。
 * 小窗里就是本页这条视频时，直接把视频收回本页并从离开的位置继续，
 * 而不是停在一个「视频正在小窗播放」的占位画面上。
 */
let resumeOverride = 0

/** 视频正在小窗里播（本页这时只显示占位，不重复拉流） */
const miniHere = computed(() => mini.open && mini.bvid === bvid.value)
const bvid = computed(() => String(route.params.bvid || ''))

/* ------------------------------- 播放器 ------------------------------- */

/** <video> 元素 */
const videoEl = ref<HTMLVideoElement | null>(null)
/** 播放器外层（全屏用） */
const wrapEl = ref<HTMLElement | null>(null)
/** DASH 内核实例（非响应式，手动管理生命周期） */
let player: DashPlayer | null = null
/** 学习时长心跳 / 进度落库定时器 */
let secondsTimer: any = null
let saveTimer: any = null
/** 已累计但还没写库的播放秒数 */
let secondsAcc = 0
/** 上次落库时的播放位置（避免重复写） */
let lastSavedAt = -1
/** 上次写库的音量（变化 >0.05 才 patch 设置） */
let lastVolumePatched = 0
/** 本次播放累计的秒数（自动打卡的闸门） */
let watchedSeconds = 0
/** 今天是否已经自动打过卡 */
let checkedIn = false
/** 页面是否处于「加载视频信息」阶段 */
const loading = ref(true)
/** 播放地址/拉流错误文案 */
const errorText = ref('')
/** 播放器状态栏文案（"缓冲中…" 之类） */
const status = ref('')
/** 视频详情 */
const detail = ref<VideoDetail | null>(null)
/** 分 P 列表 */
const pages = ref<VideoPage[]>([])
/** 当前分 P 下标 */
const pageIndex = ref(0)
/** 相关推荐 */
const related = ref<any[]>([])
/** 当前 playurl（原始数据桥形态，清晰度面板要用） */
const playurl = ref<any>(null)

/** 起播/地址耗时统计（安卓端调试行） */
let addrStart = 0
let addrMs = 0
let firstFrameMs = 0

/** 安卓端才显示那行性能信息 */
const isAndroid =
  typeof document !== 'undefined' && document.documentElement.dataset.platform === 'android'
const perfText = ref('')

/** 把已缓冲/首块/首帧等信息拼成一行（只在安卓上显示） */
function updatePerf() {
  if (!isAndroid || !addrStart) return
  const parts: string[] = []
  if (addrMs) parts.push(`地址 ${(addrMs / 1000).toFixed(1)}s`)
  const st = (player as any)?.stat
  if (st && st.tFirst) parts.push(`首块 ${(st.tFirst / 1000).toFixed(1)}s`)
  if (firstFrameMs) parts.push(`首帧 ${(firstFrameMs / 1000).toFixed(1)}s`)
  if (st && st.host) {
    parts.push(
      String(st.host)
        .replace(/^upos-/, '')
        .replace(/\.mcdn\.bilivideo\.cn.*$/, 'mcdn')
        .replace(/\.bilivideo\.(com|cn)$/, ''),
    )
  }
  const bytes = st ? st.vBytes + st.aBytes : 0
  if (bytes) {
    parts.push(`${(bytes / 1048576).toFixed(1)}MB`)
    if (st && st.tFirst) parts.push(`${(bytes / 1048576 / (st.tFirst / 1000)).toFixed(1)}MB/s`)
  }
  perfText.value = parts.join(' · ')
}

/** 时长（秒） */
const duration = ref(0)
/** 当前播放位置（秒） */
const current = ref(0)
/** 已缓冲百分比 */
const bufferedPct = ref(0)
/** 音量 0~1 */
const volume = ref(0.8)
/** 静音 */
const muted = ref(false)
/** 当前 tab：intro | notes | related */
const tab = ref('intro')
/** 笔记输入 */
const noteText = ref('')
/** 笔记列表 */
const notes = ref<any[]>([])
/** 收藏弹窗 */
const collectOpen = ref(false)
/** 倍速候选 */
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2]
/** 当前倍速 */
const rate = ref(1)
/** 倍速菜单 */
const rateMenu = ref(false)
/** 字幕菜单 */
const subMenu = ref(false)
/** 在线字幕轨道 */
const onlineSubs = ref<SubtitleTrack[]>([])
/** 当前在线字幕语言 */
const subLan = ref('')
/** 在线字幕加载中 */
const subLoading = ref(false)
/** 已经按哪个 cid 拉过在线字幕（去重用） */
const subCidLoaded = ref('')
/** 本地字幕（db.subs） */
const localSubs = ref<any[]>([])
/** 当前本地字幕 key */
const localSubKey = ref('')
/** 手动「关闭字幕」 */
const subOff = ref(false)
/** 字幕字号候选 */
const FONT_SIZES = [
  { v: 18, label: '小' },
  { v: 22, label: '中' },
  { v: 26, label: '大' },
  { v: 32, label: '特大' },
]
/** 字幕位置候选（距底部百分比） */
const SUB_BOTTOMS = [
  { v: 8, label: '靠下' },
  { v: 30, label: '居中' },
  { v: 55, label: '靠上' },
]
/** 控制条是否可见 */
const ctlVisible = ref(true)
/** 控制条自动隐藏的定时器 */
let hideTimer: any = null

/** 详情（空对象兜底，模板里直接取字段） */
const video = computed<Partial<VideoDetail>>(() => (detail.value ? detail.value : {}))
/** 当前 cid */
const cid = computed(() => {
  const p = pages.value[pageIndex.value]
  return p ? p.cid : detail.value && detail.value.cid
})
/** 清晰度候选（playurl.accept_quality 排序后） */
const qualityList = computed(() => {
  const data = playurl.value
  if (!data) return []
  const list = data.acceptQuality && data.acceptQuality.length ? data.acceptQuality : [data.quality]
  return sortQualities(list)
})
/** 当前清晰度（以实际选中的轨道为准） */
const currentQuality = computed(() => trackQuality.value || playurlQuality.value)

/** 未登录时 1080P 及以上需要登录才能选 */
function isLocked(qn: number) {
  const cur = currentQuality.value || 0
  return !auth.loggedIn && qn >= 80 && cur > 0 && cur <= 480
}

/** playurl 里声明的清晰度 */
const playurlQuality = ref(0)
/** 内核实际选中的轨道 id */
const trackQuality = ref(0)

/** 错误文案的人话版本（拉流失败之类给个更好懂的标题） */
const errHuman = computed(() => {
  const text = String(errorText.value || '').trim()
  const m = /^([^：:]+)[：:]\s*([\s\S]*)$/.exec(text)
  const head = m ? m[1].trim() : text
  const why = m ? m[2].trim() : ''
  return /拉流失败|Failed to fetch|TypeError|NetworkError/i.test(text)
    ? { human: '这条线路暂时拿不到数据', why: why || text }
    : { human: head, why: '' }
})

/** 出错时的诊断行（安卓上才显示，方便排查 WebView 的编码/网络问题） */
const diagLine = computed(() => {
  if (!isAndroid || !errorText.value) return ''
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || ''
  const os = /Windows NT|Macintosh|X11/.test(ua) ? '桌面' : /Android/.test(ua) ? '安卓' : '其他'
  const chrome = /Chrome\/(\d+)/.exec(ua)
  return `源=${typeof location !== 'undefined' ? location.origin : ''} · UA=${os}${chrome ? `/Chrome${chrome[1]}` : ''}`
})

/** 已播放百分比 */
const playedPct = computed(() => (duration.value ? Math.min(100, (current.value / duration.value) * 100) : 0))
/** 分 P 标签（多 P 时才显示） */
const partLabel = computed(() => {
  const p = pages.value[pageIndex.value]
  const title = p ? p.title || p.part : ''
  return p && pages.value.length > 1 ? `P${p.page} ${title || ''}`.trim() : ''
})
/** 是否在学习清单里 */
const inShelf = computed(() => (bvid.value ? learn.inShelf(bvid.value) : false))
/** 本地收藏了几处 */
const collectCount = computed(() => collect.items.filter((i) => i.bvid === bvid.value).length)
/** 收藏弹窗要的视频信息 */
const collectVideo = computed(() => ({ ...progressData(), upName: upName.value }))
/** UP 是否已在 UP 管理名单里 */
const upFollowed = computed(
  () => !!upMid.value && ups.items.some((u) => String(u.mid) === String(upMid.value)),
)
/** 是否有菜单打开（打开时控制条不自动隐藏） */
const menuOpen = computed(() => rateMenu.value || subMenu.value)

/* ------------------------------- 字幕 ------------------------------- */

/** 当前生效的字幕句表（本地优先，其次在线） */
const cues = computed<SubtitleCue[]>(() => {
  if (subOff.value) return []
  const local = localSubs.value.find((s) => s.key === localSubKey.value)
  if (local && local.items && local.items.length) return local.items
  const online = onlineSubs.value.find((s) => s.lan === subLan.value)
  return online && online.items ? online.items : []
})
/** 有字幕可显示 */
const hasSub = computed(() => !subOff.value && cues.value.length > 0)
/** 当前时间点的那句字幕（二分查找） */
const cueText = computed(() => {
  const list = cues.value
  if (!list.length) return ''
  const t = current.value
  let lo = 0
  let hi = list.length - 1
  let hit: SubtitleCue | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].from <= t) {
      hit = list[mid]
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (!hit) return ''
  const end = hit.to || hit.from + 8
  return t <= end ? hit.content : ''
})
/** 字幕样式（字号/位置/背景来自设置） */
const subStyle = computed(() => {
  const s = settings.settings
  return {
    fontSize: `${Number(s.subFontSize) || 22}px`,
    bottom: `${Number(s.subBottom) >= 0 ? Number(s.subBottom) : 10}%`,
    background: s.subBg ? '' : 'transparent',
    textShadow: s.subBg ? '' : '0 1px 4px rgba(0, 0, 0, 0.95)',
  }
})

/* ---------------------------- 字幕文件解析 ---------------------------- */
/* 这一整段就是原 chunk 里的本地字幕解析（srt / vtt / ass），播放页自带，
   因为渲染层没有别的解析器可用。 */

const SUB_EXTS = ['srt', 'vtt', 'ass', 'ssa']

/** 取扩展名（小写） */
function subExt(name: string) {
  const m = /\.([A-Za-z0-9]+)\s*$/.exec(String(name || ''))
  return m ? m[1].toLowerCase() : ''
}

/** 是不是支持的字幕文件 */
function isSubtitleFile(path: string) {
  return SUB_EXTS.includes(subExt(path))
}

/** 字节 -> 文本（优先 UTF-8，失败退回 GB18030，与原生读文件保持一致） */
function decodeBytes(input: any): string {
  let bytes = input
  if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes)
  if (!bytes || typeof bytes.length !== 'number') return ''
  // 去掉 UTF-8 BOM
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bytes = bytes.subarray(3)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {}
  try {
    return new TextDecoder('gb18030').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** 字幕时间轴 "00:01:02,500" -> 62.5 */
function parseSubTime(input: any): number | null {
  const text = String(input ?? '').trim()
  if (!text) return null
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(text)
  if (!m) return null
  const h = m[1] ? Number(m[1]) : 0
  const min = Number(m[2])
  const sec = Number(m[3])
  const ms = m[4] ? Number(m[4].padEnd(3, '0')) / 1e3 : 0
  return h * 3600 + min * 60 + sec + ms
}

/** 去掉 ASS 的花括号样式、HTML 标签、转义换行等 */
function cleanSubText(input: any): string {
  let text = String(input ?? '')
  text = text.replace(/\{[^}]*\}/g, '')
  text = text.replace(/<\/?[A-Za-z][^>]*>/g, '')
  text = text.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ')
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

/** 压入一条字幕（时间无效/文本为空就丢弃） */
function pushCue(list: SubtitleCue[], from: number | null, to: number | null, text: any) {
  if (from == null || to == null || !(to > from)) return
  const content = cleanSubText(text)
  if (content) list.push({ from, to, content })
}

/** 解析 SRT / WebVTT */
function parseSrtVtt(raw: string): SubtitleCue[] {
  const list: SubtitleCue[] = []
  const blocks = String(raw)
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block.split('\n')
    const first = (lines[0] || '').trim()
    if (/^WEBVTT/i.test(first) || /^NOTE\b/i.test(first) || /^STYLE\b/i.test(first) || /^REGION\b/i.test(first)) {
      continue
    }
    const idx = lines.findIndex((l) => l.includes('-->'))
    if (idx < 0) continue
    const [start, rest] = lines[idx].split('-->')
    const end = (rest || '').trim().split(/\s+/)[0]
    pushCue(list, parseSubTime(start), parseSubTime(end), lines.slice(idx + 1).join('\n'))
  }
  return list
}

/** 解析 ASS / SSA */
function parseAss(raw: string): SubtitleCue[] {
  const list: SubtitleCue[] = []
  const lines = String(raw)
    .replace(/\r\n?/g, '\n')
    .split('\n')
  let inEvents = false
  let fields: string[] | null = null
  for (const line of lines) {
    const text = line.trim()
    if (/^\[/.test(text)) {
      inEvents = /^\[events\]$/i.test(text)
      continue
    }
    if (!inEvents) continue
    const fmt = /^Format\s*:\s*(.+)$/i.exec(text)
    if (fmt) {
      fields = fmt[1].split(',').map((s) => s.trim().toLowerCase())
      continue
    }
    const row = /^Dialogue\s*:\s*(.+)$/i.exec(text)
    if (!row || !fields) continue
    // Dialogue 的 Text 字段里可能含逗号，所以按 Format 的列数切前面的字段
    const cols: string[] = []
    let rest = row[1]
    for (let i = 0; i < fields.length - 1; i++) {
      const at = rest.indexOf(',')
      if (at < 0) break
      cols.push(rest.slice(0, at))
      rest = rest.slice(at + 1)
    }
    cols.push(rest)
    const pick = (name: string) => {
      const i = fields!.indexOf(name)
      return i >= 0 && i < cols.length ? cols[i] : ''
    }
    pushCue(list, parseSubTime(pick('start')), parseSubTime(pick('end')), pick('text'))
  }
  return list
}

/** 按扩展名/内容判断格式并解析 */
function parseSubtitle(raw: string, ext = '') {
  const text = String(raw ?? '').replace(/^\uFEFF/, '')
  const e = String(ext || '').toLowerCase()
  const isAss =
    e === 'ass' ||
    e === 'ssa' ||
    (!e && /\[events\]/i.test(text) && /^\s*dialogue\s*:/im.test(text))
  const items = isAss ? parseAss(text) : parseSrtVtt(text)
  items.sort((a, b) => a.from - b.from || a.to - b.to)
  return { format: isAss ? 'ass' : 'srt', items }
}

/* ------------------------------- 播放设置 ------------------------------- */

/** 把当前倍速应用到元素上 */
function applyRate() {
  if (videoEl.value) videoEl.value.playbackRate = rate.value
}

/** 切倍速（并记住偏好） */
async function setRate(v: number) {
  rate.value = v
  rateMenu.value = false
  applyRate()
  try {
    await settings.patch({ playbackRate: v })
  } catch {}
}

/** 拉在线字幕 */
async function loadOnlineSubs() {
  const id = String(cid.value || '')
  if (!id || subLoading.value) return
  if (subCidLoaded.value === id && onlineSubs.value.length) return
  subLoading.value = true
  subCidLoaded.value = id
  onlineSubs.value = []
  subLan.value = ''
  try {
    const res = await bili.video.subtitle(bvid.value, id)
    onlineSubs.value = (res && res.list) || []
    if (onlineSubs.value.length && !subOff.value && !localSubKey.value) {
      subLan.value = onlineSubs.value[0].lan
    }
  } catch {
    onlineSubs.value = []
  } finally {
    subLoading.value = false
  }
}

/** 打开/关闭字幕菜单（首次打开顺带拉一次在线字幕） */
async function toggleSubMenu() {
  subMenu.value = !subMenu.value
  if (!subMenu.value) return
  await refreshLocalSubs()
  await loadOnlineSubs()
  if (!onlineSubs.value.length && !localSubs.value.length) {
    ui.toast('这个视频没有可用字幕，可以点「选择字幕文件…」加载本地字幕')
  }
}

/** 选在线字幕 */
function pickLan(lan: string) {
  subLan.value = lan
  localSubKey.value = ''
  subOff.value = !lan
  subMenu.value = false
}

/** 选本地字幕 */
function pickLocal(key: string) {
  localSubKey.value = key
  subLan.value = ''
  subOff.value = false
  subMenu.value = false
}

/** 刷新本地字幕列表 */
async function refreshLocalSubs(autoPick = true) {
  if (!bvid.value || !cid.value) return
  try {
    localSubs.value = await listLocalSubs(bvid.value, cid.value)
  } catch {
    localSubs.value = []
  }
  if (!localSubs.value.length) {
    localSubKey.value = ''
    return
  }
  if (!localSubs.value.some((s) => s.key === localSubKey.value)) {
    localSubKey.value = autoPick && !subOff.value ? localSubs.value[0].key : ''
  }
}

/** 读取并导入一份本地字幕文件 */
async function loadSubFile(path: string) {
  try {
    const file = await bili.sys.readSubtitle(path)
    const text = decodeBytes(file.bytes)
    const { format, items } = parseSubtitle(text, subExt(file.name))
    if (!items.length) {
      ui.toast(`${file.name}：没解析出字幕内容（支持 srt / vtt / ass）`)
      return false
    }
    const saved = await putLocalSub({
      bvid: bvid.value,
      cid: cid.value as any,
      name: file.name,
      format,
      items,
    } as any)
    if (!saved) {
      ui.toast('字幕保存失败（这个分P还没准备好？）')
      return false
    }
    await refreshLocalSubs()
    pickLocal((saved as any).key)
    ui.toast(`已加载字幕 ${file.name}（${items.length} 句）`)
    return true
  } catch (e: any) {
    ui.toast((e && e.message) || '读字幕失败')
    return false
  }
}

/** 选择字幕文件（可多选） */
async function pickSubFiles() {
  try {
    const list = await bili.sys.pickSubtitle()
    for (const path of list || []) await loadSubFile(path)
  } catch (e: any) {
    ui.toast((e && e.message) || '选择字幕文件失败')
  }
}

/** 删除一份本地字幕 */
async function removeSub(sub: any) {
  await removeLocalSub(sub.key)
  if (localSubKey.value === sub.key) localSubKey.value = ''
  await refreshLocalSubs()
}

/** 把文件拖进播放器也能加载字幕 */
async function onFilesDropped(e: any) {
  const paths = ((e && e.detail && e.detail.paths) || []).filter((p: string) => isSubtitleFile(p))
  for (const p of paths) await loadSubFile(p)
}

/** 改设置（失败也不打断播放） */
async function patchSettings(patch: any) {
  try {
    await settings.patch(patch)
  } catch {}
}

/* ------------------------------- 控制条 ------------------------------- */

/** 安排控制条自动隐藏 */
function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer)
  if (!settings.settings.autoHideCtl) {
    ctlVisible.value = true
    return
  }
  hideTimer = setTimeout(() => {
    if (playing.value && !menuOpen.value) ctlVisible.value = false
  }, 2800)
}

function onMouseMove() {
  ctlVisible.value = true
  scheduleHide()
}

function onMouseLeave() {
  if (playing.value && !menuOpen.value) ctlVisible.value = false
}

/** 点空白处收起菜单 */
function onGlobalPointerDown(e: any) {
  if (!menuOpen.value) return
  const target = e.target
  if (target && target.closest && target.closest('.ctl-menu-wrap')) return
  rateMenu.value = false
  subMenu.value = false
}

/* ------------------------------- 数据 ------------------------------- */

/** 播放中的状态（控制条按钮/遮罩用） */
const playing = ref(false)

/** 加入 UP 管理名单 */
async function followUp() {
  if (!upMid.value) return
  try {
    await ups.addUp(
      {
        mid: upMid.value,
        name: upName.value,
        face: (video.value.owner && video.value.owner.face) || '',
        sign: '',
      },
      ups.activeGroup && ups.activeGroup !== 'all' ? ups.activeGroup : UNGROUPED,
    )
    ui.ok(`已加入 UP 管理：${upName.value}`)
  } catch (e: any) {
    ui.err(e.message || '加入失败')
  }
}

/** 进入页面时把播放器偏好同步到元素上 */
function resetPlayerPrefs() {
  volume.value = settings.settings.playerVolume
  muted.value = false
  lastVolumePatched = volume.value
  rate.value = Number(settings.settings.playbackRate) || 1
  ctlVisible.value = true
}

/** UP 名（数据桥给的是 owner.name，兼容直接给 upName 的情况） */
const upName = computed(() => {
  const d = video.value
  return (d as any).upName || (d.owner && d.owner.name) || ''
})
/** UP mid */
const upMid = computed(() => {
  const d = video.value as any
  return (d.owner && d.owner.mid) || d.upMid || null
})

/** 载入视频详情 + 分 P */
async function loadAll() {
  const id = bvid.value
  if (!id) return
  destroyPlayer()
  loading.value = true
  errorText.value = ''
  status.value = ''
  detail.value = null
  pages.value = []
  playurl.value = null
  related.value = []
  notes.value = []
  noteText.value = ''
  tab.value = 'intro'
  resetPlayerPrefs()
  try {
    const [info, list] = await Promise.all([
      bili.video.view(id),
      bili.video.pages(id).catch(() => []),
    ])
    detail.value = info
    pages.value = list.length
      ? list
      : [
          {
            cid: info.cid,
            page: 1,
            title: info.title,
            part: info.title,
            duration: info.duration,
          },
        ]
  } catch (e: any) {
    errorText.value = e.message || '视频信息加载失败'
    loading.value = false
    return
  }

  // 初始分P：query.p > query.cid > 本地学习记录
  const qp = Number(route.query.p || 0)
  const qcid = String(route.query.cid || '')
  const byQuery = qp >= 1 && qp <= pages.value.length ? qp - 1 : -1
  const byCid = qcid ? pages.value.findIndex((p) => String(p.cid) === qcid) : -1
  const saved = learn.list.find(
    (p) => p.bvid === id && p.page >= 1 && p.page <= pages.value.length,
  )
  pageIndex.value = byQuery >= 0 ? byQuery : byCid >= 0 ? byCid : saved ? saved.page - 1 : 0
  loading.value = false
  await nextTick()
  // 笔记/相关推荐不依赖拉流：先加载，避免拉流慢或失败时笔记区一直空着
  loadRelated()
  loadNotes()
  await loadPlayurl()
  if (detail.value && detail.value.bvid) learn.save(progressData() as any).catch(() => {})
}

/** 相关推荐 */
async function loadRelated() {
  try {
    related.value = await bili.video.related(bvid.value)
  } catch {
    related.value = []
  }
}

/** 本机笔记：按「视频 + 分P」独立，切分P/切视频都只看到自己那一份 */
async function loadNotes() {
  try {
    const rows = await db.notes.where('bvid').equals(bvid.value).toArray()
    const cur = String(cid.value || '')
    notes.value = rows
      .filter((n: any) => !cur || String(n.cid || '') === cur)
      .sort((a: any, b: any) => (b.at || 0) - (a.at || 0))
  } catch {
    notes.value = []
  }
}

/** 学习进度要写库的字段 */
function progressData() {
  const d = video.value as any
  const page = pages.value[pageIndex.value]
  return {
    // 本机定制 0.4.11：离开播放页时当前路由的 params.bvid 已经变成空串，
    // 这里必须用本页实例打开时的 bvid，否则 flushProgress() 写库会被 learn.save 当成脏数据丢掉，
    // 导致「退出后再次播放」只能退回到上一次 5 秒定时存的旧进度（或从 0 开始）。
    bvid: openedBvid || bvid.value,
    cid: cid.value,
    title: partLabel.value || d.title || '',
    cover: d.cover || '',
    upName: upName.value || '',
    upMid: upMid.value,
    page: page ? page.page : 1,
    duration: duration.value || d.duration || 0,
  }
}

/** 学习时长归属的 UP（addSeconds 用） */
function upInfo() {
  const name = upName.value
  const mid = upMid.value
  return !name && !mid ? null : { mid, name }
}

/** 起播时间点：收回小窗的续播点 > query.t > 本地进度（进度接近末尾或太靠前就从 0 开始） */
function startTime() {
  if (resumeOverride > 0) {
    const at = resumeOverride
    resumeOverride = 0
    return at
  }
  const t = Number(route.query.t || 0)
  if (t > 0) return t
  const saved = learn.get(bvid.value, cid.value)
  if (!saved || !saved.seconds) return 0
  const pageDur = Number((pages.value[pageIndex.value] || {}).duration) || 0
  const total = saved.duration || pageDur || video.value.duration || 0
  if ((total && saved.seconds > total - 12) || saved.seconds < 4) return 0
  return saved.seconds
}

/** 拉播放地址 + 起播 */
async function loadPlayurl() {
  const qn = Number(settings.settings.defaultQuality) || 80
  status.value = '正在获取播放地址…'
  errorText.value = ''
  watchedSeconds = 0
  checkedIn = false
  addrStart = performance.now()
  addrMs = 0
  firstFrameMs = 0
  perfText.value = ''
  // 小窗里正在播同一条视频（本机定制 0.4.11）：把视频收回本页，从离开时的位置继续播，
  // 不再只留一个占位画面——否则「退出播放页后再打开」看起来就像进度丢了。
  if (mini.open && mini.bvid === bvid.value) {
    const at = Number(mini.currentTime) || Number(mini.startTime) || 0
    mini.close()
    if (at > 0.5) resumeOverride = at
    status.value = ''
  }
  ;(window as any).__playLog = { source: 'online', bvid: bvid.value, cid: String(cid.value) }

  let data: any = null
  try {
    data = await bili.video.playurl(bvid.value, cid.value, qn)
    addrMs = performance.now() - addrStart
  } catch (e: any) {
    errorText.value = e.message || '播放地址获取失败'
    status.value = ''
    return
  }

  try {
    playurl.value = data
    playurlQuality.value = data.quality || qn
    trackQuality.value = 0
    // 总时长：分P duration 优先，其次 dash.duration（毫秒），最后详情 duration
    const dashSec = data.dash && data.dash.duration ? data.dash.duration / 1e3 : 0
    const pageDur = Number((pages.value[pageIndex.value] || {}).duration) || 0
    const fallback = parseSec((video.value as any).duration)
    duration.value =
      pageDur > 3 && pageDur < 86400
        ? pageDur
        : dashSec > 3 && dashSec < 86400
          ? dashSec
          : fallback || dashSec || 0
  } catch (e: any) {
    errorText.value = e.message || '播放地址获取失败'
    status.value = ''
    return
  }

  await nextTick()
  if (!videoEl.value) return

  if (!player) {
    player = createDashPlayer(videoEl.value, {
      onStatus: (s) => {
        status.value = s || ''
      },
      onTime: (cur, dur) => {
        current.value = cur
        if (dur) duration.value = dur
        updateBuffered()
        if (isAndroid && addrStart) {
          if (performance.now() - addrStart > 30000) {
            if (perfText.value) perfText.value = ''
          } else {
            updatePerf()
          }
        }
      },
      onDuration: (d) => {
        if (d) duration.value = d
      },
      onState: (s, message) => {
        playing.value = s === 'playing'
        if (s === 'waiting') status.value = '缓冲中…'
        else if (s === 'playing') status.value = ''
        else if (s === 'paused' && message) status.value = message
      },
      onEnded: onEnded,
      onTracks: (t) => {
        trackQuality.value = Number(t && t.video && t.video.id) || 0
      },
      onError: (e) => {
        errorText.value = e.message
        status.value = ''
      },
    })
    player.setDurationHint?.(duration.value)
  }

  const start = startTime()
  if (start > 0) status.value = `从 ${formatClock(start)} 继续播放`
  try {
    await player.load(playurl.value, {
      startTime: start,
      volume: volume.value,
      muted: muted.value,
      autoplay: true,
      durationHint: duration.value,
    })
    startTimers()
    updatePerf()
    applyRate()
    refreshLocalSubs().catch(() => {})
    if (settings.settings.subAuto) loadOnlineSubs().catch(() => {})
  } catch (e: any) {
    errorText.value = e.message || '播放失败'
    status.value = ''
  }
}

/** 销毁播放器并清理状态 */
function destroyPlayer() {
  player && (player.destroy(), (player = null))
  stopTimers()
  playing.value = false
  current.value = 0
  duration.value = 0
  bufferedPct.value = 0
  status.value = ''
  subLan.value = ''
  onlineSubs.value = []
  subCidLoaded.value = ''
  localSubs.value = []
  localSubKey.value = ''
}

/** 缩到小窗播放 */
function toMini() {
  const el = videoEl.value
  const at =
    (el && Number.isFinite(el.currentTime) && el.currentTime > 0 ? el.currentTime : 0) || current.value || 0
  mini.play({
    bvid: bvid.value,
    cid: cid.value,
    page: pageIndex.value + 1,
    title: video.value.title || '',
    upName: upName.value || '',
    cover: video.value.cover || '',
    duration: duration.value || 0,
    qn: trackQuality.value || playurlQuality.value || 0,
    startTime: at,
  })
  destroyPlayer()
  ui.toast('已缩到小窗播放，可以接着翻别的页面')
}

/** 从小窗收回本页播放 */
function fromMini() {
  const at = Math.floor(mini.currentTime || 0)
  const page = Number(mini.page) || pageIndex.value + 1
  mini.close()
  const query: any = {
    ...(page > 1 ? { p: String(page) } : {}),
    ...(at > 3 ? { t: String(at) } : {}),
  }
  router.replace({ name: 'video', params: { bvid: bvid.value }, query })
  nextTick(() => loadPlayurl())
}

/** 页面正在卸载（刷新/关闭窗口）：这种「离开」不该弹小窗 */
let unloadingPage = false
function onPageUnload() {
  unloadingPage = true
}

/**
 * 离开播放页时自动把视频缩成右下角小圆圈并暂停（本机定制 0.4.8）
 *
 * 触发：点左侧导航（学习/习惯/本地/UP 管理/收藏/设置）、任意视频卡、返回等任何页面切换；
 * 不触发：切到另一个视频、换分P（路由还是 video，属于同页重建）、刷新/关闭窗口、视频没加载成功。
 * 点小圆圈回到播放页后会自动从暂停处继续播（见 MiniPlayer 的 backToVideo / fromMini）。
 */
function autoMiniOnLeave() {
  if (unloadingPage) return
  if (mini.open) return
  if (!player || !detail.value || errorText.value) return
  if (router.currentRoute.value.name === 'video') return
  const el = videoEl.value
  const at =
    (el && Number.isFinite(el.currentTime) && el.currentTime > 0 ? el.currentTime : 0) || current.value || 0
  // 路由参数这一刻已经变成目的页，bvid 要用进入本页时记下的值
  const miniBvid = openedBvid || String((detail.value as any)?.bvid || '')
  if (!miniBvid) return
  mini.play({
    bvid: miniBvid,
    cid: cid.value,
    page: pageIndex.value + 1,
    title: video.value.title || '',
    upName: upName.value || '',
    cover: video.value.cover || '',
    duration: duration.value || 0,
    qn: trackQuality.value || playurlQuality.value || 0,
    startTime: at,
    paused: true,
  })
  ui.toast('视频已缩到右下角小圆圈并暂停，点圆圈回来继续看')
}

/** 自动打卡（累计看满 300 秒且设置里开了 autoCheckin） */
function autoCheckin() {
  if (watchedSeconds < 300 || checkedIn || !settings.settings.autoCheckin) return
  if (learn.isChecked()) {
    checkedIn = true
    return
  }
  checkedIn = true
  learn
    .checkin()
    .then((done) => {
      if (done) ui.toast(`已自动打卡 · 连续 ${learn.checkinStreak} 天`)
    })
    .catch(() => {})
}

/** 开始计时：学习时长心跳 + 进度落库 */
function startTimers() {
  stopTimers()
  // 每 1 秒累计一次学习时长，满 10 秒写一次库
  secondsTimer = setInterval(() => {
    const el = videoEl.value
    if (!player || !el) return
    if (!el.paused && !el.ended) {
      secondsAcc += 1
      watchedSeconds += 1
      autoCheckin()
      if (secondsAcc >= 10) {
        const sec = secondsAcc
        secondsAcc = 0
        learn
          .addSeconds(sec, upInfo())
          .catch((e: any) => console.error('[learn] 学习时长写入失败', (e && e.message) || e))
      }
    }
    updateBuffered()
  }, 1000)
  // 每 5 秒把播放位置写进学习进度
  saveTimer = setInterval(() => {
    const el = videoEl.value
    if (!player || !el) return
    const at = el.currentTime || 0
    if (at <= 0 || (lastSavedAt >= 0 && Math.abs(at - lastSavedAt) < 2)) return
    lastSavedAt = at
    const total = duration.value || 0
    learn
      .save({
        ...(progressData() as any),
        seconds: at,
        duration: total,
        completed: total > 0 && at / total > 0.95,
      })
      .then(() => {})
      .catch((e: any) => console.error('[learn] 进度保存失败', (e && e.message) || e))
  }, 5000)
}

/** 停止计时并补写一次学习时长 */
function stopTimers() {
  if (secondsTimer) clearInterval(secondsTimer)
  if (saveTimer) clearInterval(saveTimer)
  secondsTimer = null
  saveTimer = null
  if (secondsAcc > 0) {
    const sec = secondsAcc
    secondsAcc = 0
    learn
      .addSeconds(sec, upInfo())
      .catch((e: any) => console.error('[learn] 学习时长写入失败', (e && e.message) || e))
  }
}

/** 切分P / 离开页面前落一次库 */
function flushProgress() {
  const el = videoEl.value
  if (!player || !el) return
  const at = el.currentTime || 0
  const total = duration.value || 0
  if (at > 0) {
    learn
      .save({
        ...(progressData() as any),
        seconds: at,
        duration: total,
        completed: total > 0 && at / total > 0.95,
      })
      .catch(() => {})
  }
  stopTimers()
}

/** 更新已缓冲百分比 */
function updateBuffered() {
  const el = videoEl.value
  if (!el) return
  try {
    const b = el.buffered
    if (!b.length) return
    const end = b.end(b.length - 1)
    const total = duration.value || 0
    bufferedPct.value = total ? Math.min(100, (end / total) * 100) : 0
  } catch {}
}

/** 播放结束：记完成 + 自动下一 P */
function onEnded() {
  playing.value = false
  const total = duration.value || 0
  learn.save({ ...(progressData() as any), seconds: total, duration: total, completed: true }).catch(() => {})
  if (settings.settings.autoNext && pageIndex.value + 1 < pages.value.length) {
    ui.toast('自动播放下一 P')
    selectPage(pageIndex.value + 1)
  }
}

/* ------------------------------- 播放控制 ------------------------------- */

function togglePlay() {
  if (!player) return
  if (videoEl.value?.paused) player.play()
  else player.pause()
}

/** 前进/后退 n 秒（键盘 ←/→） */
function seekBy(n: number) {
  if (!player) return
  player.seek((videoEl.value?.currentTime || 0) + n)
}

/** 进度条按下：拖动预览 + 松手 seek */
function onSeekPointerDown(e: PointerEvent) {
  if (!duration.value) return
  const el = e.currentTarget as HTMLElement
  const posAt = (ev: PointerEvent) => {
    const rect = el.getBoundingClientRect()
    const pct = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width))
    current.value = pct * duration.value
  }
  const onUp = (ev: PointerEvent) => {
    const rect = el.getBoundingClientRect()
    const pct = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width))
    player && player.seek(pct * duration.value)
    window.removeEventListener('pointermove', posAt)
    window.removeEventListener('pointerup', onUp)
  }
  posAt(e)
  window.addEventListener('pointermove', posAt)
  window.addEventListener('pointerup', onUp)
}

/** 静音开关 */
function toggleMute() {
  muted.value = !muted.value
  player && player.setMuted?.(muted.value)
}

/** 选分P */
async function selectPage(i: number) {
  if (i === pageIndex.value) return
  flushProgress()
  pageIndex.value = i
  lastSavedAt = -1
  router.replace({ name: 'video', params: { bvid: bvid.value }, query: { p: i + 1 } })
  status.value = '切换分P…'
  // 笔记按分P独立：换 P 后清空草稿、重载这一 P 的笔记
  noteText.value = ''
  await Promise.all([loadPlayurl(), loadNotes()])
}

/** 切清晰度（重新拉一次 playurl） */
async function selectQuality(qn: number) {
  if (isLocked(qn)) {
    ui.toast('未登录时选不了这一档，扫码登录后可用')
    ui.askLogin()
    return
  }
  if (qn === playurlQuality.value || !player) return
  const at = videoEl.value?.currentTime || 0
  playurlQuality.value = qn
  status.value = `切换到 ${qualityName(qn)}…`
  try {
    const data = await bili.video.playurl(bvid.value, cid.value, qn)
    playurl.value = data
    await player.load(data, {
      startTime: at,
      volume: volume.value,
      muted: muted.value,
      autoplay: true,
      durationHint: duration.value,
    })
    settings.patch({ defaultQuality: qn })
    ui.ok(`已切换到 ${qualityName(qn)}`)
  } catch (e: any) {
    ui.err(e.message || '清晰度切换失败')
    status.value = ''
  }
}

/** 全屏 / 退出全屏 */
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await wrapEl.value?.requestFullscreen()
  } catch {}
}

/** 音量滑块 */
function onVolumeInput() {
  player && player.setVolume(volume.value)
  if (muted.value && volume.value > 0) {
    muted.value = false
    player && player.setMuted?.(false)
  }
  if (Math.abs(volume.value - lastVolumePatched) > 0.05) {
    lastVolumePatched = volume.value
    settings.patch({ playerVolume: volume.value })
  }
}

/** 加入/移出学习清单 */
async function toggleShelf() {
  if (!video.value.bvid) return
  const added = await learn.shelfToggle({
    bvid: bvid.value,
    title: video.value.title,
    cover: video.value.cover,
    upName: upName.value,
    upMid: upMid.value,
    duration: video.value.duration,
  } as any)
  ui.toast(added ? '已加入学习清单' : '已从学习清单移除')
}

/* ------------------------------- 笔记 ------------------------------- */

/** 保存笔记（记录当前时间点） */
async function saveNote() {
  const text = noteText.value.trim()
  if (!text) return
  const sec = videoEl.value ? Math.floor(videoEl.value.currentTime || 0) : 0
  await db.notes.add({ bvid: bvid.value, cid: cid.value as any, sec, text, at: Date.now() } as any)
  noteText.value = ''
  await loadNotes()
  ui.ok('笔记已保存')
}

async function removeNote(id: number) {
  await db.notes.delete(id)
  await loadNotes()
}

/* ------------------------------- 其它 ------------------------------- */

function openExternal() {
  bili.sys.openExternal(`https://www.bilibili.com/video/${bvid.value}`).catch(() => {})
}

async function copyBvid() {
  const id = bvid.value
  if (!id) return
  try {
    await navigator.clipboard.writeText(id)
    ui.ok(`已复制 BV 号 ${id}`)
  } catch {
    ui.err(`复制失败，BV 号是 ${id}`)
  }
}

/** 键盘快捷键：空格播放/暂停、←→ 快退快进、↑↓ 音量、F 全屏 */
function onKeydown(e: KeyboardEvent) {
  const tag = document.activeElement && document.activeElement.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  if (e.code === 'Space') {
    e.preventDefault()
    togglePlay()
  } else if (e.code === 'ArrowLeft') {
    seekBy(-settings.settings.seekStep)
  } else if (e.code === 'ArrowRight') {
    seekBy(settings.settings.seekStep)
  } else if (e.code === 'ArrowUp') {
    volume.value = Math.min(1, volume.value + 0.05)
    onVolumeInput()
  } else if (e.code === 'ArrowDown') {
    volume.value = Math.max(0, volume.value - 0.05)
    onVolumeInput()
  } else if (e.code === 'KeyF') {
    toggleFullscreen()
  }
}

/* ------------------------------- 生命周期 ------------------------------- */

// 换视频（路由 bvid 变化）重新加载整页
watch(
  () => route.params.bvid,
  () => {
    loadAll()
  },
)

// 开播时记录首帧时间，并开始自动隐藏控制条
watch(playing, (val) => {
  if (val) {
    if (isAndroid && addrStart && !firstFrameMs) {
      firstFrameMs = performance.now() - addrStart
      updatePerf()
    }
    scheduleHide()
  } else {
    ctlVisible.value = true
    if (hideTimer) clearTimeout(hideTimer)
  }
})

// 菜单打开时控制条常驻
watch(menuOpen, (val) => {
  if (val) ctlVisible.value = true
})

onMounted(async () => {
  openedBvid = bvid.value
  await settings.init()
  await learn.init()
  try {
    await collect.init()
    await ups.init()
  } catch (e: any) {
    console.warn('[video] 本机收藏/UP 名单初始化失败：', e && e.message)
  }
  await loadAll()
  startTimers()
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('pointerdown', onGlobalPointerDown, true)
  window.addEventListener('bili:files-dropped', onFilesDropped as any)
  window.addEventListener('beforeunload', onPageUnload)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('pointerdown', onGlobalPointerDown, true)
  window.removeEventListener('bili:files-dropped', onFilesDropped as any)
  window.removeEventListener('beforeunload', onPageUnload)
  if (hideTimer) clearTimeout(hideTimer)
  flushProgress()
  autoMiniOnLeave()
  destroyPlayer()
})
</script>

<template>
  <!-- 加载中 -->
  <div v-if="loading" class="panel row" style="gap: 12px">
    <span class="spinner" />
    <span class="dim">正在加载视频…</span>
  </div>

  <div v-else-if="detail" class="watch">
    <div style="min-width: 0">
      <div ref="wrapEl" class="player-wrap" @mousemove="onMouseMove" @mouseleave="onMouseLeave">
        <div class="player-stage" @dblclick="toggleFullscreen">
          <video ref="videoEl" playsinline preload="auto" @click="togglePlay" />

          <!-- 字幕 -->
          <div v-if="hasSub && cueText" class="cc-line" :style="subStyle">{{ cueText }}</div>

          <!-- 状态遮罩（缓冲/获取地址时） -->
          <div v-if="status && !playing" class="player-msg">
            <span class="spinner" style="margin: 0 auto" />
            <div>{{ status }}</div>
            <div v-if="perfText" class="perf-line">{{ perfText }}</div>
          </div>
          <div v-else-if="perfText" class="perf-line perf-corner">{{ perfText }}</div>

          <!-- 小窗占位 -->
          <div v-if="miniHere" class="player-msg player-msg-col">
            <Icon name="pip" :size="28" />
            <div>视频正在小窗播放</div>
            <button class="btn sm" @click="fromMini">收回本页播放</button>
          </div>

          <!-- 控制条 -->
          <div :class="['stage-ui', { hide: !ctlVisible }]">
            <div class="player-ctl">
              <button class="btn ghost sm" :title="playing ? '暂停' : '播放'" @click="togglePlay">
                <Icon :name="playing ? 'pause' : 'play'" :size="16" />
              </button>
              <button
                class="btn ghost sm"
                title="上一个分P"
                :disabled="pageIndex <= 0"
                @click="selectPage(pageIndex - 1)"
              >
                <Icon name="prev" :size="15" />
              </button>
              <button
                class="btn ghost sm"
                title="下一个分P"
                :disabled="pageIndex + 1 >= pages.length"
                @click="selectPage(pageIndex + 1)"
              >
                <Icon name="next" :size="15" />
              </button>
              <span class="time">{{ formatClock(current) }} / {{ formatClock(duration) }}</span>

              <div class="progress" @pointerdown.prevent="onSeekPointerDown">
                <div class="track">
                  <div class="buf" :style="{ width: bufferedPct + '%' }" />
                  <i :style="{ width: playedPct + '%' }" />
                </div>
              </div>

              <!-- 倍速 -->
              <div class="ctl-menu-wrap">
                <button class="btn ghost sm" title="倍速" @click.stop="rateMenu = !rateMenu">
                  {{ rate }}x
                </button>
                <div v-if="rateMenu" class="ctl-menu">
                  <div
                    v-for="r in RATES"
                    :key="r"
                    :class="['mi', { on: r === rate }]"
                    @click="setRate(r)"
                  >
                    <span>{{ r === 1 ? '1.0x 正常' : r + 'x' }}</span>
                  </div>
                </div>
              </div>

              <!-- 字幕 -->
              <div class="ctl-menu-wrap">
                <button class="btn ghost sm" title="字幕" @click.stop="toggleSubMenu()">
                  <Icon name="cc" :size="15" />
                </button>
                <div v-if="subMenu" class="ctl-menu cc-menu">
                  <div :class="['mi', { on: !hasSub }]" @click="pickLan('')">关闭字幕</div>
                  <div class="mhead">在线字幕</div>
                  <div v-if="subLoading" class="mrow">字幕加载中…</div>
                  <template v-else-if="onlineSubs.length">
                    <div
                      v-for="s in onlineSubs"
                      :key="s.lan"
                      :class="['mi', { on: !subOff && !localSubKey && s.lan === subLan }]"
                      @click="pickLan(s.lan)"
                    >
                      <span>{{ s.lanDoc }}</span>
                      <span class="k">{{ s.items.length }} 句</span>
                    </div>
                  </template>
                  <div v-else class="mrow">这个视频没有可用字幕</div>

                  <div
                    :class="['mi', { on: settings.settings.subAuto }]"
                    @click="patchSettings({ subAuto: !settings.settings.subAuto })"
                  >
                    <span>自动开启在线字幕</span>
                    <span class="k">{{ settings.settings.subAuto ? '已开' : '关' }}</span>
                  </div>

                  <div class="mhead">本地字幕 · 也可以把文件拖进播放器</div>
                  <div
                    v-for="s in localSubs"
                    :key="s.key"
                    :class="['mi', { on: !subOff && s.key === localSubKey }]"
                  >
                    <span class="grow clamp-1" @click="pickLocal(s.key)">{{ s.name }}</span>
                    <span class="k">{{ s.count }} 句</span>
                    <button class="mi-x" title="删除这份字幕" @click.stop="removeSub(s)">✕</button>
                  </div>
                  <div v-if="!localSubs.length" class="mrow">这个分P还没加载本地字幕</div>

                  <div class="mi" @click="pickSubFiles()">
                    <span>选择字幕文件…</span>
                    <span class="k">srt / vtt / ass</span>
                  </div>

                  <div class="mhead">字幕显示</div>
                  <div class="mrow sub-row">
                    <span class="sublab">字号</span>
                    <span class="chip-group">
                      <button
                        v-for="f in FONT_SIZES"
                        :key="f.v"
                        :class="['chip plain', { on: Number(settings.settings.subFontSize) === f.v }]"
                        @click="patchSettings({ subFontSize: f.v })"
                      >
                        {{ f.label }}
                      </button>
                    </span>
                  </div>
                  <div class="mrow sub-row">
                    <span class="sublab">背景</span>
                    <span class="chip-group">
                      <button
                        :class="['chip plain', { on: settings.settings.subBg }]"
                        @click="patchSettings({ subBg: true })"
                      >
                        有
                      </button>
                      <button
                        :class="['chip plain', { on: !settings.settings.subBg }]"
                        @click="patchSettings({ subBg: false })"
                      >
                        无
                      </button>
                    </span>
                  </div>
                  <div class="mrow sub-row">
                    <span class="sublab">位置</span>
                    <span class="chip-group">
                      <button
                        v-for="p in SUB_BOTTOMS"
                        :key="p.v"
                        :class="['chip plain', { on: Number(settings.settings.subBottom) === p.v }]"
                        @click="patchSettings({ subBottom: p.v })"
                      >
                        {{ p.label }}
                      </button>
                    </span>
                  </div>
                </div>
              </div>

              <button class="btn ghost sm" title="静音" @click="toggleMute">
                <Icon :name="muted ? 'mute' : 'volume'" :size="15" />
              </button>
              <input
                v-model.number="volume"
                type="range"
                min="0"
                max="1"
                step="0.02"
                style="width: 74px"
                title="音量"
                @input="onVolumeInput"
              />
              <button class="btn ghost sm" title="全屏" @click="toggleFullscreen">
                <Icon name="expand" :size="15" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 播放出错 -->
      <div v-if="errorText" class="panel err-card" style="margin-top: 12px">
        <div class="err-head">
          <b>{{ errHuman.human }}</b>
          <span v-if="errHuman.why" class="err-why" :title="errorText">{{ errHuman.why }}</span>
        </div>
        <div v-if="diagLine" class="err-why" style="margin-top: 4px">{{ diagLine }}</div>
        <div class="row" style="margin-top: 8px">
          <button class="btn sm primary" @click="loadPlayurl">重新获取播放地址</button>
          <button class="btn sm ghost" @click="openExternal">在浏览器打开</button>
          <button v-if="!auth.loggedIn" class="btn sm" @click="ui.loginOpen = true">扫码登录</button>
        </div>
        <div class="err-tip">
          先点「重新获取播放地址」：多数情况重试一次就会换到可用线路。连续失败就用「在浏览器打开」确认视频本身能不能播。
        </div>
      </div>

      <!-- 标题 + 操作 -->
      <div style="margin-top: 14px; display: flex; gap: 10px; align-items: flex-start">
        <div class="grow" style="min-width: 0">
          <h1 style="font-size: 17px; margin: 0 0 6px; line-height: 1.45">{{ video.title }}</h1>
          <div v-if="partLabel" class="dim" style="font-size: 12.5px">正在播放：{{ partLabel }}</div>
        </div>
        <div class="row" style="flex: none">
          <button class="btn sm" @click="collectOpen = true">
            <Icon :name="collectCount ? 'check' : 'star'" :size="14" />
            {{ collectCount ? `已收藏 ${collectCount > 1 ? collectCount + ' 处' : ''}` : '收藏' }}
          </button>
          <button
            v-if="upMid && !upFollowed"
            class="btn sm"
            title="加入 UP 管理名单，集中管理关注的 UP 主"
            @click="followUp"
          >
            <Icon name="users" :size="14" /> 关注
          </button>
          <button class="btn sm" @click="toggleShelf">
            <Icon :name="inShelf ? 'check' : 'plus'" :size="14" />
            {{ inShelf ? '已加入学习清单' : '加入学习清单' }}
          </button>
          <RouterLink to="/learn" class="btn sm ghost">
            <Icon name="book" :size="14" /> 学习面板
          </RouterLink>
          <!-- 小窗播放入口：圆形图标按钮（本机定制；点一下把视频缩成右下角的小圆圈） -->
          <button
            v-if="miniHere"
            class="btn sm primary mini-entry"
            title="正在小窗播放：点一下收回本页继续看"
            @click="fromMini"
          >
            <Icon name="pip" :size="16" />
          </button>
          <button
            v-else
            class="btn sm mini-entry"
            title="小窗播放：视频缩成右下角的小圆圈，点圆圈回到本页继续看"
            @click="toMini"
          >
            <Icon name="pip" :size="16" />
          </button>
        </div>
      </div>

      <!-- UP / BV / 发布时间 -->
      <div class="row muted" style="flex-wrap: wrap; margin-top: 10px; font-size: 12.5px">
        <span class="chip link" @click="router.push({ name: 'up', params: { mid: String(upMid) } })">
          <Icon name="user" :size="13" /> {{ upName }}
        </span>
        <button
          v-if="bvid"
          class="chip link bv-chip mono"
          title="点击复制 BV 号"
          aria-label="复制 BV 号"
          @click="copyBvid"
        >
          <Icon name="copy" :size="12" /> {{ bvid }}
        </button>
        <span class="chip plain">{{ formatDateTime(video.pubdate || 0) }}</span>
      </div>

      <!-- Tab -->
      <div class="tabs" style="margin-top: 18px">
        <div :class="['tab', { on: tab === 'intro' }]" @click="tab = 'intro'">简介</div>
        <div :class="['tab', { on: tab === 'notes' }]" @click="tab = 'notes'">
          笔记（{{ notes.length }}）
        </div>
        <div :class="['tab', { on: tab === 'related' }]" @click="tab = 'related'">相关推荐</div>
      </div>

      <div
        v-if="tab === 'intro'"
        class="panel"
        style="white-space: pre-wrap; font-size: 13px; color: var(--t2)"
      >
        {{ video.desc || '这个视频没有填写简介。' }}
      </div>

      <div v-else-if="tab === 'notes'" class="panel">
        <div class="row" style="margin-bottom: 10px; align-items: flex-end">
          <textarea
            v-model="noteText"
            class="input note-input"
            rows="2"
            :placeholder="`记录当前分P（${formatClock(current)}）的想法；回车换行，Ctrl+Enter 或点「保存」存到本地`"
            @keydown.ctrl.enter.prevent="saveNote"
            @keydown.meta.enter.prevent="saveNote"
          ></textarea>
          <button class="btn primary" @click="saveNote">
            <Icon name="plus" :size="14" /> 保存
          </button>
        </div>
        <div v-if="!notes.length" class="muted" style="font-size: 12.5px">
          还没有笔记。笔记按分P独立保存：「回车」换行，点「保存」把「时间点 + 想法」存到本地。
        </div>
        <div v-for="n in notes" :key="n.id" class="field note-row">
          <label class="mono" style="width: 62px">{{ formatClock(n.sec) }}</label>
          <div class="ctrl" style="white-space: pre-wrap">{{ n.text }}</div>
          <button class="btn sm danger note-del" title="删除这条笔记" @click="removeNote(n.id)">
            <Icon name="trash" :size="13" />
          </button>
        </div>
      </div>

      <div v-else style="display: flex; flex-direction: column; gap: 4px">
        <template v-if="related.length">
          <div
            v-for="r in related"
            :key="r.bvid"
            class="rowitem"
            @click="router.push({ name: 'video', params: { bvid: r.bvid } })"
          >
            <BiliImage :src="r.cover" :alt="r.title" />
            <div class="info">
              <div class="t clamp-2">{{ r.title }}</div>
              <div class="d">{{ r.upName }} · {{ formatCount(r.play) }} 播放</div>
            </div>
          </div>
        </template>
        <EmptyBlock v-else icon="film" title="暂无相关推荐" />
      </div>
    </div>

    <aside style="display: flex; flex-direction: column; gap: 14px; min-width: 0">
      <!-- 清晰度 -->
      <div class="panel" style="padding: 13px">
        <div class="row" style="margin-bottom: 9px">
          <Icon name="monitor" :size="15" />
          <b style="font-size: 13px">清晰度</b>
          <span class="grow" />
          <span class="muted" style="font-size: 11.5px">当前 {{ qualityName(currentQuality) }}</span>
        </div>
        <div class="row" style="flex-wrap: wrap">
          <span
            v-for="q in qualityList"
            :key="q"
            :class="['chip', { on: q === currentQuality, cur: q === currentQuality, lock: isLocked(q) }]"
            :title="isLocked(q) ? '未登录时选不了这一档，点「扫码登录」解锁' : qualityName(q)"
            @click="selectQuality(q)"
          >
            {{ qualityName(q) }}
          </span>
        </div>
        <div v-if="playurl && playurl.mode === 'durl'" class="muted" style="font-size: 11.5px; margin-top: 8px">
          该视频只提供整段流（durl），清晰度档位受限。
        </div>
      </div>

      <!-- 分 P -->
      <div class="panel" style="padding: 13px">
        <PartList :parts="pages" :index="pageIndex" @select="selectPage" />
      </div>
    </aside>

    <CollectModal :open="collectOpen" :video="collectVideo" @close="collectOpen = false" />
  </div>

  <!-- 打不开 -->
  <EmptyBlock v-else icon="film" title="无法打开这个视频" :desc="errorText">
    <button class="btn" @click="loadAll">重试</button>
    <RouterLink to="/learn" class="btn ghost">回学习</RouterLink>
  </EmptyBlock>
</template>
