/**
 * window.bili 的类型契约（渲染层 <-> 数据层）
 *
 * 这些签名是从原 APK 的 index-B576k3Hi.js（桌面桥代理）与
 * index-jTHZJced.js（安卓桥实现）反推得到的，两个平台完全一致。
 */
import type {
  FavFolder,
  FavResource,
  SubtitleTrack,
  UpCardInfo,
  User,
  VideoCard,
  VideoDetail,
  VideoPage,
  PlayUrl,
  DanmakuItem,
} from '@/types'

export interface QrGenerateResult {
  url: string
  qrcodeKey: string
}

export interface QrPollResult {
  status: 'waiting' | 'scanned' | 'expired' | 'success' | 'error'
  message?: string
  user?: User | null
}

export interface RestoreResult {
  loggedIn: boolean
  user: User | null
  stale?: boolean
  message?: string
}

export interface Paged<T> {
  items: T[]
  total?: number
  page?: number
  hasMore?: boolean
}

export interface LatestResult {
  items: VideoCard[]
  errors?: { mid: number | string; message: string }[]
}

export interface FavFoldersResult {
  created: FavFolder[]
  collected: FavFolder[]
}

/** 收藏夹内容条目（fav:resources 的 medias 元素，字段名来自 B 站接口原样） */
export interface FavResourceItem {
  id?: number
  aid?: number
  bvid: string
  title: string
  cover: string
  intro?: string
  duration?: number
  /** 收藏时间（秒级时间戳） */
  favTime?: number
  pubtime?: number
  upper?: string
  upperMid?: number
  cntInfo?: { play?: number }
  /** 兼容别名（types.ts 的 FavResource 命名） */
  upName?: string
  upMid?: number
  pubdate?: number
  view?: number
}

/**
 * fav:resources 的真实返回：`{ info, medias, hasMore }`。
 * 为兼容 types.ts 的 `Paged<FavResource>` 写法，桥里额外挂了 items/page/total。
 */
export interface FavResourcesResult {
  info?: {
    id?: number
    title?: string
    mediaCount?: number
    media_count?: number
    cover?: string
  }
  medias: FavResourceItem[]
  hasMore?: boolean
  items?: FavResourceItem[]
  page?: number
  total?: number
}

export interface LocalPickResult {
  entries?: any[]
  canceled?: boolean
  dir?: string
  truncated?: boolean
}

export interface WbiBridge {
  platform?: string
  ping(): Promise<any>
  auth: {
    restore(): Promise<RestoreResult>
    qrGenerate(): Promise<QrGenerateResult>
    qrPoll(key: string): Promise<QrPollResult>
    logout(): Promise<any>
  }
  home: {
    feed(page?: number): Promise<Paged<VideoCard>>
    popular(page?: number): Promise<Paged<VideoCard>>
  }
  search: {
    videos(keyword: string, page?: number, order?: string): Promise<Paged<VideoCard>>
    ups(keyword: string, page?: number): Promise<Paged<any>>
  }
  video: {
    view(bvid: string): Promise<VideoDetail>
    pages(bvid: string): Promise<VideoPage[]>
    playurl(bvid: string, cid: any, qn: number): Promise<PlayUrl>
    related(bvid: string): Promise<VideoCard[]>
    danmaku(cid: any, segment?: number): Promise<{ items: DanmakuItem[]; count: number; segment?: number }>
    online(bvid: string, cid: any): Promise<{ total: number; count: number }>
    subtitle(bvid: string, cid: any): Promise<{ list: SubtitleTrack[] }>
    sendDanmaku(payload: any): Promise<any>
  }
  up: {
    info(mid: any): Promise<UpCardInfo>
    videos(mid: any, pn?: number, keyword?: string): Promise<Paged<VideoCard>>
    resolve(query: string): Promise<{ mid: number; name?: string }>
    latest(mids: (string | number)[], perUp?: number): Promise<LatestResult>
    followings(pn?: number, ps?: number): Promise<Paged<any>>
  }
  fav: {
    folders(): Promise<FavFoldersResult>
    resources(mediaId: any, pn?: number): Promise<FavResourcesResult>
  }
  settings: {
    get(): Promise<any>
    patch(patch: any): Promise<any>
  }
  sys: {
    openExternal(url: string): Promise<any>
    pickFile(): Promise<any>
    revealPath(path: string): Promise<any>
    pickSubtitle(): Promise<string[]>
    readSubtitle(path: string): Promise<{ path: string; name: string; size: number; bytes: Uint8Array }>
    pathForFile(file?: any): string
  }
  backup: {
    write(dir: string, name: string, text: string): Promise<string>
  }
  local: {
    pickFiles(): Promise<LocalPickResult>
    pickFolder(): Promise<LocalPickResult>
    register(paths: string[]): Promise<{ entries: any[]; missing: string[] }>
    remove(id: string): Promise<any>
    reveal(path: string): Promise<any>
  }
}
