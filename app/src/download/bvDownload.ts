/**
 * BV 分 P 下载（本机构建 0.4.21）
 *
 * 下载分两步走：
 *  1. 首选 DASH：playurl（fnval=4048）拿视频轨 + 音频轨两条 m4s，交给原生
 *     LocalMediaPlugin.downloadDash 只做 remux（不转码）合成单文件 MP4。
 *     —— 这样 480P 以上、大会员 1080P+/4K/HDR 都能下；出片类型是 MP4，能直接进本地列表。
 *  2. 回退：0.4.20 的单文件 durl（老视频才给；只给 FLV/MP4，清晰度低，且可能被防盗链 403）：
 *     `video.downloadUrl` → `local.download`。
 *
 * 两个阶段共用 local.onDownloadProgress 的进度事件（原生侧 video/audio/mux 三档）。
 */
import { bili } from '@/bridge'
import type { PlayUrl, PlayUrlAudio, PlayUrlVideo } from '@/types'

/** qn → 文案（playurl 没给 accept_description 时的兜底） */
export const QN_LABELS: Record<number, string> = {
  127: '8K',
  126: '杜比视界',
  125: 'HDR',
  120: '4K',
  116: '1080P60',
  112: '1080P+',
  80: '1080P',
  74: '720P60',
  64: '720P',
  32: '480P',
  16: '360P',
  6: '240P',
}

export interface QualityOption {
  qn: number
  label: string
}

/** playurl 返回里能选的清晰度（高 → 低；优先用接口给的 accept_description） */
export function qualitiesOf(play: any): QualityOption[] {
  const raw: number[] = Array.isArray(play && play.acceptQuality)
    ? play.acceptQuality
    : Array.isArray(play && play.accept_quality)
      ? play.accept_quality
      : []
  const desc: string[] = Array.isArray(play && play.acceptDescription)
    ? play.acceptDescription
    : Array.isArray(play && play.accept_description)
      ? play.accept_description
      : []
  return raw.map((qn, i) => ({ qn: Number(qn) || 0, label: String(desc[i] || QN_LABELS[qn] || `${qn}P`) }))
}

/**
 * 从 DASH 里挑轨道：
 *  - 视频：AVC(avc1) 优先（兼容性最好，硬解最稳），其次 HEVC，再 AV1；同编码取码率最高。
 *  - 音频：取码率最高的那条（B 站一般是 AAC）。
 */
export function pickDashStreams(play: PlayUrl): { video: PlayUrlVideo; audio: PlayUrlAudio } | null {
  const videos: PlayUrlVideo[] = (play && play.videos) || []
  const audios: PlayUrlAudio[] = (play && play.audios) || []
  if (!videos.length || !audios.length) return null
  const codecRank = (codecs?: string) => {
    const c = String(codecs || '').toLowerCase()
    if (c.startsWith('avc1')) return 3
    if (c.startsWith('hev1') || c.startsWith('hvc1')) return 2
    if (c.startsWith('av01')) return 1
    return 0
  }
  const video = [...videos].sort(
    (a, b) => codecRank(b.codecs) - codecRank(a.codecs) || (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0),
  )[0]
  const audio = [...audios].sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0))[0]
  return { video, audio }
}

const cleanName = (text: string) => String(text || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80)

export interface BvPart {
  cid: any
  page: number
  part?: string
}

export interface DownloadPartOptions {
  bvid: string
  page: BvPart
  title?: string
  /** 期望清晰度；接口会按账号权限降级 */
  qn?: number
  referer?: string
  /** stage：video / audio / mux（DASH），空字符串表示单文件下载 */
  onProgress?: (p: { received: number; total: number; stage?: string }) => void
}

export interface DownloadPartResult {
  entry: any
  /** dash = 双流合成 MP4；durl = 老的单文件 */
  mode: 'dash' | 'durl'
  note?: string
}

function watchProgress(onProgress?: DownloadPartOptions['onProgress']) {
  if (!onProgress || !bili.local.onDownloadProgress) return Promise.resolve<() => void>(() => {})
  return bili.local.onDownloadProgress((p) => onProgress({ received: p.received, total: p.total, stage: p.stage || '' }))
}

/** 下载一个分 P；DASH 合成失败会自动回退单文件（并在 note 里说明） */
export async function downloadPart(options: DownloadPartOptions): Promise<DownloadPartResult> {
  const { bvid, page, title = '', onProgress } = options
  const referer = options.referer || 'https://www.bilibili.com/'
  const safe = cleanName(`${bvid}-P${page.page}-${page.part || title || 'video'}`)

  let dashError: any = null
  try {
    const play: PlayUrl = await bili.video.playurl(bvid, page.cid, options.qn || 80)
    const streams = pickDashStreams(play)
    if (streams && bili.local.downloadDash) {
      const off = await watchProgress(onProgress)
      try {
        const entry: any = await bili.local.downloadDash({
          videoUrl: (streams.video as any).baseUrl || (streams.video as any).url || '',
          audioUrl: (streams.audio as any).baseUrl || (streams.audio as any).url || '',
          videoBackups: streams.video.backupUrl ? [String(streams.video.backupUrl)] : undefined,
          audioBackups: streams.audio.backupUrl ? [String(streams.audio.backupUrl)] : undefined,
          name: `${safe}.mp4`,
          referer,
        })
        return { entry, mode: 'dash' }
      } finally {
        try {
          off()
        } catch {}
      }
    }
    if (streams) throw new Error('当前环境不支持 DASH 合成下载')
  } catch (e: any) {
    dashError = e
  }

  // 回退：单文件 durl（0.4.20 的路径）
  const info = await bili.video.downloadUrl!(bvid, page.cid, 0)
  const ext = info.format === 'flv' ? 'flv' : 'mp4'
  const off = await watchProgress(onProgress)
  try {
    const entry: any = await bili.local.download!({ url: info.url, name: `${safe}.${ext}`, referer })
    return {
      entry,
      mode: 'durl',
      note: dashError ? `合成下载没走通，已回退单文件：${dashError.message || dashError}` : undefined,
    }
  } finally {
    try {
      off()
    } catch {}
  }
}
