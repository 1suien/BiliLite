# 29 本机 0.4.21：BV 下载升级——DASH 双流 + 原生合成 MP4

> 上一版（0.4.20）的「BV 下载」只能用 `video.downloadUrl`（`fnval=1&platform=html5`）拿**单文件 durl**：
> 只对老视频有效，清晰度低（多数 360P/480P），1080P 及以上根本拿不到；FLV 还进不了 MP4 播放链路。
>
> 0.4.21 换成 B 站现在真正在用的方式：**DASH 双流（视频轨 m4s + 音频轨 m4s）→ 原生 `MediaExtractor`/`MediaMuxer` 只做 remux（不转码）合成单个 MP4**。
> 合成失败（例如某个视频只给 durl、或设备不认 HEVC）时自动回退 0.4.20 的单文件下载。

## 1. 为什么要换（0.4.20 的天花板）

| 问题 | 0.4.20（单文件 durl） | 0.4.21（DASH 合成） |
|---|---|---|
| 清晰度 | 接口对多数视频**不返回** durl（新视频、大会员视频尤其），能拿到的通常只有 360P/480P | 走 `playurl(fnval=4048)`，按账号权限给到 480P～4K/HDR，**登录后 1080P+ 可用** |
| 格式 | durl 可能是 FLV，需要额外的播放链路 | 输出标准 MP4（H.264/H.265/AV1 + AAC），本地播放器直接播 |
| 多分P / 高码率 | 单文件码率低，长视频体积也不对 | 视频轨、音频轨可各自选最高码率，体积可控 |
| 稳定性 | 视频只给「服务端拆多段」就报错 | 两路流都支持备用 CDN 地址重试；合成失败仍有单文件兜底 |
| 版权/授权 | 只下载你能正常播放的内容 | 同上（仅个人离线看，**不绕过付费/权限**，大会员画质需要你的大会员账号登录） |

## 2. 实现链路

```
LocalView.vue（弹层：BV 输入 → 解析 → 分P → 清晰度 → 下载）
  ↓ 1. bili.video.playurl(bvid, cid, qn)   // fnval=4048，返回 videos[] / audios[]
  ↓ 2. app/src/download/bvDownload.ts
  │     pickDashStreams()：视频优先 avc1（兼容/硬解最好）→ hev1/hvc1 → av01，同编码取码率最高；音频取码率最高
  ↓ 3. bili.local.downloadDash({ videoUrl, audioUrl, videoBackups, audioBackups, name })
  ↓ 4. 原生 LocalMediaPlugin.downloadDash（Java）
  │     - HttpURLConnection 带 Referer/桌面 UA 拉两路流 → <name>.v.part / <name>.a.part
  │     - 备用 CDN：主地址失败自动换 backupUrl
  │     - 每 300ms notifyListeners('downloadProgress', { stage, received, total, name })
  │     - MediaExtractor 各取一条 video/audio 轨 → MediaMuxer(MUXER_OUTPUT_MPEG_4)
  │       按 presentationTimeUs 归并写样本（只搬字节，不重编码），最多 2MB/256KB 缓冲区
  │     - describe() 返回和「本地导入」一致的条目 → 进 Dexie locals 表
  ↓ 5. 失败自动回退：video.downloadUrl + local.download（0.4.20 老路径），并在弹层里提示
```

## 3. 改动文件

| 文件 | 改动 |
|---|---|
| `app/android/app/src/main/java/com/bililite/app/LocalMediaPlugin.java` | 新增 `downloadDash`（双流下载+合成）、`fetchStream`（备用源/进度）、`muxToMp4`（remux）、`withBackups`、`emitProgress` 等；`DESKTOP_UA` 常量 |
| `app/src/download/bvDownload.ts` | **新增**：`qualitiesOf`（清晰度列表）、`pickDashStreams`（选轨策略）、`downloadPart`（DASH 优先 + durl 回退） |
| `app/src/views/LocalView.vue` | BV 弹层加清晰度选择、分P 切换自动刷新清晰度、进度显示「视频流/音频流/合成中」 |
| `app/src/bridge/types.ts`、`android.ts`、`mock.ts`、`index.ts` | 桥接层暴露 `local.downloadDash`；进度事件带 `stage`；浏览器 mock 也能跑通弹层 |
| `app/package.json`、`app/android/app/build.gradle` | 0.4.20 → **0.4.21**（versionCode 25） |

## 4. 限制（如实说）

- 清晰度受**账号权限**限制：不登录一般 480P；要 1080P+ 得在 App 里扫码登录，4K/HDR 需要大会员——App 不会也不该绕过这些限制。
- 合成用的 `MediaMuxer`：H.264/AAC 最稳；HEVC/AV1 多数机器能 remux，个别老机器可能失败 → 已回退单文件。
- 没有「全站下载队列/断点续传」（下一步可加）；同一时间只下一个分P，下载中关弹层会中断。
- 只做**个人离线观看**用途；不提供批量抓取/付费内容绕过。

## 5. 验收路径

1. 本地页 →「BV 下载」→ 粘贴 BV 号为 `BV1xx…` 的视频 → 解析出标题/分P。
2. 选一个分P → 出现「清晰度」按钮行（未登录通常 480P/360P；登录后 1080P 等）。
3. 点「下载这个分P」→ 进度依次出现「视频流 %」「音频流 %」「合成中」→ toast「已下载并合成」。
4. 关闭弹层，本地列表出现该条目，点开可直接播放（MP4 有音有画）。
5. 故意选一个只给 durl 的老视频 → 自动回退并提示「合成下载没走通，已回退单文件」。
