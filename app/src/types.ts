/**
 * 全局数据模型
 *
 * 说明：本工程是从 APK 里的生产构建还原而来，原始源码没有类型标注。
 * 这里的数据结构是根据渲染层（页面/组件模板）与桥接层（window.bili 的返回）
 * 的实际用法反推出来的，字段名以原样保留。未完全确认的字段标记为可选或 any。
 */

/** 登录用户（来自 /x/web-interface/nav） */
export interface User {
  mid: number
  uname: string
  face: string
  level: number
  coins: number
  vip: boolean
}

/** 视频卡片（首页推荐 / 热门 / 搜索 / UP 投稿 / 收藏 / 稍后再看等都复用它） */
export interface VideoCard {
  bvid: string
  title: string
  cover: string
  upMid?: number | null
  upName?: string
  duration?: number
  pubdate?: number
  view?: number
  danmaku?: number
  /** 从本地记录带过来的附加信息 */
  reason?: string
  progress?: number
}

/** 视频分 P */
export interface VideoPage {
  cid: number
  page: number
  part: string
  title: string
  duration: number
}

/** 视频详情（/x/web-interface/view） */
export interface VideoDetail {
  aid: number
  bvid: string
  cid: number
  title: string
  desc: string
  cover: string
  pubdate: number
  duration: number
  tname: string
  owner: { mid: number; name: string; face: string }
  stat: {
    view: number
    danmaku: number
    like: number
    coin: number
    favorite: number
    reply: number
  }
  pages: VideoPage[]
}

/** 播放地址（/x/player/wbi/playurl，DASH 形态） */
export interface PlayUrlVideo {
  id: number
  baseUrl: string
  backupUrl?: string[]
  bandwidth?: number
  codecs?: string
  width?: number
  height?: number
  mimeType?: string
  frameRate?: string
}

export interface PlayUrlAudio {
  id: number
  baseUrl: string
  backupUrl?: string[]
  bandwidth?: number
  codecs?: string
  mimeType?: string
}

export interface PlayUrl {
  /** 清晰度 id，对应 quality.ts 里的 qn 表 */
  quality: number
  duration: number
  videos: PlayUrlVideo[]
  audios: PlayUrlAudio[]
  /** 部分场景（旧接口/flv）直接给一个地址 */
  url?: string
  /** 备用（flv/ts 流，交给 mpegts.js 播） */
  dash?: boolean
}

/** 弹幕 */
export interface DanmakuItem {
  time: number
  mode: number
  size: number
  color: number
  text: string
}

/** 字幕 */
export interface SubtitleCue {
  from: number
  to: number
  content: string
}

export interface SubtitleTrack {
  lan: string
  lanDoc: string
  items: SubtitleCue[]
}

/** UP 主 */
export interface UpItem {
  mid: number
  name: string
  face: string
  sign?: string
  fans?: number
  group?: string
  addedAt?: number
}

export interface UpCardInfo {
  mid: number
  name: string
  face: string
  sign?: string
  fans?: number
  archives?: number
}

/** 收藏夹 */
export interface FavFolder {
  id: number
  title: string
  media_count: number
  cover?: string
}

export interface FavResource {
  bvid: string
  title: string
  cover: string
  upName: string
  upMid?: number
  duration: number
  pubdate?: number
}

/** 按 UP 统计的学习时长（Dexie: upTime 表） */
export interface UpTimeRecord {
  key: string
  mid?: number | null
  name: string
  seconds: number
}

/** 本地视频 */
export interface LocalVideo {
  id: string
  path: string
  name: string
  dir: string
  ext: string
  size: number
  mtime?: number
  mime?: string
  url: string
  addedAt?: number
  playedAt?: number
  /** 播放进度（秒） */
  seconds?: number
  duration?: number
}

/** 学习进度（Dexie: progress 表） */
export interface ProgressRecord {
  key: string
  bvid: string
  cid: number
  title: string
  cover: string
  upName: string
  upMid?: number | null
  page?: number
  seconds: number
  duration: number
  completed: boolean
  updatedAt?: number
}

/** 每日学习时长（Dexie: daily 表） */
export interface DailyRecord {
  date: string
  seconds: number
  videos: number
}

/** 习惯（Dexie: habits 表） */
export interface Habit {
  id?: number
  name: string
  targetDays: number
  remindAt: string
  remindOn: boolean
  note: string
  archived: number
  createdAt: number
}

/** 习惯打卡记录（Dexie: habitLogs 表） */
export interface HabitLog {
  key: string
  habitId: number
  date: string
  at: number
  note: string
}

/** 学习习惯「专注目标」 */
export interface FocusTarget {
  name: string
  color: string
  archived: boolean
  createdAt: number
  /** 本机定制 0.4.12：这个目标每天要提醒的时间点（HH:MM，可多个） */
  reminders?: string[]
}

/** 课表课程（Dexie: courses 表，本机定制 0.4.12） */
export interface Course {
  id?: number
  /** 课程名 */
  name: string
  /** 星期：1=周一 … 7=周日 */
  weekday: number
  /** 开始 / 结束时间，HH:MM */
  start: string
  end: string
  location: string
  teacher: string
  /** 色板 key，见 stores/settings.ts 的 FOCUS_COLOR_KEYS */
  color: string
  /** 关联的专注目标名（可空） */
  targetName: string
  /** 关联的 B 站视频 BV 号（可空） */
  bvid: string
  videoTitle: string
  /** 到点提醒 */
  remindOn: boolean
  /** 提前几分钟提醒：0 / 5 / 10 / 15 */
  remindLead: number
  note: string
  createdAt: number
}

/** 专注记录（Dexie: focus 表） */
export interface FocusSession {
  id?: number
  day: string
  startedAt: number
  at: number
  seconds: number
  completed: boolean
  task: string
  bvid?: string | null
  cover?: string
  mode?: string
  focusMin?: number
}

/** 稍后再看/收藏（本地，Dexie: collect 表） */
export interface CollectItem {
  id?: number
  bvid: string
  title: string
  cover: string
  upName: string
  upMid?: number | null
  duration: number
  page: number
  folder: string
  at: number
}

/** 书架条目（Dexie: shelf 表） */
export interface ShelfItem extends VideoCard {
  at: number
}

/** 本地字幕（Dexie: subs 表） */
export interface LocalSub {
  key: string
  bvid: string
  cid: string
  name: string
  format: string
  count: number
  items: SubtitleCue[]
  at: number
}

/** 应用设置（与 settings store 的 state.settings 一一对应） */
export interface Settings {
  theme: 'dark' | 'light'
  accent: string
  defaultQuality: number
  autoNext: boolean
  seekStep: number
  backupPath: string
  playerVolume: number
  hideDanmakuArea: boolean
  autoMark: boolean
  autoCheckin: boolean
  playbackRate: number
  danmakuOn: boolean
  danmakuOpacity: number
  danmakuArea: number
  autoHideCtl: boolean
  navOrder: string[]
  subAuto: boolean
  subFontSize: number
  subBg: boolean
  subBottom: number
  focusTasks: string[]
  focusTargets: FocusTarget[]
  [key: string]: any
}

/** 页面/组件里通用的「视频目标」 */
export interface VideoTarget {
  bvid: string
  cid?: number
  page?: number
  title?: string
  cover?: string
  upName?: string
  upMid?: number | null
  duration?: number
  startTime?: number
  fromCard?: boolean
}
