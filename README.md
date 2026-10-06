# StudyBili · 学习 B 站

学习专注型的 B 站桌面客户端（Windows / Electron）。参考 [BiliLite](https://github.com/ywmoyue/biliuwp-lite) 的功能取舍重新实现：
保留**扫码登录、UP 管理、首页（只看关注 UP 更新）、搜索、视频播放（分 P / 画质 / DASH）、本机收藏 + B 站收藏夹、UP 主主页、学习记录 / 打卡 / 番茄钟**，
界面走黑白极简 token 体系，不引入娱乐化的信息流。播放页右栏只留「清晰度 + 分P列表」（相关推荐只在下方 tab 里）。

> 仅限个人学习用途。本项目不提供任何视频内容，只做本机客户端；登录凭证只加密保存在本机。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面壳 | Electron 33（`contextIsolation: true`、`nodeIntegration: false`、preload + `contextBridge`） |
| 渲染层 | Vue 3 + vue-router 4（hash 路由，适配 `file://`）+ Pinia |
| 构建 | electron-vite 2 / Vite 5；`electron-builder` 打包 NSIS |
| 播放 | 自研 MSE 播放器（DASH fMP4：`sidx` 定位 + 双 SourceBuffer + 背压/配额淘汰），FLV 走 `mpegts.js` |
| 本机数据 | Dexie（IndexedDB）存学习记录；主进程 `store.json` 存设置与加密 Cookie |

## 目录结构

```
src/
  main/                     主进程
    index.js                窗口、单实例、网络钩子（注入 Referer / 放开 CORS）
    ipc.js                  IPC 通道注册（统一 { ok, data | message, code, needLogin } 信封）
    store.js                设置 + 登录态持久化（Cookie 走 safeStorage 加密）
    smoke.js                端到端冒烟测试（见下文）
    bili/                   B 站接口：http / wbi 签名 / auth / home / video / search / fav / space
  preload/index.js          window.bili 白名单桥接
  renderer/
    index.html              含 CSP meta
    src/
      router.js  App.vue     布局（侧栏 5 项 + 顶栏搜索；侧栏不再放搜索入口）
      api/index.js           window.bili 门面
      db/index.js            Dexie：progress / daily / notes / shelf / ups / collect / checkins / upTime
      stores/                ui / settings / auth / learn / ups / collect / pomodoro
      player/dash.js         DASH 播放核心
      views/                 Home / UpManage / Search / Video / Fav / FavFolder / Up / Learn / Settings
      components/            Icon / BiliImage / VideoCard / Pager / DanmakuLayer / PageFloat / LoginModal / ConfirmModal / CollectModal / PartList …
```

## 本地开发与运行

```powershell
pnpm install          # .npmrc 已指向 npmmirror 镜像
pnpm run dev          # electron-vite dev（HMR）
pnpm run build        # 只构建到 out/
pnpm run start        # 预览已构建产物
```

打包（Windows）：

```powershell
pnpm run package      # build + electron-builder --win --dir → release/win-unpacked/StudyBili.exe（免安装，直接跑）
pnpm run dist         # 生成 NSIS 安装包 → release/StudyBili Setup 0.1.0.exe
```

> 本机 `%TEMP%` 不可写，`pnpm run dist` 需要先把 `TEMP`/`TMP` 指到工作区内可写目录，否则
> electron-builder 在生成卸载器阶段会以 `Exit code: 2` 失败：

```powershell
New-Item -ItemType Directory -Force -Path .\tmp-temp | Out-Null
$env:TEMP = "$PWD\tmp-temp"; $env:TMP = "$PWD\tmp-temp"
pnpm run dist
```

### 运行方式（重要：不要在本 DSH 工作区目录里启动）

| 入口 | 路径 | 实测 |
| --- | --- | --- |
| 桌面快捷方式「学习B站」 | `%USERPROFILE%\Desktop\学习B站.lnk` → `%LOCALAPPDATA%\Programs\StudyBili\StudyBili.exe` | 正常打开窗口「首页 · 学习 B 站」 |
| 安装版 | `%LOCALAPPDATA%\Programs\StudyBili\StudyBili.exe` | 正常 |
| 免安装便携版（已复制到桌面） | `%USERPROFILE%\Desktop\StudyBili\StudyBili.exe` | 正常，双击即可，无需任何参数 |
| 安装包副本（已复制到桌面） | `%USERPROFILE%\Desktop\StudyBili-Setup-0.1.0.exe` | `Start-Process -ArgumentList '/S'` → ExitCode 0 |

**不要把 `release\win-unpacked\StudyBili.exe`（或 `release\` 里的安装包）在 DSH 工作区目录内双击**：
在 `C:\Users\zouyx\Desktop\学习APP` 内启动的 Electron 进程会在 Chromium 初始化之前就终止，窗口不出现 ——
表现为 `-2147483645`（0x80000003 STATUS_BREAKPOINT）、`-36861`（0xFFFF7003，stderr 只有
`crashpad_client_win.cc(868) not connected`）或静默 `EXIT=0`；连只写日志的最小 Electron 探针都在执行任何 JS 之前崩溃。
把**同一份文件**（SHA256 相同）复制到工作区外，双击即可正常运行，不需要任何命令行参数。

已排除的原因：`ELECTRON_RUN_AS_NODE` 泄漏、文件/目录权限（工作区外进程可正常读写该目录）、工作目录、
目录联接路径、Chromium/GUI 整体不可用（同机 `notepad`、`msedge`、`electron.exe --version` 在工作区外均正常）。
这是本机 DSH 沙箱 + 云电脑环境的现象，与程序代码无关。

### 本机（DSH 沙箱）注意事项

这台机器上 `node` / `pnpm` 不在 `PATH`，且环境变量 `ELECTRON_RUN_AS_NODE=1` 会让 Electron 退化成 Node：

```powershell
$env:PATH = 'C:\Users\zouyx\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;' + $env:PATH
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
node 'C:\Users\zouyx\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs' run package
```

在 DSH 终端里（也就是在工作区目录内）启动 GUI 才需要 `--no-sandbox`（本机内核下 Chromium 沙箱无法初始化，
否则直接 ACCESS_VIOLATION），并且要显式指定一个可写的 userData 目录；按上文表格放到工作区外启动则两者都不需要：

```powershell
# 已构建产物（等价于 electron-vite preview，但能带上沙箱与 userData 参数）
& cmd /c "`"$PWD\node_modules\electron\dist\electron.exe`" . --no-sandbox --disable-gpu --user-data-dir=`"$PWD\tmp-userdata`""

# 打包后的免安装版本
& cmd /c "`"$PWD\release\win-unpacked\StudyBili.exe`" --no-sandbox --user-data-dir=`"$PWD\tmp-userdata`""
```

在普通 Windows 机器上不需要这些参数，`pnpm run dev` / `pnpm run start` 直接可用。

## 验证

主进程内置端到端冒烟测试（真实窗口里跑完整闭环：桥接 → 接口 → 播放起流/推进 → 落库 → 5 个路由），
报告写到 `$env:STUDY_SMOKE_OUT`，退出码为失败项数：

```powershell
$env:STUDY_SMOKE = '1'
$env:STUDY_SMOKE_OUT = "$PWD\smoke-pkg-report.txt"
$env:STUDY_USER_DATA = "$PWD\tmp-userdata-pkg"
$env:STUDY_SMOKE_SHOT = "$PWD\shots"   # 可选：顺手把真实界面截图存下来
& cmd /c "`"$PWD\release\win-unpacked\StudyBili.exe`" --no-sandbox --disable-gpu --autoplay-policy=no-user-gesture-required > smoke-pkg.out 2>&1"
Get-Content smoke-pkg-report.txt -Encoding UTF8
```

断言项：bridge 注入/通道齐全/`app:ping`、侧栏 5 项、侧栏不再有「搜索」入口（搜索只保留顶栏）、主题令牌、`home.feed`、`search.videos`、`video.view`、
`video.playurl`（DASH 轨道）、视频页渲染、`<video>` 起流（`readyState=4`）、点播放后 `currentTime` 前进、
学习进度写入 IndexedDB、顶栏搜索跳转、侧栏 5 个路由真实点击可达，以及本机 UP 名单（写入/渲染/首页只显示名单）、
`up.latest`（匿名可拉取，失败才软跳过）、本机收藏写入、学习页 5 卡 / 371 格签到日历 /
近 14 天条形图 / 按 UP 分布饼图、手动打卡写入 `checkins`、番茄钟（学习页有 `.pomo-clock`；改「专注」为 1 分钟后
开始 → 倒计时前进；暂停 → 倒计时不动；跑完一轮 → 自动进入短休息、`今日完成 1 个`、toast「番茄钟完成」且
顶栏「今日」时长增加）、UP 主页投稿列表（同一接口，含分页 `count`）、
右侧悬浮操作组、页面确实可上下滚动（`.scroll` 的 `scrollHeight > clientHeight`）、下拉后出现「顶部」并点回顶部、
「换一换」后页面重新渲染、切换页面自动回到顶部（先在长列表拉到 480/1224px，再进视频页 `scrollTop=0`）、
控制栏含倍速/字幕/静音/全屏控件、播放页右栏没有「相关推荐」（`.watch > aside .panel` 里没有它，但 tab 栏仍保留）、
播放页已移除弹幕/画中画/在线人数 UI（`.dm-bar`、`.dm-layer`、画中画按钮、
「N 人正在看」四者都不存在）、视频轨按画质挑选（`[dash] picked quality` 的 `got` 与按 `playurl.quality`
推算出的轨道一致）、「当前清晰度」显示实播画质（清晰度面板的 `.muted` 文本与 `.chip.on` 都是实播档位）、
倍速切换生效（点 2x → `video.playbackRate === 2` → 还原）、字幕菜单能打开、
播放中不显示「缓冲中」遮罩（视频推进后 `.player-msg` 必须已消失）、
跳转后能继续播放（目标点按已知总时长给：`dur > 10` 时取 `min(120, dur * 0.6)` —— 短视频硬跳 120 秒会落到片尾之外，
那是无效目标而不是播放器卡死；断言 `readyState ≥ 3`、`currentTime` 落在目标附近并继续推进、遮罩已消失；
再单独一条 `跳转走 ranged 起流（sidx 定位）`：`[dash] streamFrom video offset=<≥5 位数>`，CDN 不配合时降级为 WARN）、
分P列表带分P标题（`.pages-list .page-pill` 里 `.pn` 必须形如 `P2`、`.pt` 非空、`title` 属性非空、`.on` 恰好一行、
「正在播放」行不含 `undefined`；要指定视频验收就设 `STUDY_SMOKE_BVID=<bvid>`，实测用 `BV1cu411r7pw` 分P 177 通过）、
分P列表可按关键字筛选（分P > 12 时出现 `.pages-filter`，输入「单词」后行数变少：177 → 48）。

> 主题验收：设置 `STUDY_SMOKE_THEME=light`（或 `dark`）会让冒烟把主题强制成对应主题再跑一遍，
> 每次截图前也会重新强制一次 —— `settings.init()` 是异步的，完成时会按落盘设置把主题刷回来，
> 只在开头强制一次会偶发截到默认主题（浅色下的浅色描边/留白问题要靠它才看得出来）。
> 强制主题时会**连强调色一起换**：`--accent` / `--accent-fg` 是 `settings.applyTheme()` 按「预设 × 主题」
> 内联写到 `<html>` 上的（见 `src/renderer/src/stores/settings.js` 的 `ACCENT_PRESETS`），只改 `data-theme`
> 不会重算它们 —— 否则浅色下 `--accent` 还停在深色主题的 `#ffffff`，白底白字会把截图和断言都带偏
> （第一版分P列表「当前 P 高亮」就这么被拍成了白底白字）。截图前还会多等 400ms 让带 transition 的
> 控件（`.input` / `.btn` / `.page-pill`）过渡完，不然会拍到半路的灰底。
> 另外把 `study-bili.json` 预写进 `STUDY_USER_DATA` **不管用**：应用启动时会 persist 默认设置把它覆盖掉。

> 冒烟断言的时序坑：`.scroll` 是 `scroll-behavior: smooth`，滚动是**动画**，`el.scrollTop = el.scrollHeight` 之后
> 固定等 700ms 在机器忙时不够（曾出现「页面可上下滚动」PASS 但「下拉后出现顶部按钮」FAIL 的假失败）。
> 现在统一用 `el.scrollTo({ top: el.scrollHeight, behavior: 'instant' })` 绕开 CSS 动画，
> 再「最多 10×300ms 轮询」等按钮出现，并打印 `{top, scrolls, btns, disp, op, seen, shown}` 诊断。
>
> 另一个坑（已修）：右侧悬浮「顶部」按钮最初**只**依赖 `scroll` 事件更新状态，而且用的是**挂载时缓存**的
> `.scroll` 节点。实测出现过「页面已滚到 1637px，按钮 `display` 仍是 `none`」（缓存节点被换页替换，或
> 整批滚动事件没送到）。现在 `PageFloat.vue` 每次事件都重新定位容器（`isConnected` 校验）、在容器上直接
> 绑定 `scroll`，并加 400ms 轮询兜底 —— 状态一定跟得上滚动位置。
>
> 时长坑（已修）：MSE 必须显式给 `MediaSource.duration`，否则 Chromium 进不了 `HAVE_METADATA`（缓冲涨到
> 30s、画面永远「缓冲中…」，`video.duration` 是 `NaN`）。而有的视频 playurl 返回的 `dash.duration` 是
> **垃圾小值**（实测 1000ms），照它设反而会让 Chromium 丢掉超出该时长的所有帧（`buffered` 一直是 empty）。
> 现在 `dash.js` 只在「> 3s 且 < 24h」时才采用 payload 时长，否则用页面给的 `setDurationHint()`（投稿信息里的
> 时长），再不行先给 `Infinity`，等整条轨拉完由 `settleDuration()` 用 `buffered.end()` 修回真实时长。
>
> 另一个坑：环境变量 `ELECTRON_RUN_AS_NODE=1` 会让 `StudyBili.exe` 退化成 Node，报
> `StudyBili.exe: bad option: --no-sandbox`（退出码 9，也不写报告）。跑打包版冒烟前先
> `Remove-Item Env:ELECTRON_RUN_AS_NODE`。

> 播放遮罩坑（已修）：MSE 欠载时元素先发 `waiting`，恢复时 Chromium **只补发 `playing`**（不会再发一次 `play`）。
> 播放器原来只听 `play`，于是 UI 的 `isPlaying` 被 `waiting` 置为 false 后再也回不来 —— 播放页里那个
> `<div v-if="statusText && !isPlaying" class="player-msg">` 遮罩就永远盖在画面上，配着「缓冲中… 已加载 XXMB」
> 文字，看起来像一直在缓冲（其实 `currentTime` 正常前进）。修法：`dash.js` 同时监听 `play` 与 `playing`；
> 那句话也改成只在真的欠载（`readyState < 3` 或暂停）时才刷新、500ms 节流，画面一恢复立刻清空。
>
> 续流坑（已修）：`tryRangedStart()` 里探测失败原本直接 `return false`（等于「第一条线路不通过就整段放弃」），
> 而且只把**探测成功的那一条** URL 带进 `streamFrom()`；更糟的是 `streamFrom()` 无论成功失败都返回 `undefined`，
> 调用方拿不到结果，于是「续流其实失败了」也会被当成成功、不回退到「从 0 顺序拉」——表现出来就是一直空转/缓冲。
> 现在：探测失败/非 206/64KB 里找不到 `sidx` 都只是**换下一条备用线路**（`sidx` 找不到会把探测范围放大到 512KB
> 再试一次），续流时带着剩余备用地址，`streamFrom()` 返回「是否真的 append 过」，据此决定换线路还是回退到 0。
>
> `sidx` 解析错位坑（已修，是「续播/拖进度条要重新拉几十 MB」的真根因）：`parseSidx()` 拿着 sidx box 的 body
> 直接当 `reference_ID` 开始读，**漏掉了 fullbox 头的 4 字节（version 1 + flags 3）**，于是整段错位 4 字节 ——
> `reference_count` 正好读到 reserved 的 `0`，函数永远返回 `null`（"no-sidx"）。而 playurl 的 SegmentBase 明明
> 写着 `initialization=0-934, index_range=935-3530`，文件头也确实是 `ftyp@0 moov@32 sidx@935 moof@3531 mdat@5435`。
> 结果就是**任何**续播/拖动进度条都定位不了，只能从 0 顺序重拉（长视频前半段几十 MB 全下完才开始播，看着就是
> 「一直在缓冲」）。修好后实测同一视频：`[dash] ranged sidx refs=515 initEnd=7156`、
> `streamFrom video offset=10941634 status=206`，跳到 120s 立即从 10.9MB 处续流并正常播放。
>
> 音视频一起定位坑（已修）：续流定位必须**两条轨一起成功**（`startStreams()` 先并行 `probeRanged()`，两者都有
> `sidx` 才一起按偏移续流），否则只有一条轨跳到中途、另一条从 0 顺序拉，当前播放位置就缺一半数据，播放会直接
> 卡死。任一轨定位失败就两条一起从 0 顺序拉（`usedFallbackFromZero`）。
>
> 中段 Range 被忽略坑（已修）：即使 `sidx` 解析出偏移，也不能假定 CDN 认这个 Range —— 实测打包版里
> `upos-sz-mirrorcoso1` 对 `bytes=7288735-` 直接回 **200（整个文件）**，同一条音轨回 **416**。旧逻辑会把
> 200 的响应体当成「从 offset 开始」的数据 append 进 SourceBuffer，得到的是错位数据：`buffered` 为空、
> `currentTime` 停在跳转目标、`readyState` 掉回 1（第 9 行那条断言就是这么假失败/真卡住的）。
> 现在 `streamFrom()` 见到「`offset > 0` 但不是 206」就换线路、不 append；两条轨的续流只要有一条没成，
> 就**连 MediaSource 一起换一个新的**再从 0 顺序拉，并按目标位置等缓冲覆盖到位后跳过去。
>
> SourceBuffer 数量上限坑（已修）：回退时最初只想「换一对 SourceBuffer」，但 Chromium 对**同一个 MediaSource
> 上创建过的 SourceBuffer 总数**有上限，`removeSourceBuffer()` 不会把额度还回来 —— 实测第二次 `addSourceBuffer()`
> 直接报 `This MediaSource has reached the limit of SourceBuffer objects it can handle. No additional SourceBuffer
> objects may be added.`，回退路径整个失效（元素停在 `paused`、`buffered` 为空）。现在改成 `recreateMedia()`：
> `teardownMedia()` 后重建 MediaSource + objectURL + `el.src`（`setupMedia()` 与首次起流共用同一段代码）。
>
> 媒体元素 error 坑（已修）：`<video>` 一旦进入 error 状态，之后每次 `appendBuffer()` 都会抛
> `InvalidStateError: The HTMLMediaElement.error attribute is not null`，数据再也进不去 —— 表现就是画面冻在某一帧、
> 一直「缓冲中…」（实测在推荐流某条视频上偶发：`readyState` 掉到 2、`buffered` 停在 0.81s）。现在 `dash.js` 监听
> `error`，自动从当前进度（`<3s` 就从头）重建流重连，最多 2 次；仍失败才把错误显示到界面上。
>
> 恢复播放坑（已修）：`openDash()` 会重建 MediaSource（元素被重置成 `paused`），而 `streamFrom()` 要等整条轨拉完
> 才 resolve，所以「重建完再 play」不能挂在流后面。现在统一用 `this.wasPlaying`（`play()`/自动播放置 true、
> `pause()` 置 false）作为「用户想在播」的唯一依据，`ensurePlaying(gen, tries)` 反复确认到元素真的回到播放状态
> （`play()` 可能被 Interrupted 拒绝）；用户主动暂停着拖进度条不会被自动拉回播放。
>
> 选轨坑（已修）：没有匹配画质时原来只按 bandwidth 降序挑，实测有视频 **360P 的 bandwidth（872kbps）反而高于
> 480P（851kbps）**，于是挑到更糊的那条。现在排序是「编码兼容性 → 分辨率（宽×高）降序 → 带宽降序」，
> 冒烟里的 `expectVideoTrack()` 用同一套规则对照。
>
> 分P字段坑（已修）：主进程 `src/main/bili/video.js` 归一化分P时只输出 `part`（B 站 pagelist 的字段名），
> 而界面 `src/renderer/src/views/VideoView.vue` 读的是 `p.title` —— 于是右栏分P按钮渲染成「P1 ·」、
> 标题行显示「正在播放：P1 undefined」（用户反馈的「分p列表没有分P标题」）。现在主进程统一补 `title`
> （`part` 保留），界面一律 `p.title || p.part` 兜底。
>
> 多分P合集时长坑（已修）：分P视频的 `web-interface/view.duration` 是**整部合集**总时长（实测新概念英语第二册
> `146592`s），拿它当单P时长会让进度条显示 `0:00`、续播判断全错。现在 `startPlay()` 优先用 pagelist 里当前 P 的
> `duration`（实测 P1 = 868s），`startSeconds()` 的「已经看到片尾就别续播」也按单P时长判断。
>
> seek 越界坑（已修）：从长视频的进度续播到一个更短的分P（或冒烟硬跳 120s 而该 P 只有 75s）时，播放器会去请求
> 片尾之外的字节、拿到 416 后卡在「缓冲中…」。现在 `dash.js` 的 `onSeeking()` 先看已知总时长：
> `t > total - 0.4` 就夹到末尾收工，不做注定失败的 ranged 定位。
>
> 后台定时器限流坑（已修）：窗口被挡住/最小化时 Chromium 会限流定时器，番茄钟 250ms tick 在冒烟里几乎不走
> （实测 60s 只走了 10s，断言「专注结束」假失败），播放器同理会让「暂停拉流」判断失准。现在主进程窗口设
> `webPreferences.backgroundThrottling: false`，番茄钟另外监听 `visibilitychange`，页面重新可见时补一次 `tick()`。
>
> 冒烟期防关窗（已修）：测试跑一半窗口被点掉会走 `window-all-closed` → `app.quit()`，报告残缺、退出码还是 0
> （看起来像「静默通过」）。现在 `STUDY_SMOKE` 模式下 `mainWindow.on('close')` 在冒烟进行中一律 `preventDefault()`。
>
> 分P列表接口失败降级：`api.video.pages()` 超时/被风控时不再让整页停在「视频信息加载失败」，而是退回
> 「只有一个 P」的列表继续取流（取流只要有 cid，而 cid 在 `view` 里就有）。
>
> 分P列表排版（`src/renderer/src/components/PartList.vue`，tab 里的分P页与播放页右栏共用一套）：课程合集动辄
> 一两百个 P，原来是 `flex-wrap` 的「按文字宽度撑开的胶囊」，右边缘参差不齐、也定位不到第几个 P。现在排成
> 对齐的单列清单：等宽序号徽章（`P12`）+ 单行省略的标题 + 当前行整行高亮并带一个圆点，列表固定高度内部滚动
> 并自动滚到当前 P，分P > 12 时给一个筛选框（编号或标题关键字，实测 177 P 筛「单词」剩 48 行）。
> 定位当前行用的是**显式算 `scrollTop`**（把当前行居中）而不是 `scrollIntoView`：后者会连带滚动祖先，而且
> 筛掉当前 P 再清空筛选时列表会停在中间不回来（实测停在 P134 附近）——`watch` 也要 `{ flush: 'post' }`
> 才拿得到更新后的 DOM；冒烟里对应两条断言（筛短、清空后当前 P 回到可视区 `inView` + `scrollTop`）。

> 布局坑（已修）：`.app` 是 `display:grid`，若不给 `grid-template-rows: minmax(0, 1fr)`，内容会把这一行撑高，
> `.main` 跟着变成内容高度（实测 2354px / 窗口 717px），再被 `body{overflow:hidden}` 裁掉 —— 表现就是
> 「页面下拉不动、右侧没有滚动条」。现在行高锁死为容器高度，`.scroll` 内部滚动正常。

## 功能与数据

- **登录**：B 站二维码扫码（`qrcode` 渲染），凭证经 Electron `safeStorage`（DPAPI）加密后存于 `userData/study-bili.json`。
- **UP 管理**：本机维护专注名单（UID / 空间链接 / 昵称添加，支持分组，登录后一键导入 B 站关注）；首页只显示这批 UP 的最新投稿。
- **播放**：DASH 按 `sidx` 直接定位到目标字节偏移起流；缓冲超前超过 45s 暂停拉流、低于 18s 恢复
  （音视频**各自**按自己的 SourceBuffer 计算，避免音轨甩开视频轨把配额撑爆）；配额不足时先淘汰
  「播放点前 5s 之外」与「播放点后 45s+ 之外」两侧的缓冲；网络 chunk 按批 append（视频 ≥512KB、
  音频 ≥128KB 或距上次 ≥300ms 才 flush 一次，首块立即 append 保证起播快），减少 appendBuffer 调用次数。
  可选择清晰度、分 P（右栏分P按钮显示分P标题，当前 P 的时长按 pagelist 单P时长算）、自动连播；**选轨按本次下发的画质**（`playurl.quality`）挑，找不到才退回最高带宽那条，
  实测出现过「报 720P 只回 480P 轨」的降级情况，此时清晰度面板会显示真正在播的档位。
  `sidx` 定位起流是**逐条线路试**的：探测失败 / 服务端忽略 Range / 64KB 内找不到 `sidx`（会放大到 512KB 再探一次）
  都只是换下一条备用线路，并把剩余备用地址一起带进续流；续流函数会回报「到底有没有真的 append 成功」，
  失败就回退到「从 0 顺序拉」，不会因为某条 CDN 403/404 就误判成功、让播放器一直空转。
  **音视频必须一起定位成功**才按偏移续流（`startStreams()` 先并行探测两条轨），否则两条一起从 0 顺序拉 ——
  只有一条轨跳到中途会让当前播放位置缺一半数据、直接卡死。
  `MediaSource.duration` 按「当前 P 的单P时长（pagelist）→ playurl 时长（合理才用）→ 投稿信息时长 → 先 `Infinity` 再按 `buffered` 收尾」取值（见下方时长坑）。
- **播放器**：控制栏是**浮在画面底部**的浮层，鼠标不动 2.8s 自动淡出、移到画面上再出现
  （双击画面 / 快捷键 `F` 全屏）。控制栏里依次是：播放/上一 P/下一 P/时间/进度条、倍速（0.5/0.75/1/1.25/1.5/2）、
  字幕（CC，可关闭；未登录时 B 站返回 `subtitle_count=0`，会提示「这个视频没有可用字幕」）、静音、音量、全屏。
  欠载恢复时 Chromium **只补发 `playing` 事件**（不会再来一次 `play`），播放器两个都监听，否则 UI 会一直以为
  「还没开始播」；「缓冲中… 已加载 XXMB」也只在真的欠载（`readyState < 3` 或暂停）时才提示（500ms 节流），
  画面一恢复就清掉 —— 不会再有遮罩一直盖在正在播放的画面上。
  `.player-wrap` 的描边固定用纯黑（`border: 1px solid #000`）：浅色主题下 `--line` 是 `#e2e2e6`，
  围着黑画面就是一圈白边（用户反馈的「视频有白边」），播放器卡片必须用黑边。
- **弹幕/画中画/在线人数（已按要求从播放页移除，底层代码保留）**：弹幕走旧版 XML 接口
  `api.bilibili.com/x/v1/dm/list.so`（匿名可用，实测单段数百到数千条），长视频按 360s 分段拉取最多 8 段；
  解析后按时间轴用 Web Animations 抛出（滚动 / 顶部 / 底部三种模式，轨道复用、seek 后二分重定位）；
  发送弹幕走 `x/v2/dm/post`（需登录态与 `bili_jct`）；在线人数走 `x/player/online/total`。
  实现见 `src/main/bili/danmaku.js` + `src/renderer/src/components/DanmakuLayer.vue` + IPC 通道
  `video:danmaku/online/sendDanmaku` + `.dm-*` 样式 —— 播放页不再挂载，要恢复只需在 `VideoView.vue` 里挂回组件与控制条。
  播放页仍保留视频信息行的「N 弹幕」统计 chip（那是投稿统计，不是控件）。
- **收藏**：本机收藏（文件夹管理、可离线）与 B 站账户收藏（需登录）双 tab。
- **页面滚动与右侧悬浮操作**：内容区右侧是可拖动的滚动条（12px，`scrollbar-gutter: stable`），
  右下角常驻悬浮按钮组 —— 「换一换」把当前页面整个重新挂载、重新拉数据，「顶部」在往下拉过 200px 后出现、
  一点平滑回顶。`src/renderer/src/components/PageFloat.vue` + `stores/ui.js` 的 `refreshSeq`。
  另外**切换页面会自动回到顶部**（`App.vue` 里 watch `route.fullPath` + `scrollTo({behavior:'instant'})`）——
  否则从拉到一半的列表点进视频页，播放器会被顶到屏幕外，看起来像「没有播放器」。
- **学习记录**：播放中每秒计时、每 5s 落一次进度，>95% 自动标记完成；按 UP 累计学习时长；
  学习页有签到日历、近 14 天条形图、按 UP 分布饼图、连续签到天数，支持手动打卡与（设置里）播放满 5 分钟自动打卡。
  数据可导出 JSON。
- **番茄钟**（学习页顶部卡片，`stores/pomodoro.js`）：专注 / 短休息 / 长休息三种模式，可开始暂停、重置、跳过，
  三个时长（默认 25/5/15 分钟）可改；倒计时按**结束时间戳**推算（只用 250ms 的 `setInterval` 刷新显示），
  挂机久了也不会走偏；一轮专注跑完自动进入休息（每 4 轮走长休息），Web Audio 抖一声 + 系统通知，
  并把这一轮的专注分钟数通过 `learn.addSeconds()` 记进当天学习时长（所以会体现在「今日」「近 14 天条形图」里）。
  `doneToday` 每天跨天归零，状态持久化在 localStorage（`study-bili-pomodoro`）。

> 说明：网页版 `x/space/wbi/arc/search`（UP 空间投稿接口）匿名访问在本机（云电脑 IP）被 B 站**IP 级风控**，
> 实测固定返回 `-412 request was banned` / `-352 风控校验失败`（换 Referer、补 `dm_img_*` 参数、去掉 wbi 签名都无效）。
> 因此本项目改用**移动端 App 接口** `app.bilibili.com/x/v2/space/archive`（appkey/appsec 签名，实测匿名可用，
> `code=0` 正常返回投稿），失败时才退回网页版接口；两路都失败才报错并显示友好空态。
> 播放量取 `play`、发布时间取 `ctime`（App 接口无 `stat.view` / `pubdate`），分页用 `pn`。

## 免责声明

仅供个人学习与研究使用，请遵守 B 站用户协议与相关法律法规，不要用于任何商业或批量抓取用途。
