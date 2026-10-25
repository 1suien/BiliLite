# 播放内核与播放相关组件 · 语义级核对报告
还原工程：`/root/学习软件/app/src`（TypeScript）· 上游：`/tmp/up043`（BiliLite v0.4.3，JavaScript）
核对方式：逐函数人工对读（不看注释文案，只看常量、条件、调用顺序、错误分支）+ 关键行双侧重引
报告生成：只读审计，未修改 `/root/学习软件` 下任何文件

---

## 0. 结论与还原度

**一句话结论**：播放内核（`player/dash.ts`）在「选轨 → sidx/Range 起流 → 单连接续拉 + 攒批 + 背压 + 换线 + 配额淘汰 → 重连 → 时长收尾」的全部关键路径上与官方 v0.4.3 语义等价，未发现会导致播放失败、数据错误或逻辑颠倒的严重缺陷；差异集中在**对外 API 的扩展（4 项可选能力）**、**TS 化后的命名/类型**，以及两处**真实行为退化**（`play()/pause()` 丢失 `wasPlaying` 维护、PartList 首屏不滚到当前 P）。播放页、字幕、组件、桥接层是「同一份逻辑换一种组织方式」，字幕解析甚至是逐行照搬。

**还原度估计（按行为面加权）**

| 模块 | 还原度 | 依据 |
|---|---|---|
| `player/dash.ts` ↔ `player/dash.js` | **≈95%** | 21 处核心函数逐行等价；2 处行为退化（中危）+ 3 处微小实现差异；6 项 extra API 但都不参与既有调用路径 |
| `player/quality.ts` ↔ `utils/quality.js` | **100%** | 13 档 QN 表、顺序数组、排序函数数值完全一致，仅改名 |
| 字幕解析（`VideoView.vue:301-445` ↔ `utils/subtitle.js`） | **100% 行为 / 50% 结构** | 6 条清洗正则、时间轴正则、NOTE/STYLE/REGION 跳过、GB18030 回退逐行等价；但不再是独立可复用模块 |
| `views/VideoView.vue` | **≈93%** | 状态机/计时器/上报/打卡/连播/分P/剧场全屏一致；钩子契约改名 + durationHint 透传 + 若干文案 |
| `components/PartList.vue` | **≈95%** | props/emit/分组/筛选/高亮一致；缺 `onMounted(scrollToCurrent)` |
| `components/CollectModal.vue` | **100%** | props/emit/三个动作/模板/文案一致，仅改名 |
| `components/MiniPlayer.vue` | **≈93%** | 拖动/吸边/串行 load/静音兜底/1.2s 停顿重载全部一致；少调试埋点、图标名替换、钩子无 gen 守卫（有等价守卫） |
| `bridge/android.ts` 视频/弹幕/字幕通道 ↔ `mobile/bridge.js` | **≈98%** | 8 个视频通道 + 3 个字幕相关 sys 通道签名/默认值/错误文案逐条一致 |
| **综合** | **≈94%** | 无严重缺陷；2 条中危可在真机上被用户感知 |

---

## 1. 文件映射表

| 还原 | 上游 | 行数（还原/上游） | 等价度 | 说明 |
|---|---|---|---|---|
| `app/src/player/dash.ts` | `renderer/src/player/dash.js` | 1446 / 1174 | ≈95% | 类 `DashKernel` + 工厂 `createDashPlayer`；上游是 `export class DashPlayer` + `new DashPlayer` |
| `app/src/player/quality.ts` | `renderer/src/utils/quality.js` | 40 / 26 | 100% | `QUALITY_NAMES/QUALITY_ORDER/qualityName/sortQualities` ↔ `QN_LABEL/QN_ORDER/qnLabel/sortQuality` |
| `app/src/views/VideoView.vue` | `renderer/src/views/VideoView.vue` | 1659 / 1344 | ≈93% | 播放页 + 剧场/全屏 + 分P + 学习记录；字幕解析内联 |
| ↑ 内联字幕（`VideoView.vue:301-445`） | `renderer/src/utils/subtitle.js` | 145 / 159 | 100%（行为） | 独立模块被折叠进视图，其余处无法复用 |
| `app/src/components/PartList.vue` | `components/PartList.vue` | 254 / 241 | ≈95% | 缺首屏 `onMounted` 定位 |
| `app/src/components/CollectModal.vue` | `components/CollectModal.vue` | 164 / 132 | 100% | 仅变量改名（`saving`↔`busy`、`collected`↔`collectedIn`） |
| `app/src/components/MiniPlayer.vue` | `components/MiniPlayer.vue` | 681 / 665 | ≈93% | 语义等价；调试埋点/图标名/守卫写法有差 |
| `app/src/bridge/android.ts` | `src/mobile/bridge.js` | 598 / 378 | ≈98% | handler 表 + 信封 + `api` 门面 |
| `app/src/bridge/api.ts`（`videoSubtitle`/`sendDanmaku`） | `src/main/bili/danmaku.js` | 1277 / — | 100% | 字幕取前 5 轨、15000ms、`decodeEntities`、`needLogin` 一致 |
| `app/src/App.vue` + `main.ts`（剧场/全屏宿主） | `renderer/src/App.vue` | 361 / 346 | 等价 | 剧场类名、Esc 退出、安卓返回键退出为移动端补充 |
| `app/src/styles/global.css` | `renderer/src/styles/base.css` | — | 逐字节等价 | `.player-wrap:fullscreen`（:874 / :877）与 `object-fit: contain`（:880 / :883） |

---

## 2. 必核 9 点逐项结论

### 2.1 选轨策略 —— 等价（逐常量、逐比较函数核对）

| 规则 | 还原 | 上游 | 结论 |
|---|---|---|---|
| 视频编码优先级 `avc1 > hev1/hvc1 > av01 > 其它` | `codecRank` `dash.ts:209-218`：`startsWith('avc1')?0 : startsWith('hev1')\|\|startsWith('hvc1')?1 : startsWith('av01')?2 : 3` | `videoRank` `dash.js:108-114`：三段 `if` 同序同值 | 完全一致 |
| 指定 qn 的匹配 | `dash.ts:225` `const matched = want ? usable.filter(v => Number(v.id) === want) : []`；`:226` `(matched.length ? matched : usable).sort(...)` | `dash.js:129-132` `const matched = wanted ? usable.filter(t => Number(t.id) === wanted) : []; const pool = matched.length ? matched : usable` | 一致（含"匹配不到则回退全量"） |
| 分辨率 / 带宽排序 | `dash.ts:227-230`：`codecRank` → `(b.width*b.height)-(a.width*a.height)` → `(b.bandwidth)-(a.bandwidth)` | `dash.js:133-137` 同三键同方向 | 一致（分辨率优先于带宽，注释里"360P 带宽可能高于 480P"的经验被保留） |
| 音频编码优先级 | `dash.ts:235-241`：`/mp4a/i` 全量过滤，为空才 `/opus/i`，再 `bandwidth` 降序 | `dash.js:140-144` 同 | 一致 |
| 地址字段兼容 | `trackUrl` `dash.ts:197-199` `t.url\|\|t.baseUrl\|\|t.base_url`；`trackBackup` `:202-206` `backup\|\|backupUrl\|\|backup_url` | `dash.js:98-106` 同 | 一致 |
| mcdn 排序 | `trackUrls` `dash.ts:247-254`：`/\.mcdn\.bilivideo\.cn/i` 命中者排到最后，其余保序 | `dash.js:146-157` 同正则同策略 | 一致 |
| 选轨在何处发生 | `openDash` `dash.ts:676`，`:701-702` 取地址列表 | `dash.js:398-399`、`:414-415` | 一致 |

### 2.2 起流：Range 探测 / sidx / 偏移 / init / 回退 —— 等价

| 环节 | 还原 | 上游 |
|---|---|---|
| 首次探测 64KB | `dash.ts:929` `fetchBytes(url, 0, PROBE_BYTES - 1, gen)`，`PROBE_BYTES = 65536`（`:116`） | `dash.js:664` `fetchBytes(url, 0, HEAD_PROBE_BYTES - 1, gen)`，`HEAD_PROBE_BYTES = 65536`（`:15`） |
| 必须 206 才算数 | `dash.ts:935` `if (res.status !== 206) continue` | `dash.js:670` 同 |
| 无 sidx → 重探 512KB | `dash.ts:942` `fetchBytes(url, 0, PROBE_BYTES * 8 - 1, gen)` | `dash.js:674` `HEAD_PROBE_BYTES * 8 - 1` |
| sidx 解析 | `parseSidx` `dash.ts:257-320`：顶层 box 遍历、`size==1` 走 64 位、`size==0` 到 EOF、`p+=4` 跳 fullbox、version0/1 两分支、`refs` 循环 `p+12<=min(bodyLen, box.size-headerSize)`、`size&0x7fffffff` | `dash.js:160-217` 同结构同边界 |
| 起播秒 → 字节偏移 | `sidxOffset` `dash.ts:323-337`：`target = max(0,sec)*timescale`，累加 `ref.dur` 直到 `acc+ref.dur > target`，返回 `initEnd + firstOffset + Σsize` | `dash.js:219-230` 同 |
| init 段 append | `streamRanged` `dash.ts:961-973`：先 `append(kind, probe.initBytes)`，成功才 `streamFrom(kind, urls, gen, offset)` | `dash.js:695-708` 同 |
| 拿不到 sidx 的回退 | `startStreams` `dash.ts:761-785`：只有**音视频都探测成功**才 ranged；否则 `usedFallbackFromZero = true` → `recreateMedia`（Chromium 对单个 MediaSource 的 SourceBuffer 创建次数有上限） → 双轨 `offset=0` 顺序拉 + `jumpWhenBuffered` | `dash.js:477-518` 同（含 `recreateMedia` 的同一注释理由） |
| 起播定位 | `openDash` `dash.ts:716-725`：`startTime > 0.5` 时 ranged 模式直接 `currentTime = start`，fallback 模式 `jumpWhenBuffered` | `dash.js:437-447` 同 |

### 2.3 拉流循环 —— 等价（唯一差异在末次 flush 的 abort 清理）

| 环节 | 还原 | 上游 | 结论 |
|---|---|---|---|
| 一次 fetch + Range 长连接（非逐段） | `streamFrom` `dash.ts:992-996`：`headers: offset > 0 ? { Range: \`bytes=${offset}-\` } : {}`，随后 `res.body.getReader()` `:1017` 持续读 | `dash.js:733-737`、`:756` | 一致 |
| Range 被忽略（200）→ 换线 | `dash.ts:1006-1013` `if (offset > 0 && res.status !== 206) { abort.delete; body.cancel(); continue }` | `dash.js:747-754` 同 | 一致 |
| 攒批阈值 | `VIDEO_CHUNK = 512*1024`、`AUDIO_CHUNK = 128*1024`（`dash.ts:120-121`），`:1019` `chunkLimit` | `BATCH_VIDEO_BYTES`/`BATCH_AUDIO_BYTES`（`dash.js:22-23`），`:754` | 一致 |
| flush 定时 | `FLUSH_MS = 300`（`dash.ts:123`），`:1072` `reads === 1 \|\| pendingBytes >= chunkLimit \|\| Date.now()-pendingSince >= FLUSH_MS` | `BATCH_MS = 300`（`dash.js:24`），`:805` `chunks === 1 \|\| ...` | 一致（首块立即 append 的起播优化保留） |
| ahead 背压 | `dash.ts:1053-1056` `while (ahead(kind) > BUFFER_AHEAD && gen===this.gen && !destroyed) { flush(); sleep(220) }`，`BUFFER_AHEAD = 45`（`:118`） | `dash.js:789-792` `AHEAD_MAX = 45`（`:17`），`sleep(220)`（`:791`） | 一致；`ahead()` 的窗口判定也一致（`dash.ts:1218` `now >= b.start(i)-1 && now <= b.end(i)+30` ↔ `dash.js:962`） |
| 首包超时换线 | `dash.ts:1037-1043` `setTimeout(..., FIRST_CHUNK_TIMEOUT=8000)`，`if (got) return` 否则 abort | `dash.js:779` `FIRST_BYTE_TIMEOUT = 8000`（`:26`） | 一致 |
| QuotaExceededError | `append` `dash.ts:1130-1148`：`quota = e.name === 'QuotaExceededError'`，`attempt >= 2` 放弃，`evict(Math.max(10, BUFFER_AHEAD + 15 - attempt*20))` | `dash.js:861-880`：同判定、`Math.max(10, AHEAD_MAX + 15 - attempt*20)`（`:870`） | 一致（还原少一次 `sleep(120)`，见 L5） |
| evict 区间 | `dash.ts:1178-1206` `keepAhead = BUFFER_AHEAD+15`、`from = now-5`、`to = now+keepAhead`、先收集再逐段 `remove` | `dash.js:918-950` `keepAhead = AHEAD_MAX+15`、`cut = now-5`、`far = now+keepAhead` | 一致 |
| error 重连次数 | `recoverFromElementError` `dash.ts:818-843`：`recoveries >= 2` 才 `onError('播放出错（...）')`，重连前 `sleep(600)`，从 `at > 2 ? at : 0` 重开 | `dash.js:536-569`：同阈值、`sleep(555→600)`、同 `at > 2` | 一致 |
| 起播后补播 | `ensurePlaying(gen, tries=6)` + `sleep(400)`（`dash.ts:803-815`） | `dash.js:521-534` 同 | 一致 |
| duration 未知收尾 | `settleDuration` `dash.ts:899-917`：仅 `ms.duration === Infinity` 时取 `[videoBuffer, audioBuffer]` buffered 末端最大值写入 | `dash.js:633-652` 同 | 一致 |
| 失败上报文案 | `dash.ts:1108-1113` `拉流失败：${msg}${host ? ' @'+host : ''}`，仅"未 append 过任何数据"时抛 | `dash.js:840-848` 同 | 一致（这正是播放页 `errHuman` 里 `/拉流失败/` 分支的输入） |
| **末次 flush 的 abort 清理** | `dash.ts:1092` `if (await flush()) this.aborts.delete(abort)` | `dash.js:825-827` `if (!(await flush())) return appended` → 成功路径才 delete | 极端分支下的 AbortController 残留（见 L4） |

### 2.4 mpegts.js 兜底与 flv/ts/mp4 分支 —— 等价 + 1 处扩大

| 项 | 还原 | 上游 |
|---|---|---|
| 判据 | `dash.ts:630-631` `hint === 'flv' \|\| hint === 'ts' \|\| /\.(flv\|ts)(\?\|$)/i.test(url)` | `dash.js:365` `const isFlv = /\.flv(\?\|$)/i.test(url)` |
| 非 flv 直通 `<video>` | `dash.ts:632-643` `video.src = url`，`startTime > 0.5` 时 `loadedmetadata` 一次性 seek | `dash.js:366-378` 同 |
| mpegts 特性校验 | `dash.ts:648-652` `getFeatureList().mseLivePlayback` 否则 `当前环境不支持 FLV 播放` | `dash.js:380-384` 同 |
| createPlayer 参数 | `dash.ts:653-659` `{type:'flv', url, isLive:false, hasAudio:true}` + `attachMediaElement` + `load()` + `ready=true` + `currentTime=startTime` | `dash.js:386-392` 同 |
| 动态 import | `dash.ts:647` `import('mpegts.js')`（注释说明上游是 `import('./mpegts-*.js')` 的 Vite chunk，效果相同） | `dash.js:379` `import('mpegts.js')` |
| 额外分支 | 空 url 守卫 `dash.ts:626-629`；`.ts` 也交给 mpegts | 上游无（`.ts` 会直接喂 `<video>`，通常失败） |

> 播放页上游没有 mpegts/durl 之外的第三条路：`load()` 只分 `mode==='dash'` 与 `durl.length`（`dash.js:343-352` ↔ `dash.ts:597-609`），mp4 直链走"非 flv"分支，两边一致。

### 2.5 播放页行为 —— 一致（细节见 §3 低危项）

| 行为 | 还原 | 上游 | 结论 |
|---|---|---|---|
| 剧场模式 | `App.vue:46` `const theater = ref(false)`、`:49` toggle、`:56` 路由切换重置、`:178-179` `Escape` 退出、`:216` `:class="['app', { theater }]"`、`:332/:351` 进入/退出按钮 | `App.vue:32/34/42/200-201/208/311-315/327-334` | 一致；还原另在 `main.ts:88-121` 让安卓返回键先退剧场/全屏（移动端补足） |
| 全屏（0.4.3 的 flex 居中修复） | `global.css:874` `.player-wrap:fullscreen { border:0; border-radius:0; display:flex; align-items:center }`、`:880` `.player-wrap:fullscreen .player-stage video { object-fit: contain }` | `base.css:877`/`:883` 同 | 一致（global.css 按 CONTRACT 与 APK 产物逐字节等价） |
| 播放器尺寸/进度 | `bufferedPct` 由 `updateBuffered`（`:1027-1037`，读 `videoEl.buffered` 末端 / `duration*100`）在 `onTime` 钩子（`:835`）与 1s tick（`:970`）里刷新；进度条宽度 `playedPct`（`:233`） | 上游 `bufferedPct` 在 `timeupdate` 处理函数里按同一口径计算 | 一致（口径同为 `end/duration*100`；还原内核另有未被视图使用的 `onBuffer` 钩子，见 §2.8 extra-1） |
| 清晰度切换 | `selectQuality` `:1103-1129`：锁档拦截 → 重取 `bili.video.playurl` → `player.load(...,{startTime:keep})` → `settings.patch({defaultQuality})` | `:866-874` 同流程 | 一致（还原内核另有 `setQuality()` 未被视图使用，见 §2.8 extra-1） |
| 自动连播 | `onEnded` `:1040-1048`：`learn.save(completed:true)`，`autoNext` 且有下一 P → toast `自动播放下一 P` + `selectPage(+1)` | 上游 `onEnded` 同 | 一致 |
| 进度上报 | 1s tick 累计 `secondsAcc/watchedSeconds`，满 10s `learn.addSeconds`；5s `learn.save`（`\|Δ\|<2s` 跳过） | 上游 `startTimers` 同参数 | 一致 |
| 自动标记完成 | `completed: total > 0 && at / total > 0.95`（`:1019`）+ 播完强制 `completed:true` | 同 | 一致 |
| 自动打卡 | `autoCheckin` `:936-949`：`watchedSeconds >= 300 && !checkedIn && autoCheckin`，`learn.isChecked()` 短路，toast ``已自动打卡 · 连续 ${learn.checkinStreak} 天`` | `VideoView.vue:705-718` 同 | 一致 |
| 分P 切换 | `selectPage` `:1092-1100`：flush → `pageIndex` → `lastSavedAt=-1` → `router.replace({p})` → status `切换分P…` → `loadPlayurl` | 同 | 一致 |
| 错误文案 | `errHuman` `:213-221`：`/^([^：:]+)[：:]\s*([\s\S]*)$/` 拆 human/why；`/拉流失败\|Failed to fetch\|TypeError\|NetworkError/i` → `这条线路暂时拿不到数据`；`diagLine` `:224-230` 仅安卓 | 上游 `errSplit`/`streamDiag` 同正则同文案 | 一致 |
| 右键 / 快捷键 | 两侧**都没有** `contextmenu` 处理（右键走 WebView/浏览器默认）；快捷键 `onKeydown` `:1206-1225`：Space、←/→ = `seekStep`、↑/↓ = ±0.05、KeyF 全屏、INPUT/TEXTAREA 跳过 | 上游 `onKey` 同 | 一致 |
| 小窗互切 | `toMini` `:903-920` / `fromMini` `:923-933`，toast `已缩到小窗播放，可以接着翻别的页面` | 上游 `popMini`/`pullBackMini` 同 | 一致 |

### 2.6 字幕 —— 行为逐行等价，结构退化

解析层（`VideoView.vue:301-445` ↔ `utils/subtitle.js:12-159`）逐条对齐：

| 点 | 还原 | 上游 | 结论 |
|---|---|---|---|
| 扩展名集合 | `:301` `['srt','vtt','ass','ssa']` | `:13` `SUB_EXTS` | 一致 |
| 取扩展名 | `:305` `/\.([A-Za-z0-9]+)\s*$/` → toLowerCase | `:17` 同 | 一致 |
| 字节解码 + GB18030 回退 | `:315-331`：去 UTF-8 BOM（EF BB BF）→ `TextDecoder('utf-8',{fatal:true})` → 失败 `gb18030` → 再失败宽松 utf-8 | `:30-46` 同三段 | 一致（UTF-16 两边都没处理） |
| 时间轴 | `:337` `/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/`，`Number(m[4].padEnd(3,'0'))/1e3` | `:52` 同 | 一致 |
| 清洗 | `:347-363` 六条：`/\{[^}]*\}/g`、`/<\/?[A-Za-z][^>]*>/g`、`\N`/`\n`→换行、`\h`→空格、`&nbsp;/&amp;/&lt;/&gt;`(gi)、逐行 trim+filter | `:62-74` 同 | 一致 |
| SRT/VTT 分块 | `:373-391` `\r\n?`→`\n`、split `/\n{2,}/`、首行 `WEBVTT/NOTE/STYLE/REGION` 跳过、`-->` 定位、右端 `split(/\s+/)[0]` | `:85-104` 同 | 一致，"多行字幕只取第一行时间"的上游缺陷也一并保留 |
| ASS/SSA | `:394-432` `[Events]` 段内 `Format:` 字段小写化、`Dialogue:` 按 `fields.length-1` 个逗号切（Text 可含逗号） | `:107-145` 同 | 一致 |
| 格式嗅探 + 排序 | `:435-445` 去 `^\uFEFF`、`assLike = ext==='ass'\|\|'ssa'\|\|(!ext && /\[events\]/i && /^\s*dialogue\s*:/im)`、按 `from` 再 `to` 排序 | `:152-159` 同 | 一致 |
| 多轨切换 | `loadOnlineSubs`（`:465-484`）cid 去重 + 首轨自动选；`pickLan`（`:498-503`）`subOff = !lan`；`pickLocal`（`:506-511`）清 `subLan`、`subOff=false`；`cues`（`:256-262`）本地优先于在线 | 上游 `loadSubtitles/pickCc/pickLocal/activeCc` 同 | 一致 |
| 当前字幕查找 | `cueText` `:266-285` 二分，`end = hit.to \|\| hit.from + 8` | 上游 `activeCc` 同 | 一致 |
| 显示样式 | `subStyle` `:287-295` 字号默认 22、位置 `subBottom>=0 ? subBottom : 10`、`subBg=false` → 透明底 + `0 1px 4px rgba(0,0,0,0.95)` | 上游 `ccStyle` 同 | 一致 |
| 结构 | 全部内联在视图里；`app/src/utils/` 下只有 `format.ts` | 独立模块，6 个 export 供他处/测试复用 | **不等价（结构）**，见 L8 |

### 2.7 组件接口 —— 一致

**PartList**：`props {parts, index, title='分P列表'}`、`emit select(index)`（还原 `PartList.vue:16-26` ↔ 上游 `:11-16`）；`filtered`（`:33-41` ↔ `:21-31`，`p.title||p.part` 与 `page`、`^p\s*` 前缀剥离一致）；`L###` 分组标签与「开篇」兜底（`:44-58` ↔ `:35-50`）；`pages.length > 12` 才出筛选框、无匹配文案「没有匹配的分P」、`共 N P / 命中 / 当前 P` 文案一致；`.page-pill.on` 高亮与 `max-height: clamp(373px,56vh,560px)` 一致；**唯一差异：无首屏定位**（还原 `:12` 未 import `onMounted`、`:77-78` 只有两个 watch ↔ 上游 `:2` 引入、`:63` `onMounted(scrollToCurrent)`）。

**CollectModal**：`props {open=false, video={}}`、`emit close`（还原 `:16-25` ↔ 上游 `:12-18`）；打开时重置输入 + `collect.init()`（`:37-45` ↔ `:27-33`）；`addTo(name)` → `collect.add(video,name)` → `ui.ok(\`已收藏到「${name}」\`)` → close（`:47-58` ↔ `:35-45`）；新建并收藏（`:61-74` ↔ `:47-56`）；移出本机收藏 `collect.removeByBvid` → `已移出本机收藏（${n} 处）`（`:76-82` ↔ `:58-62`）；模板结构、`已收藏` 标记、`v-if="collected.size"` 的移出按钮、`@click.self="emit('close')"` 全部一致。

**MiniPlayer**：`props`/store 接口一致（拖动 `clampPos/moveTo` `:73-89` ↔ `clamp/place` `:57-68`，`h = size.h + 30`、四边 8px、右下初始 `innerWidth-w-26 / innerHeight-h-110` 一致）；串行 `ensureLoad`（`:243-257` ↔ `reload` `:219-235`，注释同样说明「两次 load() 叠在一起会把 MediaSource 顶掉」）；`ensurePlay`（`:260-287` ↔ `resume` `:238-262`）含 `player.wasPlaying = true`（`:267` ↔ `:245`）、静音重试、1.2s 未动重载；`scheduleResume` 3 次 ×1500ms（`:288-299` ↔ `:265-274`）；`togglePlay/seekTo/toggleMute`（`volume<=0.01 → 0.8`）`/backToVideo` 一致；单 watcher `watch([open, seq])`（`:414` ↔ `:404-410`）；`watch(mini.sizeIndex)` 一致；模板层级（mp-head 四按钮、mp-body 视频、error 覆盖层、`点一下继续播放`、`已静音播放`、mp-foot）一致。

### 2.8 missing / extra

**还原缺失（相对上游）**
1. `PartList` 首屏滚到当前 P（`onMounted(scrollToCurrent)`）——见 M2。
2. 字幕解析独立模块 `utils/subtitle.js` 的等价物（6 个具名导出）——见 L8。
3. `dash.js` 的 `wasPlaying` 维护（`play()/pause()`）——见 M1。
4. 上游 `evict` 后 `sleep(120)` 的缓冲间隔——见 L5。
5. `AHEAD_MIN = 18`（`dash.js:18`）与 `wantTime` 字段：上游声明后**从未使用**，还原未复刻，属合理清理（不算缺失）。
6. `DanmakuLayer` / 弹幕渲染：0.4.3 上游已是死代码（无引用），还原同样未实现；`settings.danmakuOn/Opacity/Area` 两侧都保留但都没有消费方，符合"不在内"的约定。
7. MiniPlayer 的 `window.__tapLog` / `window.__miniLoads` 调试埋点（`__miniLoads` 还原保留，`__tapLog` 去掉）。

**还原多出（extra，均不改变既有调用语义）**
1. `player/dash.ts` 新增可选能力：`setQuality(qn)`（`:1368-1382`，直接在同一次 playurl 的候选轨里重选，不重新请求接口）、`setRate`（`:1359-1365`）、`onBuffer/emitBuffer`（`:41-42`、`:543-553`）、`load({durationHint})`（`:61-70`、`:593`、`:565-576`）、`get media()`（`:494`）、`DashDirectSource.type/live`（`:55-59`）、`normalizeSource` 兼容 `{videos,audios,duration(秒)}`（`:383-444`）。
2. `openDirect` 增加空 url 的 `onError` 守卫（`:626-629`）；`.ts` 直链也走 mpegts（`:630-631`）。
3. 内核事件补充：`progress` → `emitBuffer`（`:518`）、`ended` 额外 `onState('ended')`（`:520-523`）、`waiting` 带 `'缓冲中…'` 文案（`:527`）、自动播放被拦时 `onState('paused','自动播放被拦截，点击画面开始播放')`（`:619`）。
4. 视图层把 `durationHint` 直接塞进 `load()`（`:874`），等价于上游先 `setDurationHint()` 再 `load()`。
5. MiniPlayer 用 `Icon name="expand"` 替代上游 `name="size"`（`icons.ts` 里没有 `size`，APK 里那一格渲染为空），属修 bug 而非偏差。
6. `main.ts:88-121` 安卓返回键：先退全屏/剧场再退页面（移动端补充）。

---

## 3. 差异清单（按严重度）

> 严重（功能不可用/数据错误）：**0 条**。逐条排查过的候选（起播失败、选错轨、时长错乱、字幕串 P、上报重复、连播越界、全屏不居中）双双一致。

### 中（可在真机被用户感知，建议修）

#### M1 `play()/pause()` 丢失 `wasPlaying` 维护 → 暂停中拖进度条会自动续播
- 还原 `app/src/player/dash.ts:1336-1342`
  ```ts
  play() {
    return this.video.play().catch(() => {})
  }

  pause() {
    this.video.pause()
  }
  ```
- 上游 `renderer/src/player/dash.js:1085-1092`
  ```js
  play() {
    this.wasPlaying = true
    return this.el.play().catch(() => {})
  }

  pause() {
    this.wasPlaying = false
    this.el.pause()
  }
  ```
- 影响链（还原侧仍在用 `wasPlaying`）：
  - `dash.ts:1264` `const resume = !this.video.paused || this.wasPlaying` —— 用户按了暂停（`paused=true`，但 `wasPlaying` 仍为 true）后拖动进度条，`onSeeking` 会重开流并 `ensurePlaying`，**画面自行开始播放**。
  - `dash.ts:829-836` 元素报错重连：`const wasPlaying = this.wasPlaying; ... if (wasPlaying) ensurePlaying(...)` —— 暂停中出错恢复后会**继续播**；反过来，用户是"播放中暂停后重连"的场景又拿不到正确的初始态。
  - MiniPlayer 侧因为 `MiniPlayer.vue:267` 手写 `player.wasPlaying = true`（对应上游 `MiniPlayer.vue:245`）而部分自愈；播放页 `VideoView.vue` **没有任何地方**补写该字段，问题只在播放页出现。
- 修复：把 `wasPlaying = true/false` 分别补回 `play()/pause()`（两行），或让 `onSeeking` 只依据 `!video.paused && !video.ended`。

#### M2 PartList 首屏不滚到当前分 P
- 还原 `app/src/components/PartList.vue:12`（import 列表里没有 `onMounted`）、`:65-76`（`scrollToCurrent` 定义）、`:77-78`（只有两个 `watch`）
- 上游 `renderer/src/components/PartList.vue:2`（`import { computed, nextTick, onMounted, ref, watch } from 'vue'`）、`:63` `onMounted(scrollToCurrent)`
- 影响：打开上百 P 的课程/合集、且 `pageIndex > 0`（从学习记录或 `?p=` 直达）时，列表停在 P1 附近，用户看不到高亮的当前行，只能点右侧「跳到当前」（`PartList.vue:92`）补救；上游是"进页面即定位"。
- 修复：`import { onMounted }` + `onMounted(scrollToCurrent)`（注意 `scrollToCurrent` 内已有 `await nextTick()`，与上游一致）。

### 低（等价或有微小差异）

#### L1 `.ts` 直链被交给 mpegts.js（分支扩大）
- 还原 `dash.ts:630-631`：`const isFlvOrTs = hint === 'flv' || hint === 'ts' || /\.(flv|ts)(\?|$)/i.test(url)`
- 上游 `dash.js:365`：`const isFlv = /\.flv(\?|$)/i.test(url)`
- 影响：若某条 durl 以 `.ts` 结尾，还原会走 mpegts.js（`type:'flv'`），上游则直接 `video.src`。B 站 durl 实际是 `.mp4`，触发概率极低；且还原的路径通常更能播。
- 建议：保留，但在注释里标注"故意扩大"。

#### L2 自动播放被拦的状态/文案不同
- 还原 `dash.ts:617-619`：`this.hooks.onState?.('paused', '自动播放被拦截，点击画面开始播放')`
- 上游 `dash.js:355-359`：`this.hooks.onState && this.hooks.onState('blocked')`
- 影响：`VideoView.vue:846-856` 的 `onState` 只做 `waiting→缓冲中…`、`playing→清空`、`paused && message → status=message`、其它无副作用，两边都不会误判 `playing`；还原多显示一句提示，上游 `blocked` 只被 MiniPlayer 消费（还原改用 `load()` 后的 `paused` 探测 + `blocked.value`，见 `MiniPlayer.vue:219-226`）。等价。

#### L3 内核事件集更丰富
- 还原 `dash.ts:507-527`：`timeupdate`→`onTime` + `emitBuffer`；`durationchange`→`onDuration` + `onTime`；`progress`→`emitBuffer`；`ended`→`onEnded` + `onState('ended')`；`waiting`→`onState('waiting','缓冲中…')`
- 上游 `dash.js:262-289`：`timeupdate`→`onProgress`；`ended`→仅 `onEnded`；`waiting`→`onState('waiting')`（无参）
- 影响：`VideoView` 的 `status` 因此多一条路径得到 `缓冲中…`（上游是在视图 `:618-619` 自己写），`MiniPlayer` 用 `state === 'ended'` 收尾（上游用 `onEnded` 回调）。行为等价，钩子契约变了（`onProgress`→`onTime`、`onState` 允许带 message），已在 `dash.ts:20-26` 注释里声明。

#### L4 末次 flush 失败时 AbortController 残留
- 还原 `dash.ts:1092`：`if (await flush()) this.aborts.delete(abort)`
- 上游 `dash.js:825-827`：`if (!(await flush())) return appended`（失败提前返回，同样没 delete）+ 成功路径 delete
- 影响：flush 失败意味着这条流的结束态，控制器留到下一次 `teardownMedia()`（`:1385-1391` 全量 abort + clear）才清；上游在该分支同样泄漏。差异仅"哪个分支漏"，无实际后果。

#### L5 Quota 重试前少一次 `sleep(120)`
- 还原 `dash.ts:1141-1146`：`await this.evict(Math.max(10, BUFFER_AHEAD + 15 - attempt * 20))` 之后直接 `for (; sb.updating; ) await waitUpdate(sb, 3000)`
- 上游 `dash.js:870-880`：`evict(...)` → 再判 gen/`sb` → `await sleep(120)` → 再等 `updating`
- 影响：`waitUpdate` 本身就等 `updateend`，`sleep(120)` 只是给 remove 的区间合并留余量；重试次数上限同为 2，最坏情况是第一次重试仍抛 Quota 后再淘汰一次。可忽略。

#### L6 直连流的状态文案位置
- 还原 `dash.ts:632-633`：`status('使用直连流播放')` 只在"非 flv/ts"分支；flv/ts 分支不写
- 上游 `dash.js:364`：进函数即写
- 影响：flv/ts 直链时状态栏保留上一条文案（例如 `正在获取播放地址…`，会被随后 `load()` 的完成与 `onState('playing')` 覆盖）。低。

#### L7 MiniPlayer 的钩子没有 `myGen` 守卫，但用 `if (!player) return` 等价兜住
- 还原 `MiniPlayer.vue:128-151`：每个回调开头 `if (!player) return`
- 上游 `MiniPlayer.vue:150-178`：每个回调比对 `myGen !== gen`
- 影响：`stop()`（`:100-112`）里 `player.destroy(); player = null`，旧回调必然命空返回，效果等价；差别只在"旧实例还被引用但 gen 已过期"的极端竞态。可忽略。

#### L8 字幕解析不再有独立模块
- 还原：全部内联 `app/src/views/VideoView.vue:301-445`（`SUB_EXTS/subExt/decodeBytes/parseSubTime/cleanSubText/pushCue/parseSrtVtt/parseAss/parseSubtitle`），`app/src/utils/` 下只有 `format.ts`
- 上游：`renderer/src/utils/subtitle.js`，导出 `SUB_EXTS/subExt/isSubtitleFile/decodeSubtitleBytes/parseSubTime/parseSubtitle`
- 影响：解析逻辑无法被其他视图（如未来的本地字幕预览、单元测试）复用，改一处要复制。**建议**把它提回 `app/src/utils/subtitle.ts`，`VideoView` 改 import —— 与 SPEC 的"结构可读"目标一致，且能顺手给解析加测试。

#### L9 MiniPlayer 丢了 `window.__tapLog` 埋点
- 还原 `MiniPlayer.vue:384-391`（`tap()` 只做 `dragging` 过滤 + 500ms 去重）
- 上游 `MiniPlayer.vue:332-349`（额外 `window.__tapLog = {...}`）
- 影响：仅调试可观测性；行为一致。

#### L10 MiniPlayer 图标名替换
- 还原 `MiniPlayer.vue`（`name="expand"`）；上游 `MiniPlayer.vue:447` `<Icon name="size" />`
- 影响：上游 `icons.ts` 无 `size` 键 → APK 里是空格子；还原显示"放大"图标。属修 bug，视觉上与原 APK 略有差异。

#### L11 播放页模板里"无法打开"面板的位置
- 还原 `VideoView.vue:1655-1658`：`.watch` 在前、`<EmptyBlock v-else ...>` 收尾
- 上游 `VideoView.vue:1023-1028`：`EmptyBlock v-else-if="!view"` 在前、`.watch` 用 `v-else-if="view"`
- 影响：条件互斥，最终渲染结果相同（`loading` → 错误 → 内容）。纯结构差异。

#### L12 视图层命名整体改写
`statusText→status`、`view→detail`、`pageList→pages`、`currentTime→current`、`isPlaying→playing`、`speed/ccList/ccLan/ccOff/localKey/localSubs→rate/onlineSubs/subLan/subOff/localSubKey/localSubs`、`errSplit→errHuman`、`streamDiag→diagLine`、`actualQuality→trackQuality`、`quality→playurlQuality`、`qnLabel→qualityName`、`fmtDuration→formatClock`、`fmtDate→formatDateTime`、`parseDuration→parseSec`（`utils/format.ts:39-56` 与上游 `format.js:35-49` 逐行等价，含 `!n → '—'` 与秒/毫秒判定 `<1e12`）。行为一致，检索时需按新名字找。

---

## 4. 常量对比表（全部 magic number）

| 语义 | 还原（`app/src/...`） | 上游（`/tmp/up043/...`） | 值 | 一致 |
|---|---|---|---|---|
| 首次 Range 探测字节 | `player/dash.ts:116` `PROBE_BYTES` | `player/dash.js:15` `HEAD_PROBE_BYTES` | 65536 | ✅ |
| 前向缓冲高水位（背压） | `dash.ts:118` `BUFFER_AHEAD` | `dash.js:17` `AHEAD_MAX` | 45 s | ✅ |
| （上游死常量） | — | `dash.js:18` `AHEAD_MIN` | 18 | 未复刻 |
| 视频攒批字节 | `dash.ts:120` `VIDEO_CHUNK` | `dash.js:22` `BATCH_VIDEO_BYTES` | 512 KiB | ✅ |
| 音频攒批字节 | `dash.ts:121` `AUDIO_CHUNK` | `dash.js:23` `BATCH_AUDIO_BYTES` | 128 KiB | ✅ |
| 攒批最长等待 | `dash.ts:123` `FLUSH_MS` | `dash.js:24` `BATCH_MS` | 300 ms | ✅ |
| 首包超时（换线） | `dash.ts:125` `FIRST_CHUNK_TIMEOUT` | `dash.js:26` `FIRST_BYTE_TIMEOUT` | 8000 ms | ✅ |
| 单次 fetch 超时 | `dash.ts:127` `FETCH_TIMEOUT` | `dash.js:1032+`（`fetchBytes` 内 `setTimeout`） | 8000 ms | ✅ |
| sourceopen / 首缓冲 / 事件等待 | `dash.ts:129` `EVENT_TIMEOUT`；`:711` `waitFirstBuffer(gen, EVENT_TIMEOUT)` | `dash.js:67` `waitEvent(...,8000)`；`:460-470` `waitFirstBuffer(...,8000)` | 8000 ms | ✅ |
| `updateend` 等待 | `dash.ts:143` `waitUpdate(sb, timeout = 5000)` | `dash.js:39` 同 | 5000 ms | ✅ |
| evict 期间等待 | `dash.ts:1184/1199/1204` | `dash.js:922/941/947` | 3000 ms | ✅ |
| 首缓冲轮询间隔 | `dash.ts:740` `sleep(120)` | `dash.js:467` | 120 ms | ✅ |
| 背压轮询间隔 | `dash.ts:1055` `sleep(220)` | `dash.js:791` | 220 ms | ✅ |
| 自动播放重试 | `dash.ts:803` `ensurePlaying(gen, tries = 6)`、`:812` `sleep(400)` | `dash.js:521` `tries = 6`、`:531` `sleep(400)` | 6 次 / 400 ms | ✅ |
| 元素错误重连上限 | `dash.ts:820` `recoveries >= 2` | `dash.js:543` | 2 次 | ✅ |
| 重连前等待 | `dash.ts:832` `sleep(600)` | `dash.js:555` | 600 ms | ✅ |
| 重连起点阈值 | `dash.ts:835` `at > 2 ? at : 0` | `dash.js:558` | 2 s | ✅ |
| jumpWhenBuffered 轮次/间隔 | `dash.ts:1239/1247` | `dash.js:982/992` | 160 × 120 ms（≈19.2 s） | ✅ |
| ahead 判定窗口 | `dash.ts:1218` `start-1 / end+30` | `dash.js:962` | −1 / +30 s | ✅ |
| isBuffered 容差 | `dash.ts:1227`、`:1231` | `dash.js:969` `pad = 0.4`、`:971` `end-0.25` | 0.4 / 0.25 s | ✅ |
| 末尾夹取 | `dash.ts:1256` `at > total - 0.4` | `dash.js:1002` `t > total - 0.4` | 0.4 s | ✅ |
| 缓冲文案节流 | `dash.ts:1081` `> 500` | `dash.js:814` `> 500` | 500 ms | ✅ |
| evict 保留区间 | `dash.ts:1178` `keepAhead = BUFFER_AHEAD + 15`、`:1180` `now - 5` | `dash.js:918` `AHEAD_MAX + 15`、`:920` `now - 5` | 60 s / −5 s | ✅ |
| Quota 时保留区间 | `dash.ts:1141` `Math.max(10, BUFFER_AHEAD + 15 - attempt*20)` | `dash.js:870` `Math.max(10, AHEAD_MAX + 15 - attempt*20)` | 10 起，每次 −20 | ✅ |
| Quota 重试上限 | `dash.ts:1139` `attempt >= 2` | `dash.js:867` | 2 次 | ✅ |
| Quota 重试前间隔 | 无 | `dash.js:873` `sleep(120)` | 120 ms | ⚠ L5 |
| sidx 重探字节 | `dash.ts:942` `PROBE_BYTES*8-1` | `dash.js:674` | 512 KiB−1 | ✅ |
| 可接受时长窗口 | `dash.ts:579` `v > 3 && v < 86400` | `dash.js:326` 同 | (3, 86400) s | ✅ |
| 播放页：倍速档 | `VideoView.vue:145` `RATES` | `SPEEDS` | 0.5/0.75/1/1.25/1.5/2 | ✅ |
| 播放页：字幕字号 | `:167-172` `FONT_SIZES` | `SUB_SIZES` | 18/22/26/32 | ✅ |
| 播放页：字幕位置 | `:174-178` `SUB_BOTTOMS` | `SUB_POS` | 8/30/55 % | ✅ |
| 播放页：进度条 tick | `:952-990` 1000 ms / 5000 ms | 同 | 1 s / 5 s | ✅ |
| 播放页：上报节流 | `:1019` `completed > 0.95`；`:977` `\|Δ\| < 2 s` 跳过 | 同 | 0.95 / 2 s | ✅ |
| 播放页：累计满 10 s 落库 | `:962` `>= 10` | 同 | 10 s | ✅ |
| 播放页：自动打卡阈值 | `:937` `watchedSeconds < 300` | `:706` `watchedTotal < 300` | 300 s | ✅ |
| 播放页：控制栏自动隐藏 | `:602` `2800` | 同 | 2800 ms | ✅ |
| 播放页：音量落盘阈值 / 键盘步长 | `:1146` `> 0.05`；`:1217` `±0.05` | 同 | 0.05 | ✅ |
| 播放页：清晰度锁档 | `:202-205` `qn >= 80 && cur > 0 && cur <= 480` | 同 | 80 / 480 | ✅ |
| 字幕：单文件上限 | `bridge/android.ts` `SUBTITLE_MAX_BYTES` | `mobile/bridge.js:86` `SUB_MAX_BYTES = 8*1024*1024` | 8 MiB | ✅ |
| 字幕：在线轨上限 | `bridge/api.ts:1193` `tracks.slice(0, 5)` | `main/bili/danmaku.js:113` | 5 条 | ✅ |
| 字幕：拉取超时 | `api.ts:1197` `timeout: 15000` | `danmaku.js:117` | 15000 ms | ✅ |
| 字幕：当前行兜底时长 | `VideoView.vue:283` `hit.to \|\| hit.from + 8` | 上游 `activeCc` 同 | +8 s | ✅ |
| MiniPlayer：吸边/尺寸余量 | `MiniPlayer.vue:73-89`（8px；`h = size.h + 30`） | `:57-68` | 8 / 30 | ✅ |
| MiniPlayer：初始右下偏移 | `:393-402`（`w-26 / h-110`） | `:383-393` | 26 / 110 | ✅ |
| MiniPlayer：自动续播 | `:288-298` 3 次 / 1500 ms | `:265-274` | 3 / 1500 | ✅ |
| MiniPlayer：卡死判据 | `:281-284` 1200 ms 后 `currentTime` 未动 → 重载 | `:259` | 1200 ms | ✅ |
| MiniPlayer：点击去重 | `:386-391` 500 ms | `:337-349` | 500 ms | ✅ |
| MiniPlayer：静音兜底音量 | `:325-334` `<= 0.01 → 0.8` | `:295-304` | 0.8 | ✅ |
| PartList：列表高度上限 | `PartList.vue:162` `clamp(373px,56vh,560px)` | `PartList.vue:148` 同 | — | ✅ |
| PartList：出筛选框阈值 | `PartList.vue:99` `parts.length > 12` | `PartList.vue:84` | 12 | ✅ |

---

## 5. 未能验证部分（无真机 / 无网络）

1. **Range/sidx 真实行为**：`bilibili` 的 `upos` / `mcdn` 节点对 `bytes=0-65535` 是否恒返回 206、`sidx` 是否落在头 64 KiB 内，只能靠代码路径推断；无法实测"64 KiB 拿不到 → 512 KiB 重探 → 仍无 → 换线"的三级回退。
2. **mcdn 首包延迟**：上游注释称 mcdn 首包可能十几秒、8 s 首包超时是必要兜底；还原把 mcdn 排到最后（`:247-254`）与上游一致，但真实排序收益无法验证。
3. **QuotaExceededError 与 Chromium SourceBuffer 上限**：`recreateMedia` 的动机（同一 MediaSource 的 SourceBuffer 创建总次数上限）与"evict 后仍失败"的临界值只能在真机复现。
4. **安卓 WebView 的 MSE 编解码支持**：`MediaSource.isTypeSupported('video/mp4; codecs="hev1..."')` 在目标机型上的结果未知，所以 `avc1` 优先策略的实际命中率无法量化。
5. **mpegts.js 分支**：`import('mpegts.js')` 是否已在 `package.json` 依赖里、APK 产物里是否真的存在该 chunk，本次未验证（只核对了调用形式与参数）。
6. **`wasPlaying` 退化的用户可感程度**（M1）：需要真机/浏览器手动复现"暂停后拖动进度条"与"暂停中触发 media error"两条路径。
7. **PartList 首屏定位**（M2）：需要 `pageIndex > 0` 且列表高于容器（>11 P）才可见；未在真机验证。
8. **字幕 GB18030 回退**：`TextDecoder('gb18030')` 的存在性与安卓 WebView 支持情况未实测；仅代码等价。
9. **字幕与播放的时序**：`subCidLoaded` 防串 P 在"快速连点分P"下的表现未做压力验证。
10. **学习记录上报落库**：`learn.addSeconds/save` 与 Dexie 事务在切后台/杀进程时的边界未验证。

---

## 6. 附：核对方法

1. 先读 `CONTRACT.md` 确认"app/ 为可继续开发源码、行为一致优先、`styles/global.css` 与 `styles/recovered/*.css` 为原始产物"。
2. 逐文件对读：先在上游按函数切块（`grep -n "^  [a-zA-Z]*("` 出方法行号），再到还原侧按同名/同职责函数对读，重点比 **常量值、条件顺序、catch 分支、清理顺序**。
3. 对"行为一致性"敏感的点（选轨排序、sidx 边界、evict 区间、钩子契约、字幕正则）做双侧重引，逐字符比对正则与比较链。
4. 对组件只核 `defineProps/defineEmits` 的键、默认值、emit 参数、模板里的条件与文案、CSS 关键类名。
5. 桥接层核对 handler 键表、默认值（`qn || 80`、`segment || 1`）、信封字段（`ok/data/message/code/needLogin`）、错误文案。
6. 全程只读：未写入 `/root/学习软件`；本报告是唯一产物。
