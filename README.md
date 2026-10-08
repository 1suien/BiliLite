# BiliLite

学习专注型的 B 站桌面客户端（Windows / Electron）。参考 [BiliLite](https://github.com/ywmoyue/biliuwp-lite) 的功能取舍重新实现：
保留**扫码登录、UP 管理、首页（只看关注 UP 更新）、搜索、视频播放（分 P / 画质 / DASH / 小窗播放 / 本机文件）、本机收藏 + B 站收藏夹、UP 主主页、学习记录 / 打卡 / 专注（番茄钟 + 任务绑定 + 专注记录）**，
界面走黑白极简 token 体系，不引入娱乐化的信息流。播放页右栏只留「清晰度 + 分P列表」（相关推荐只在下方 tab 里）。

> 仅限个人学习用途。本项目不提供任何视频内容，只做本机客户端；登录凭证只加密保存在本机。

> 命名：应用原名「StudyBili / 学习 B 站」，2026-10 改名为 **BiliLite**（窗口标题、侧栏品牌、安装包与 exe 名都跟着改）。
> 打包身份从 `com.studybili.desktop` 换成 `com.bililite.desktop`，但**数据目录名与所有存储 key 保持不变**
> （`%APPDATA%\study-bili`、Dexie 库名 `study-bili`、`study-bili.json`、`study-bili-pomodoro`），
> 所以改名不会丢学习记录、登录态和设置。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面壳 | Electron 33（`contextIsolation: true`、`nodeIntegration: false`、preload + `contextBridge`） |
| 渲染层 | Vue 3 + vue-router 4（hash 路由，适配 `file://`）+ Pinia |
| 构建 | electron-vite 2 / Vite 5；`electron-builder` 打包 NSIS |
| 播放 | 自研 MSE 播放器（DASH fMP4：`sidx` 定位 + 双 SourceBuffer + 背压/配额淘汰），FLV 走 `mpegts.js` |
| 本机数据 | Dexie（IndexedDB）存学习记录；主进程 `store.json` 存设置与加密 Cookie |

> 定位变了：最初这里是「BiliLite + 读书」两个模块，2026-10-07 按用户要求**把读书模块整体摘掉**了
> （本机归档在 `backup\reader-module\`，说明见文末「读书模块（已按要求摘除）」）。

## 目录结构

```
src/
  main/                     主进程
    index.js                窗口、单实例、网络钩子（注入 Referer / 放开 CORS）
    ipc.js                  IPC 通道注册（统一 { ok, data | message, code, needLogin } 信封）
    store.js                设置 + 登录态持久化（Cookie 走 safeStorage 加密）
    smoke.js                端到端冒烟测试（见下文）
    local-media.js          本地视频：文件对话框 / 文件夹递归扫描 / `lmedia://local/<id>` 自定义协议（支持 Range）
    bili/                   B 站接口：http / wbi 签名 / auth / nav-classify（登录态分类）/ home / video / search / fav / space
  preload/index.js          window.bili 白名单桥接（含全局拖拽拦截 → bili:files-dropped 自定义事件）
  renderer/
    index.html              含 CSP meta（`media-src` / `connect-src` 里有 `lmedia:`，放本地视频要用；
                            `worker-src 'self' blob:` 是当年 pdf.js 的 Blob worker 要的 —— 读书模块摘除后
                            已无人使用，留着不影响安全，渲染层现在没有任何 `new Worker`）
    src/
      router.js  App.vue     布局（侧栏 6 项 + 顶栏搜索；侧栏不再放搜索入口）
      api/index.js           window.bili 门面
      db/index.js            Dexie：progress / daily / notes / shelf / ups / collect / checkins / upTime
                             + v4 追加 focus（每轮专注一行：day / startedAt / seconds / completed / task）
                             + v5 追加 subs（本地字幕，key = `bvid:cid:文件名`）
                             + v6 追加 locals（本地视频：只存 路径 / 名字 / 大小 / 时长 / 封面 / 播放进度）
      stores/                ui / settings / auth / learn / ups / collect / pomodoro
      player/dash.js         DASH 播放核心（在线流用；本地视频走原生 <video>）
      utils/subtitle.js      字幕解析（SRT / VTT / ASS）+ 编码嗅探
      views/                 Home / UpManage / Search / Video / Fav / FavFolder / Up / Learn / Local / LocalPlayer / Settings
      components/            Icon / BiliImage / VideoCard / Pager / DanmakuLayer / PageFloat / MiniPlayer / LoginModal / ConfirmModal / CollectModal / PartList
                             + FocusRing（专注圆环）/ FocusPanel（专注面板）/ SessionHistory（专注记录）…
tools/
  run-smoke.ps1             本机冒烟运行脚本（构建 + 启动 Electron + 收报告，绕开 DSH 沙箱坑）
  check-parsers.mjs         不启动 Electron，直接跑字幕解析 + 登录态分类（22 项断言，改 src/renderer/src/utils/subtitle.js 或 src/main/bili/nav-classify.js 后先跑它）
  check-package.mjs         读 release/win-unpacked/resources/app.asar 的索引，校验打包产物完整、且没夹带 pdf.js 资源
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
pnpm run package      # build + electron-builder --win --dir → release/win-unpacked/BiliLite.exe（免安装，直接跑）
pnpm run dist         # 生成 NSIS 安装包（⚠ 输出目录必须放到工作区外，否则见下：会以 Exit code 2 失败）
```

> ⚠ **`pnpm run dist` 的输出目录必须放在 DSH 工作区之外**。electron-builder 生成 NSIS 安装包时，
> 会先把一个「卸载器」安装包写进输出目录、再把它运行一次（`app-builder-lib/out/targets/nsis/NsisTarget.js:347`
> 的 `execWine(installerPath, ...)`）；而**在工作区目录里启动的原生进程会在初始化阶段就失败**（见下文
> 「不要在 DSH 工作区目录里启动」）。NSIS 的表现是弹出 `NSIS Error` →
> `Error writing temporary file. Make sure your temp folder is valid.` 并以 `Exit code: 2` 结束，
> 于是整个 `dist` 失败、`release\BiliLite Setup <版本>.exe` 只剩 ~188 KB 的半成品（`__uninstaller-*.exe` 也不会生成）。
>
> 2026-10-07 实测（同一份 36,739 B 的最小 NSIS 安装包，SHA256 相同，只换存放位置）：
> 放工作区内子目录 `C:\Users\zouyx\Desktop\学习APP\sub\` → 必弹 `NSIS Error`；
> 放工作区外的 `C:\ascii-dir\` 或**中文目录** `C:\Users\zouyx\测试目录\` → 都正常运行。
> 所以和路径编码、`%TEMP%` 是否可写都无关，只和「是否在工作区内」有关。做法是把输出目录指到工作区外：

```powershell
pnpm run build
pnpm exec electron-builder --win --publish never --config.directories.output=C:\Users\zouyx\bl-out
# → C:\Users\zouyx\bl-out\BiliLite Setup 0.2.8.exe（85,018,907 B）+ .blockmap（89,634 B）
```

> 安装包文件名里的版本号来自 `package.json` 的 `version`（electron-builder 的 NSIS 默认命名
> `${productName} Setup ${version}.exe`）。2026-10-07 之前 `version` 一直停在 `0.1.0`——尽管 git tag 已经到
> `v0.2.8`——所以安装包叫 `BiliLite Setup 0.1.0.exe`。现在把 `version` 对齐到 **0.2.8**，于是安装包 /
> `latest.yml` / 便携版 zip / `app:ping` 报的版本号全都一致了（`app:ping` 原来在 `src/main/ipc.js:54`
> 硬编码 `'0.1.0'`，已改成 `app.getVersion()`，以后不会再和 `package.json` 脱节）。

> 产物拷回 `release\` 存档没问题，但要**运行**它必须放在工作区外（例如桌面根目录
> `%USERPROFILE%\Desktop\BiliLite Setup 0.2.8.exe`）。工作区内的那个安装包双击同样会弹 `NSIS Error`。

> 打包还固化了一个坑：`build.npmRebuild: false`。本机没有 Python/MSVC，一旦有依赖带原生模块就会触发
> `@electron/rebuild` 的 node-gyp 重编（`Error: Could not find any Python installation to use`，整包失败）；
> 现在主进程零运行时依赖、渲染层已被 Vite 打进 `out/renderer/assets`，跳过原生依赖重编不影响运行。
> 打包完建议跑一次 asar 自检：`& "$nodeDir\node.exe" tools\check-package.mjs`（见「验证」）。

### 运行方式（重要：不要在本 DSH 工作区目录里启动）

| 入口 | 路径 | 实测 |
| --- | --- | --- |
| 桌面快捷方式「BiliLite」 | `%USERPROFILE%\Desktop\BiliLite.lnk` → `%LOCALAPPDATA%\Programs\BiliLite\BiliLite.exe` | 正常打开窗口「首页 · BiliLite」 |
| 安装版 | `%LOCALAPPDATA%\Programs\BiliLite\BiliLite.exe` | 正常 |
| 免安装便携版（已复制到桌面） | `%USERPROFILE%\Desktop\BiliLite\BiliLite.exe` | 正常，双击即可，无需任何参数 |
| 安装包副本（已复制到桌面） | `%USERPROFILE%\Desktop\BiliLite Setup 0.2.8.exe` | 85,018,907 B，SHA256 `FA8BB00D16AE7B20AF72DC17EA3909762639A12077731FF5366952193AC69132`（2026-10-07 v0.2.8 构建；`package.json` 的 `version` 已对齐 0.2.8） |

> 桌面那份是**手动拷过去的免安装版**（不是 `%LOCALAPPDATA%\Programs` 下的安装版，本机没有那个目录），
> 所以更新它要手动覆盖 —— 而且覆盖前必须先退出正在运行的 BiliLite，否则 `BiliLite.exe` 被占用，
> robocopy 会报 `ERROR 32 (0x00000020) ... being used by another process` 并只跳过这一个文件：
>
> ```powershell
> Get-Process BiliLite | Stop-Process -Force     # 先关掉
> robocopy release\win-unpacked "$env:USERPROFILE\Desktop\BiliLite" /E /R:3 /W:2   # exit 0~7 都是成功
> ```
>
> 因为 `userData` 固定成 `%APPDATA%\study-bili`，覆盖二进制不会丢学习记录/登录态/设置。2026-10-07 用这种方式
> 更新过很多轮，最近几轮是：含读书模块的版本（旧 asar 备份在 `backup\app-asar-prereader.asar`，23.2 MB）→
> 修好字幕菜单/专注快捷任务 → **摘掉读书模块**（asar 从 59.3 MB / 1871 个文件降到 23.3 MB / 982 个文件）→
> 离线缓存（v0.2.2）→ 缓存分组 + 自定义缓存目录（v0.2.3 / v0.2.4）→ **摘掉缓存 + 新增本地播放**（asar 24,444,321 B）。
> 每次覆盖后都用 `tools\check-package.mjs --dir "$env:USERPROFILE\Desktop\BiliLite"` 校验，并对桌面那份跑打包版冒烟。
> ⚠ `robocopy` 偶尔会报 `exit=11`/「FAILED 1」：那是 `BiliLite.exe` 被残留进程占着没覆盖上（asar 已经同步成功），
> 确认 `Get-Process BiliLite` 为空后再跑一次，`exit=3` 就是好了；记得用哈希核对两侧 `BiliLite.exe` 一致。

> 数据目录仍是 `%APPDATA%\study-bili`（改名前后不变，学习记录/登录态/设置都在里面）：
> `src/main/index.js` 在启动时显式 `app.setPath('userData', join(app.getPath('appData'), 'study-bili'))`，
> 否则 Electron 会跟着新 productName 换到 `%APPDATA%\BiliLite`，用户会以为「记录全没了」。

**不要把 `release\win-unpacked\BiliLite.exe`（或 `release\` 里的安装包）在 DSH 工作区目录内双击**：
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
& cmd /c "`"$PWD\release\win-unpacked\BiliLite.exe`" --no-sandbox --user-data-dir=`"$PWD\tmp-userdata`""
```

在普通 Windows 机器上不需要这些参数，`pnpm run dev` / `pnpm run start` 直接可用。

## 验证

主进程内置端到端冒烟测试（真实窗口里跑完整闭环：桥接 → 接口 → 播放起流/推进 → 落库 → 6 个路由 → 分P续播/侧栏换序/本地字幕/本地视频播放），
报告写到 `$env:STUDY_SMOKE_OUT`，退出码为失败项数。

本机（DSH 沙箱）直接跑用脚本，它会自己处理 `ELECTRON_RUN_AS_NODE`、node 路径、沙箱参数与 userData：

```powershell
powershell -ExecutionPolicy Bypass -File tools\run-smoke.ps1              # 构建 + 全量冒烟
powershell -ExecutionPolicy Bypass -File tools\run-smoke.ps1 -SkipBuild -Shots
powershell -ExecutionPolicy Bypass -File tools\run-smoke.ps1 -Theme light -Shots -Tag light
```

> 脚本里的注释必须是纯 ASCII：`write` 写出的 `.ps1` 是无 BOM UTF-8，PowerShell 5.1 按 GBK 读会解析崩溃。

手工跑（跑打包产物，或不想用脚本时）：

```powershell
$env:STUDY_SMOKE = '1'
$env:STUDY_SMOKE_OUT = "$PWD\smoke-pkg-report.txt"
$env:STUDY_USER_DATA = "$PWD\tmp-userdata-pkg"
$env:STUDY_SMOKE_SHOT = "$PWD\shots"   # 可选：顺手把真实界面截图存下来
& cmd /c "`"$PWD\release\win-unpacked\BiliLite.exe`" --no-sandbox --disable-gpu --autoplay-policy=no-user-gesture-required > smoke-pkg.out 2>&1"
Get-Content smoke-pkg-report.txt -Encoding UTF8
```

断言项：bridge 注入/通道齐全/`app:ping`、侧栏 6 项（且已没有「读书」入口）、侧栏不再有「搜索」入口（搜索只保留顶栏）、主题令牌、`home.feed`、`search.videos`、`video.view`、
`video.playurl`（DASH 轨道）、视频页渲染、`<video>` 起流（`readyState=4`）、点播放后 `currentTime` 前进、
学习进度写入 IndexedDB、顶栏搜索跳转、侧栏 6 个路由真实点击可达，以及本机 UP 名单（写入/渲染/首页只显示名单）、
`up.latest`（匿名可拉取，失败才软跳过）、本机收藏写入、学习页 7 卡（并且已经**没有**签到日历 / 近 14 天条形图 /
按 UP 分布饼图 / 打卡按钮，`.cal .cell`、`.bars14`、`svg.pie`、`今日打卡` 文本四者都为 0）、专注面板（学习页有 `.focus .ring-clock`；点齿轮把「专注」
改成 1 分钟后开始 → 倒计时前进；暂停 → 倒计时不动（这里只把「时钟继续往下掉」判失败：如果时钟**往上跳回整轮**，
说明面板收到了重置——`R` 快捷键和「重置」按钮都会把 `remain` 置回 `totalSeconds`，冒烟跑的时候窗口就在桌面上，
外面的键鼠事件进得来，这种情况按 WARN 记，见下文「无关干扰的识别」）；跑完一轮 → 自动进入休息、头部变 `今日 1 轮`、toast「番茄钟完成」且
顶栏「今日」时长增加）、UP 主页投稿列表（同一接口，含分页 `count`）、
右侧悬浮操作组、页面确实可上下滚动（`.scroll` 的 `scrollHeight > clientHeight`）、下拉后出现「顶部」并点回顶部、
「换一换」后页面重新渲染、切换页面自动回到顶部（先在长列表拉到 480/1224px，再进视频页 `scrollTop=0`）、
控制栏含倍速/字幕/静音/全屏控件、播放页右栏没有「相关推荐」（`.watch > aside .panel` 里没有它，但 tab 栏仍保留）、
播放页已移除弹幕/画中画/在线人数 UI（`.dm-bar`、`.dm-layer`、画中画按钮、
「N 人正在看」四者都不存在）、视频轨按画质挑选（`[dash] picked quality` 的 `got` 与按 `playurl.quality`
推算出的轨道一致）、「当前清晰度」显示实播画质（清晰度面板的 `.muted` 文本与 `.chip.on` 都是实播档位）、
倍速切换生效（点 2x → `video.playbackRate === 2` → 还原）、字幕菜单能打开、
本地字幕（往 userData 写一个真 `.srt` → 走 `bili:files-dropped` 拖入 → 解析 → 落 IndexedDB 的 `subs` 表 → 文本真的出现在
`.cc-line` 上）、字幕字号「特大」+ 位置「靠上」点完立刻生效（`.cc-line` 的 `font-size` 变 32px；顺带核对字幕设置那一坨的
排版与对比度——字号 / 背景 / 位置各占一行，菜单里每个 chip 以及选中行的文字对比度都要 ≥ 4.5，因为菜单是**固定深色浮层**，
浅色主题下也不能变成「白底白字 / 黑底黑字」）、
分P续播（自己从搜索里找一个真的多分P视频 → 切到 P2 → 离开页面让进度落库 → 不带 `?p` 回到同一个 bvid，仍落在 P2；
搜不到多分P视频时软跳过；失败诊断里带 `head`（组件自己渲染的「当前 Pn」）、`onAll`、`rowsInfo`（该 bvid 在 `progress`
表里的 `page@updatedAt`，用来区分「库里就没写上」还是「只是内存顺序错了」））、侧栏拖拽换序（发一遍 dragstart → dragover → drop 后顺序变化并且落进设置的 `navOrder`）、
专注快捷任务可自定义（学习页点「绑定任务」→「＋ 自定义」→ 填「背单词」→「添加」后 chip 出现、设置里的 `focusTasks` 也有它；再点该 chip 的 ✕ 后设置里同样没有了）、
播放中不显示「缓冲中」遮罩（视频推进后 `.player-msg` 必须已消失）、
跳转后能继续播放（目标点按已知总时长给：`dur > 10` 时取 `min(120, dur * 0.6)` —— 短视频硬跳 120 秒会落到片尾之外，
那是无效目标而不是播放器卡死；断言 `readyState ≥ 3`、`currentTime` 落在目标附近并继续推进、遮罩已消失；
再单独一条 `跳转走 ranged 起流（sidx 定位）`：`[dash] streamFrom video offset=<≥5 位数>`，CDN 不配合时降级为 WARN）、
分P列表带分P标题（`.pages-list .page-pill` 里 `.pn` 必须形如 `P2`、`.pt` 非空、`title` 属性非空、`.on` 恰好一行、
「正在播放」行不含 `undefined`；另外「至少有一个分P的标题与序号徽章不同」——因为上传者没给分P起名时后端返回的
`part` 就是 `P1` 这种序号占位（桌面打包版那轮撞到过一个），此时无从比较，按「每行都有非空标题」通过；
要指定视频验收就设 `STUDY_SMOKE_BVID=<bvid>`，实测用 `BV1cu411r7pw` 分P 177 通过）、
分P列表可按关键字筛选（分P > 12 时出现 `.pages-filter`，输入「单词」后行数变少：177 → 48）、
进度库没有缺失 bvid 的脏行（`progress` 表里 `key` 不该出现 `:<cid>` 这种行；冒烟启动后会等应用的
`learn.cleanupJunk()` 跑完，最多轮询 4 秒）、
首页「继续学习」卡片不重复（`section .grid .vcard .title` 文本唯一 —— 同一视频的多个分P只该出现一张卡）、
**本地播放**（现场造一个真视频文件：渲染层用 `canvas.captureStream()` + `MediaRecorder` 录 2 秒 webm，
回传 base64 由主进程写成 `tmp-local-fixture\clip.webm`，再走「用户选了文件」之后的同一条链路 →
`#/local` 里调 `window.__addLocalFiles([路径])` 断言列表出现 1 行、且隐藏 `<video>` 已经解析出
`duration > 0` 与 canvas 抽出的封面缩略图（`__localProbe` 读列表状态）→ 进 `#/local/<id>`，断言
`window.__playLog.source === 'local'`、`url` 是 `lmedia://local/<id>`、`video.currentTime > 0.3`
（证明确实走自定义协议放起来了）→ 回到列表断言播放进度已写回本地库（`pos > 0`，即「续播」的地基）→
最后真实点「移除」并在确认框里点确认，断言列表清空、**磁盘上的原文件还在**；跑完删掉夹具目录）、
**小窗播放**（首页信息流卡片缩略图右上角的「小窗」按钮 → 悬浮小窗边看边翻页：点 `button.mini` 后断言
`.mini-player` 出现、`window.__miniLog.source === 'mini'`、小窗里 `<video>.currentTime > 0.5`（真在播，不是只弹了个壳）→
断言 `window.__miniLoads === 1`（**一次点击只准取一路流**；早先把它写成 open / seq 两个 watcher，同一次点击会各跑一遍
`reload()`，两次 `load()` 叠在一起把 MediaSource 顶掉，表现就是「放两秒停住、再点播放也没反应」）→
切到 `#/learn` 再等 8.6 秒，断言进度又涨了 5 秒以上且 `paused === false`（被卡住的话这条会挂）→ 进视频页点「小窗播放」，断言这一路交给小窗、
**连「看到哪儿」也带过去了**（`window.__miniLog.startTime` 不小于点击时那一页的秒数减 12）、
本页显示「视频正在小窗播放」→ 点「收回本页播放」，断言小窗关掉、本页 `currentTime` 重新涨起来 →
**暂停状态下**用真实鼠标点标题栏的「换大小 / 收起·展开 / 关闭」三个按钮，各自断言宽度变了 / `.collapsed` 加上了且
`.mp-body` 隐藏 / `.mini-player` 真的消失（**这一组是给用户反馈「画圈部分点击不生效」补的回归**：
标题栏既能拖动、又长着按钮，真实鼠标按下按钮时 `pointerdown` 先冒泡到拖动逻辑，那边一 `preventDefault()`，
浏览器就不再补发随后的 `click` —— 这是 Pointer Events 规范行为，按钮看着在、点了没反应。
冒烟里用的是注入式输入（`sendInputEvent` / CDP），**根本不产生 `pointerdown`**，所以这个 bug 一直测不出来。
现在按钮自己 `@pointerdown.stop`、拖动侧再加一道 `closest('button')` 保护，并且拖动不再 `setPointerCapture`；
按钮命中区也从 22×22 放到 26×26）→
测试还顺手查了另一起「8 个交互点全哑」：交互点收口函数 `tap()` 写成了工厂（返回 handler），而模板里写的是
`@click="tap(() => …)"` —— 这是 Vue 的**内联语句**，编译出来是 `($event) => tap(() => …)`，只执行工厂、
把返回的 handler 丢掉。正确写法是 `tap($event, () => …)`（必须把事件显式传进去），
`window.__tapLog` / DOM 探针（`Symbol(_vei)` 才是 Vue 3.5 装监听器的地方，字符串 `el._vei` 永远是空的）就是为查这个加的，
首页信息流没加载出来时整段软跳过）、
读书模块已于 2026-10-07 按用户要求摘除（本机归档在 `backup\reader-module\`，那里有 `MANIFEST.txt`；
⚠ 读书模块从未进入过这个仓库（`backup/` 被 `.gitignore` 忽略），所以仓库里没有它的历史版本，要留副本得另存），
所以断言总数从 139 降到 72：读书段 67 项、侧栏「读书」那 1 项删掉，新增「侧栏已没有读书入口」1 项；
**下面那些 139 / 137 / 118 项的历史验收记录都是「含读书段」时跑的**，摘除后的数字另见本节末尾那一轮。
之后做「离线缓存」时又加了 5 项（下载落盘 / 缓存页列表 / 本地分片播放 / 导出 MP4 / 删除清目录），
并把「侧栏 5 项 / 5 个路由」改成 6 项（侧栏循环多了一项，那时是 `侧栏「缓存」`，现在是 `侧栏「本地」`）；
2026-10-07 那轮（缓存页按稿件分组 + 自定义缓存目录 + 登录态修复）把「缓存页列表」拆成「缓存页卡片」+
「同一稿件分P归到一张卡片」两条，并新增 1 条「缓存文件夹显示默认位置且与主进程一致」，断言曾到 **80 项**；
2026-10-07 又一轮按用户要求把整块离线缓存摘掉（源码归档在 `backup\cache-module\`，含 `MANIFEST.txt`），
换成侧栏「本地」页播放本机视频文件：去掉缓存那 7 项、新增本地播放 4 项；
同一天再加「小窗播放」（卡片/视频页都能把视频丢进悬浮小窗，边看边翻页）又加 4 项，
之后修「小窗放两秒就停住」时又加了 1 项（一次点击只取一路流），
再修「画圈部分点击不生效」（标题栏按钮被拖动逻辑吞掉 click + `tap()` 内联语句写法）时又加了 3 项
（暂停时真实鼠标点「换大小 / 收起·展开 / 关闭」），**现在最多 85 项**
（`首页「继续学习」卡片不重复` 在首页没有继续学习卡时软跳过，只 log 不打 PASS/FAIL，所以那轮会显示 76，
另有一条「切换页面自动回到顶部」在搜索页没滚起来时也只 `warn`）。

解析层还能单独跑（不启动 Electron，改 `src/renderer/src/utils/subtitle.js` / `src/main/bili/nav-classify.js` 后先跑它，22 项断言）：

```powershell
& "$nodeDir\node.exe" tools\check-parsers.mjs
```

> 无关干扰的识别：实测有人在冒烟跑的时候点了窗口（设置页主题、番茄钟按钮、侧栏），会让「侧栏点 X 后页面没换」这类断言失败，
> 且失败现场**没有任何渲染层异常**。用 `window.__navLog`（smoke 装的 pushState/replaceState/hashchange/点击调用栈）能看出来是外部点击。
> 冒烟一律用一次性 userData 目录（`tools\run-smoke.ps1 -Tag <新名字>`），别复用：进度、看书位置、侧栏顺序都是持久化的，
> 复用目录会污染断言（旧版读书段的 PDF 断言还因此**假通过**过）。
>
> 最新一轮（用户反馈的两条 UI 问题修完后，同一份代码、两个干净目录）：深色
> **139 PASS / 0 FAIL / 0 WARN / 0 渲染层异常**（`smoke-fix1-report.txt`、`shots-fix1/`）、浅色
> **139 PASS / 0 FAIL / 0 WARN / 0 渲染层异常**（`smoke-fixlight1-report.txt`、`shots-fixlight1/`）。
> 这一轮新增的两条断言：
> `字幕显示设置：字号/背景/位置各占一行，菜单里的文字对比度足够（浅色主题下也看得清）`，实测
> `{"subRows":3,"subLab":["字号","背景","位置"],"chipMin":11.2,"onMin":13.7}` —— 两个主题下这几个数**完全一样**，
> 正是「菜单改成固定深色配色、不再跟主题走」的证据（改之前浅色主题下 chip 是 `--soft` 近白底配 `--t2` 文字、
> 选中行是 `--accent` 近黑字，对比度都在 1 附近，也就是用户看到的「一排纯白小球」）；
> `专注快捷任务可自定义（新增/删除都落盘）`，实测加完「背单词」后 chip 变 `背单词✕`、`settings.focusTasks` 里有它，
> 点 ✕ 删掉后设置里同样没有了（新增和删除都真的落了盘，不只是界面变了）。
>
> 再一轮（把上面那条「浅色其实没验成」的坑修掉之后）：深色 `smoke-fix3-report.txt` / 浅色 `smoke-fixlight3-report.txt`
> 各 **139 PASS / 0 FAIL / 0 WARN / 0 渲染层异常**，而且 `字幕显示设置` 那条断言的诊断里分别写着
> `"theme":"dark"` / `"theme":"light"` —— 这回能证明「这条是在浅色下过的」，修前两种配色返回的是同一组数字，
> 自证不了主题（`shots-fix3/`、`shots-fixlight3/`，`shots-fixlight3/4-学习页专注.png` 亮度 247 确认是浅色）。
> 同一轮顺手把三条「其实是 fixture/环境问题」的假失败改掉：
> ① UP 主页接口失败导致列表为空时，页面**本来就不需要滚动**，`页面可上下滚动（右侧下拉）` 与
> `下拉后出现「顶部」按钮` 改为记 WARN 并说明原因（内容够长却滚不动仍然 FAIL）；
> ② 有人的分P就叫「B」（1 个字），旧断言要求分P标题长度 > 1 会把正确的界面判成 FAIL，现在改成
> 「至少有一个分P的标题与序号徽章不同」，标题真丢了仍由 `bad` 拦住；
> ③ 阅读器会保存滚动比例、`boot()` 再还原一次，同一份代码两次跑分别落在 `scrollTop` 1506 / 1906，
> 第 2 页的判定从「顶边落在容器顶 +200px 内」放宽为「第 2 页盖住可视区上部」。桌面打包版那一轮
> （`smoke-desktop4-report.txt`）的 3 个 FAIL 正是这三条：前两条是 UP 主页空列表，第三条是 `scrollTop` 1906
> 而第 2 页仍占满整个视口。
>
> 打包产物另有一层自检：`pnpm package`（= build + `electron-builder --win --dir`）之后跑
> `& "$nodeDir\node.exe" tools\check-package.mjs`，它解出 `release\win-unpacked\resources\app.asar` 的索引，校验
> `out/main/index.js`、`out/preload/index.js`、`out/renderer/index.html` 都在包内、**包里不该再有 `out/main/pdfjs/`
> 的 CMap / 标准字体**（摘掉读书模块后的反向断言），并检查主进程产物里除 `electron` 外没有裸 `require`。
> 摘掉读书模块后的自检输出：**asar 23.3 MB / 982 个文件**（含读书模块时是 59.3 MB / 1871 个）、主进程入口
> **43075 B**（含读书解析层时 87274 B）、preload 4130 B、`包里不再带 pdf.js 资源（读书模块已移除） :: 0 cMaps / 0 fonts`、
> 主进程只剩 `electron, node:path, node:fs, node:fs/promises, node:crypto`（`node:zlib` 随着自研 ZIP 解析一起没了）。
>
> 摘掉读书模块之后（2026-10-07，同一份代码、两个干净目录、`-SkipBuild`）：深色
> **72 PASS / 0 FAIL / 0 WARN / 0 渲染层异常**（`smoke-rm1-report.txt`、`shots-rm1/`）、浅色
> **72 PASS / 0 FAIL / 0 WARN / 0 渲染层异常**（`smoke-rmlight1-report.txt`、`shots-rmlight1/`，那条
> `字幕显示设置` 的诊断里写着 `"theme":"light"`、`shots-rmlight1/4-学习页专注.png` 亮度 243 也证明是浅色）。
> 断言数从 139 掉到 72 的原因就是读书段那 67 项；改写后的 `侧栏导航 5 项` 与新增的
> `侧栏已没有「读书」入口` 都 PASS，`侧栏拖拽换序` 的 `beforeHrefs` 里只剩 5 项
> （`["/","/ups","/fav","/learn","/settings"]`），视频段的 `分P续播` / `本地字幕` / `字幕可调` / `专注快捷任务`
> 这些全部照旧通过。解析层自检同时从 60 项变成 **15 项（只剩 SRT/VTT/ASS 解析）**。
> 覆盖到桌面那份之后，又对**用户实际启动的那个可执行文件**跑了一轮打包版冒烟（浅色、干净目录）：
> **72 PASS / 0 FAIL / 0 WARN / 0 渲染层异常**（`smoke-desktop6-report.txt`、`shots-desktop6/`，
> 5 张截图亮度 200~243 全是浅色，`shots-desktop6/1-首页顶部.png` 里侧栏只剩 5 项、没有「读书」）。
>
> 再往后是「离线缓存」几轮（80 项）与最后一轮**摘掉缓存 + 新增本地播放**（2026-10-07）：`pnpm build`、
> `tools\check-parsers.mjs`、`pnpm package`、`tools\check-package.mjs` 全部 exit 0；深色
> `-SkipBuild -Tag local1 -Theme dark -Shots` = **76 PASS / 0 FAIL / 1 WARN**（`smoke-local1-report.txt`、`shots-local1/`，
> WARN 是 `切换页面自动回到顶部` 在搜索页没滚起来的软跳过）、浅色 `-Tag local1light` = **77 PASS / 0 FAIL / 0 WARN**
> （`smoke-local1light-report.txt`、`shots-local1light/`）。本地播放那 4 条断言的诊断值：冒烟用 canvas + `MediaRecorder`
> 录出来的夹具 `clip.webm` 58705 B 写进 `tmp-local-fixture\` 后，列表里出现 1 行、
> `duration 2.152` / `thumb true`；点播放走 `lmedia://local/e9963964bf1e712f151de59b`、`currentTime 0.658`、`paused false`；
> 进度写回本地库 `pos 0.270776`（下次进来续播）；点「移除」后列表清空而磁盘上 `fileStill true`。
> 缓存那 7 条断言随之删掉、换成本地播放 4 条，所以断言总数从 80 项变成 **77 项**。
> 覆盖到桌面那份之后（asar 24,444,321 B，两侧 `app.asar` SHA256 一致），对**用户实际启动的那个可执行文件**又跑了一轮
> 打包版浅色冒烟：**77 PASS / 0 FAIL / 0 WARN**（`smoke-desk-local2-report.txt`、7 张截图在 `shots-desk-local2/`），
> 4 条本地播放断言全绿（`duration 2.171`、走 `lmedia://local/…`、`currentTime 0.699`、进度 `pos 0.2576`、移除后 `fileStill true`）。
> 第一次打包版冒烟撞上 CDN 抖动（`[dash] ranged try failed … signal is aborted` → `ranged unusable, 从 0 顺序拉`，
> 使 `跳转后能继续播放` 的探针 30s 超时），换一轮重跑即全绿 —— 这条断言对网络很敏感，看到它单独失败先重跑一次再判断。
>
> 最近一轮是 **番茄钟休息合并 + 小窗播放**（2026-10-07 用户要求，见 m05156）：`pnpm build`、`tools\check-parsers.mjs`
> （22 项）、`pnpm package`、`tools\check-package.mjs` 全部 exit 0；深色 `-SkipBuild -Tag mini1 -Theme dark -Shots` =
> **81 PASS / 0 FAIL / 0 WARN**（`smoke-mini1-report.txt`、`shots-mini1/`），浅色 `-Tag mini1light` = **81 PASS / 0 FAIL / 0 WARN**
> （`smoke-mini1light-report.txt`、`shots-mini1light/`）。小窗播放那 4 条断言的诊断值（深色那轮）：点首页卡片缩略图右上角的
> 小窗按钮 → `{"clicked":true,"open":true,"log":{"source":"mini","bvid":"BV1MSHY6eEq9","cid":"42417522439","title":"你管这叫留守老人？","quality":64},"t":0.677559,"paused":false,"err":""}`
> （截图 `shots-mini1/9-小窗播放.png`）；切到 `#/learn` 后进度仍在涨 `{"from":0.677559,"t":3.916459}`；
> 视频页点「小窗播放」→ `{"popped":true,"pageT":60.732366,"mini":{…,"t":0.396605},"pageMsg":"视频正在小窗播放收回本页播放"}`；
> 点「收回本页播放」→ `{"back":true,"goneAfter":true,"pageBack":60.841869}`。
> 其中第三条深色那轮 `mini.t≈0.4`、浅色那轮是 `60.9` —— 同一份代码两种结果，差别在 CDN 这次给不给 Range：
> 拿不到 Range 时播放器会走既有的 `[dash] ranged unusable, 从 0 顺序拉` 降级，`startTime` 就落不了地
> （判断这类差异先看报告里的 `RCONSOLE [dash] …` 行，别急着改代码）。
> 番茄钟那两条照旧通过（`专注结束（自动进入休息 + 计入学习时长）` 的诊断里 `clock":"05:00"`、面板文本是「休息」），
> 断言总数从 77 项涨到 **81 项**。
> 覆盖到桌面那份之后（asar 24,472,358 B，两侧 `app.asar` SHA256 一致 `7E352F6F…C445`、`BiliLite.exe` 188,766,720 B，
> `tools\check-package.mjs --dir "C:\Users\zouyx\Desktop\BiliLite"` exit 0），对**用户实际启动的那个可执行文件**跑了打包版浅色冒烟：
> 第一次 **79 PASS / 1 FAIL / 1 WARN**（`smoke-desk-mini1-report.txt`）——唯一那条失败是既有的
> `分P续播：不带 ?p 回到上次那个分P`，诊断里 `head` 是空串（39 分P 的列表压根没渲染出来、`on:-1`），
> 是拉 `video.pages` 慢了/被风控，不是这次改的东西；换一个干净目录重跑（`smoke-desk-mini2-report.txt`）就是
> **81 PASS / 0 FAIL / 0 WARN**、`head":"共 39 P · 当前 P2"`、小窗 4 条也全绿
> （`shots-desk-mini2/`）。所以这类「单独一条、诊断里列表为空」的失败，先重跑一次再判断。
>
> 紧接一轮是**修「小窗放两秒就停住」**（用户反馈「小窗口功能不能用」，截图里小窗停在 `0:02 / 1:44`、
> 画面盖着「点一下继续播放」）：`pnpm build`、`tools\check-parsers.mjs`（22 项）exit 0；深色 `-SkipBuild -Tag mini2 -Theme dark -Shots` =
> **82 PASS / 0 FAIL / 2 WARN**（`smoke-mini2-report.txt`；两条 WARN 是既有的「专注面板不见了…重新点侧栏」软跳过，
> 那一刻 hash 是 `#/`、`#/ups`，专注那些断言本身就全绿），浅色 `-Tag mini2light` = **82 PASS / 0 FAIL / 0 WARN**
> （`smoke-mini2light-report.txt`）。新增那条断言的诊断：
> `{"clicked":true,"open":true,"log":{"source":"mini","bvid":"BV1ndHf6xEsz","cid":"42509926719","title":"虽败犹荣","quality":64,"muted":false,"loads":1},"loads":1,"t":0.724358,"paused":false}`
> —— `loads:1` 就是这次的核心（旧写法这里是 2）；8.6 秒后再看 `{"from":0.724358,"need":5,…,"t":9.39275,"paused":false}`（浅色 0.59 → 10.01），
> 证明不会「放两秒停住」。视频页交接那条 `pageT 123.128122` → 收回来 `pageBack 123.479826`（`?t=` 续播生效）。
> 断言总数从 81 项涨到 **82 项**。
>
> 同一轮还补了一个**位置交接**的坑：视频页点「小窗播放」偶尔会从头重放。原因是「看到哪儿」读的是那个只在
> `onProgress` 里更新的响应式值，而视频暂停/缓冲时 `timeupdate` 不触发、它可能还停在 0。改成以
> `<video>.currentTime` 为准（读不到才回落到那个值），小窗侧也加了 `syncTime()`（暂停/缓冲/拆流时把真实秒数落一次）。
> 为此又跑了一轮 `-Tag mini3`（深色）/`-Tag mini3light`（浅色）= 两边都 **82 PASS / 0 FAIL / 0 WARN**
> （316 / 320 行），交接那条改成「连时间点也带过去」并新增 `window.__miniLog.startTime` 诊断：
> 深色 `pageT 128.188841` → `mini.startTime 128.190101`，浅色 `pageT 123.125566` → `mini.startTime 123.125566`；
> 之后 `pnpm package` + `check-package` exit 0（asar 24,476,409 B），同步桌面后再跑打包版浅色冒烟
> `-Tag desk-mini5` = **81 PASS / 0 FAIL / 1 WARN**（`smoke-desk-mini5-report.txt`；那条 WARN 是既有的
> `切换页面自动回到顶部：搜索结果页没滚起来（before=0）` 软跳过）：`pageT 128.258924` → 小窗 `startTime 128.2598`、
> 小窗当前 `t 128.554603`（**真的从 128 秒接着播，不再从 0 重放**），点「收回本页播放」后 `pageBack 128.246148`。
> 桌面那份两侧 `app.asar` SHA256 一致 `37DB37DF…D582`（24,476,409 B）、`BiliLite.exe` 一致 `1A11B5B9…3320`。
>
> 再一轮是**修「画圈部分点击不生效」**（用户 2026-10-07 反馈，截图 `屏幕截图 2026-10-07 200513.png`：小窗浮在视频页中间、
> 停在暂停态，红圈圈的是标题栏那排「收起 / 换大小 / 回到视频页 / 关闭」）。根因有两条：
> ① **用户那份 v0.2.7 里**，按钮长在可拖动的标题栏内，真实鼠标按下按钮时 `pointerdown` 先冒泡到 `onDragStart`，
> 那边 `setPointerCapture()` + `e.preventDefault()` —— 按 Pointer Events 规范，`pointerdown` 的默认行为被阻止后
> 浏览器**不再补发兼容鼠标事件（含 `click`）**，于是「按钮看着在、点了没反应」。冒烟用的是注入式输入
> （`sendInputEvent` / CDP），**根本不产生 `pointerdown`**，所以这个 bug 一直测不出来。改法：按钮各自
> `@pointerdown.stop` + 拖动侧 `closest('button')` 双保险、拖动改在 `window` 上听 `pointermove/pointerup`（不再抢指针）、
> `unbindDrag()` 也在 `onBeforeUnmount` 里收尾、按钮命中区 22×22 → 26×26、标题栏高 30 → 32px。
> ② 这一轮的改造自己写坏过一次：把交互点收口写成**工厂函数** `tap(fn)`（返回 handler），而模板写成
> `@click="tap(() => …)"` —— 这是 Vue 的**内联语句**，编译出来是 `($event) => tap(() => …)`：只执行工厂、
> 把返回的 handler 丢掉，8 个交互点全哑。正确写法 `tap($event, () => …)`（事件必须显式传进去）。
> 为查这条加了 `window.__tapLog` 埋点与 DOM 探针，首轮复现 `-Tag mini8` = **80 PASS / 3 FAIL / 2 WARN**
> （`smoke-mini8-report.txt`），诊断是「事件到了按钮、处理函数没进」：`taps: []`、`clicks: […"mp-btn@#/learn"]`、
> 直接派发 `MouseEvent('click')` 后 `tapped: 0`。**探针本身也踩了个坑**：Vue 3.5 把事件调用器存在
> `Symbol("_vei")` 上，读字符串 `el._vei` 永远是空对象，一开始还以为是「监听器没挂上」。
> 改成 `tap($event, …)` 后 `-Tag mini9` = **85 PASS / 0 FAIL / 0 WARN**（327 行），探针变成
> `{"count":1,"items":[{"rect":[821,361,420,299],"cls":"mini-player","nbtn":4,"veiSyms":["Symbol(_vei)"],"sameNode":true,"tapped":1,"err":""}]}`
> （`tapped: 1` = 派发进去真的进了 `tap`），三条新断言：换大小 `{"w0":320,"w1":420,"paused":true,"overlay":true}`、
> 收起 `{"collapsed":true,"bodyHidden":true,"expanded":true}`、关闭 `{"at":{"x":1099,"y":370.5}}`，
> 暂停点击那组 `pauseTaps` 里出现 `{"t":"click","drag":false,"since":-1,"ran":true}`（真的执行到 store）；
> 位置交接仍然成立：深色 `pageT 60.939437` → `mini.startTime 60.940542`、小窗 `t 61.07732`。
> 浅色 `-Tag mini9light` = **85 PASS / 0 FAIL / 0 WARN**（319 行，`pageT 122.339044` → `startTime 122.340919`、`t 122.625485`）；
> `tools\check-parsers.mjs`（22 项）exit 0；`pnpm package` + `tools\check-package.mjs` exit 0（asar 24,487,696 B）。
> 同步桌面（`robocopy release\win-unpacked "C:\Users\zouyx\Desktop\BiliLite" /E /R:3 /W:2`，`ROBO_EXIT=3` = 成功）后两侧一致：
> `app.asar` SHA256 `5D41728F1A03E900EB178F543560BED22810383466B20F55114F1B38FF060CF5`（24,487,696 B）、
> `BiliLite.exe` SHA256 `C6DA647A86E946DD5BA1E0F6C98F9C213DA8547FDBD14491947F3BEDD62C6A56`；
> `check-package.mjs --dir "C:\Users\zouyx\Desktop\BiliLite"` exit 0；打包版浅色冒烟 `-Tag desk-mini6` = **85 PASS / 0 FAIL / 0 WARN**
> （`smoke-desk-mini6-report.txt`，323 行；`shots-desk-mini6/`）：三条按钮断言在真机上也全绿
> （`{"w0":320,"w1":420,"paused":true,"overlay":true}`、`{"collapsed":true,"bodyHidden":true,"expanded":true}`、`{"at":{"x":1099,"y":370.5}}`），
> 位置交接 `pageT 127.018295` → `mini.startTime 127.018295`、小窗 `t 127.417944`。
> 断言总数从 82 项涨到 **85 项**。

> **安装包命名对齐版本号（2026-10-07，commit `3f28f37`）**：`package.json` 的 `version` 从 `0.1.0` 改成 `0.2.8`
> （此前只有 git tag 到了 `v0.2.8`，所以 NSIS 产物一直叫 `BiliLite Setup 0.1.0.exe`），`src/main/ipc.js:54`
> 的 `app:ping` 也从硬编码 `'0.1.0'` 改成 `app.getVersion()`。重建后
> `C:\Users\zouyx\bl-out\BiliLite Setup 0.2.8.exe` = **85,018,907 B**、SHA256
> `FA8BB00D16AE7B20AF72DC17EA3909762639A12077731FF5366952193AC69132`、`.blockmap` 89,634 B（`DIST_EXIT=0`，
> asar 里确认写着 `"version": "0.2.8"`）；`bl-out\win-unpacked` / `release\win-unpacked` / 桌面便携版三处
> `resources\app.asar` 都是 24,487,714 B、SHA256 `FAD3BCC770F3D0B06BD9D975D42B53E1A6737518FBBD07384E826F8DB5FF1E7D`，
> `BiliLite.exe` SHA256 `B6CDA8A2C700E834F530088754E799CAF02D10F6B561244ED0793D545B5327DD`；
> `tools\check-package.mjs` 对 `bl-out\win-unpacked` 和桌面便携版都 exit 0（986 个文件 / 23.4 MB）；
> 便携版 zip 重打成 `release\BiliLite-0.2.8-win-x64.zip`（120,434,323 B，SHA256
> `90C3762388C715C8A56EE8A2C5EA5CC88492ED5C33C4D882E13C0D0FB0F1E814`）。
> 旧的 `BiliLite Setup 0.1.0.exe`（85,018,862 B）已从 `release\` 与桌面删除；GitHub Release v0.2.8 的资产换成
> `BiliLite-Setup-0.2.8.exe` + `BiliLite-0.2.8-win-x64.zip`，tag `v0.2.8` 也移到了同一个提交（`3f28f37`）。
> 重建后桌面便携版跑了一次浅色打包冒烟：**85 PASS / 0 FAIL / 0 WARN**（`smoke-desk-ver1-report.txt`，325 行，
> 截图 8 张在 `shots-desk-ver1/`），其中 `app:ping` 回报 `{"pong":…,"version":"0.2.8"}`——证明包里那条版本号
> 真的是从 `package.json` 动态取的；小窗相关 8 条断言仍全绿（位置交接 `pageT 128.485563` → `mini.startTime 128.494368`）。

> **冒烟前先看构建结果**：`tools\run-smoke.ps1 -SkipBuild` 会拿旧的 `out/` 继续跑，跑出一份「看起来全绿但什么都没证明」的报告
> （踩过：`vite build` 失败、报告却照样满绿）。**改完 `src/` 先看 `BUILD_EXIT`，再谈冒烟。**
> 而且 `BUILD_EXIT=0` 只说明构建成功，**不说明改动进了 bundle**：查「小窗按钮点不动」时最有用的一步是
> `Select-String -Path out\renderer\assets\index-*.js -Pattern '__tapLog'`（或任何当轮新加的标记）——
> 标记在 bundle 里，才排除了「跑的是上一版」。
> ⚠ 另外，**别在 Windows 上用独立探针脚本查输入管线**：`tools\probe-input.mjs`（`electron tools\probe-input.mjs`）
> 直接 `0xC0000005` 退出、`tools\probe-input.cjs` 连一行输出都写不出来还把 pwsh 挂住（GUI 子进程占住管道，
> `Start-Process` 那条也救不回来）。要看「某个事件到底有没有派发 / 处理函数有没有进」，
> 写成冒烟里的 `window.__tapLog` 埋点 + DOM 探针（`Symbol(_vei)`）最快。
> 断言总数是 **85 项**。其中 `切换页面自动回到顶部` 在搜索页没滚起来时只记 WARN（深色那轮就是 80 PASS + 1 WARN），
> `首页「继续学习」卡片不重复` 在首页没有继续学习卡时软跳过、只 log 不打 PASS/FAIL → 这两种情况下 PASS 计数会显示 80。

> 主题验收：设置 `STUDY_SMOKE_THEME=light`（或 `dark`）会让冒烟把主题强制成对应主题再跑一遍，
> 每次截图前也会重新强制一次 —— `settings.init()` 是异步的，完成时会按落盘设置把主题刷回来，
> 只在开头强制一次会偶发截到默认主题（浅色下的浅色描边/留白问题要靠它才看得出来）。
>
> ⚠ 只改 DOM 还不够（这一轮踩到的）：应用里**任何一次 `settings.patch()` 都会调 `applyTheme()`**，
> 而 `applyTheme()` 是拿「已落盘的主题」去写 `document.documentElement.dataset.theme` 的
> （`src/renderer/src/stores/settings.js`：`patch()` → `this.settings = {...}` → `applyTheme()`）。
> 于是「只强制 DOM」的浅色跑法会在中途某次写设置之后**又变回默认深色**：实测前几张截图是浅色（L≈231/205），
> 学习页那张突然变深（L=24，与深色跑法一模一样），而对比度断言在两种配色下都返回同一组数字，
> 让人误以为「浅色也验过了」。现在 `forceTheme()` 除了改 DOM，还会
> `window.bili.settings.patch({ theme: want })` 把主题**一起落盘**（userData 是冒烟自己的一次性目录，改它无害），
> 之后的 patch 只会把它再设成同一个值；`字幕显示设置` 那条断言也会把此刻的 `dataset.theme` 记进诊断，
> 并在 `-Theme` 指定了主题时要求它**确实等于**该主题 —— 否则「浅色下也看得清」这句话等于没验。
> 顺带留了一张 `3-视频-字幕菜单.png`（CC 菜单开着时截的）：这个浮层是固定深色配色，用户就是在这里看不清的。
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
> 另一个坑：环境变量 `ELECTRON_RUN_AS_NODE=1` 会让 `BiliLite.exe` 退化成 Node，报
> `BiliLite.exe: bad option: --no-sandbox`（退出码 9，也不写报告）。跑打包版冒烟前先
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
> 分P续播竞态坑（已修）：进度一直是按 `bvid:cid` 存 1-based 的 `page` 的，但播放页入口只认 `?p`，所以从首页 /
> 学习记录点进多分P视频永远回到 P1（`LearnView` 传的是 `query: { cid }`，`VideoCard` 等卡片也不带 `p`）。补上
> 「`?p` → `?cid` → `learn.list` 里最新一行」的判定之后，又暴露一个更隐蔽的竞态：`learn.save()` 原来是
> **`await putProgress()` 之后**才更新内存、并用那时的 `Date.now()` 当 `updatedAt`，而 `putProgress()` 给库里那行
> 盖的是**发起写入时刻**——于是「先发起、后完成」的旧行反而拿到更新的内存时间戳，把刚落库的新分P挤出「最新一行」。
> 现象就是同一条用例时对时错，而**库里其实是对的**（冒烟诊断的 `rowsInfo` 能直接看出来：`2@<更大的时间戳>`，
> 界面却停在 P1）。修法：内存更新挪到 `await` 之前，让「写入顺序 = 内存顺序」。另外冒烟切 P2 后要等
> `video.currentTime > 0.5` 再离开页面，因为 `flushProgress()` 只写 `currentTime > 0` 的进度，起流没完成就跳走
> 属于环境慢、不算代码错。
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
>
> 进度行脏数据坑（已修，表现是首页「继续学习」同一视频出现两张卡片、点进去还是空视频）：
> `progress` 表按「每个分P一行」存（`key = ${bvid}:${cid}`），而 `VideoView.vue` 的 `meta()` 用的是
> `bvid = computed(() => String(route.params.bvid || ''))` —— 路由参数还没就绪（或 URL 里没有 bvid）时
> `learn.save()` 会写出 `key = ':cid'`、`bvid` 为空的脏行；它带着标题，于是在首页渲染成第二张同标题卡片。
> 现在三层兜住：①`learn.save()` 开头 `if (!rec.bvid || !rec.cid) return null`；②`learn.init()` 先跑一次
> `cleanupJunk()`，按 `cid` 把脏行并回真实行（时长取 max、完成取或），配不上就删掉；③给 store 加
> `listByVideo` getter（按 `bvid` 去重只留最近一条），首页「继续学习」、学习记录的「最近学习」、
> 「看过视频 / 已看完 / 在看」三个统计都基于它 —— 原来直接数 `progressMap` 的行，会把同一个视频的多个
> 分P算成多个视频、也会把同一视频列多遍。首页 UP 投稿网格同理按 `bvid` 去重（`latestUnique`），
> 多个 UP 转载同一稿件只出现一张卡。

> 布局坑（已修）：`.app` 是 `display:grid`，若不给 `grid-template-rows: minmax(0, 1fr)`，内容会把这一行撑高，
> `.main` 跟着变成内容高度（实测 2354px / 窗口 717px），再被 `body{overflow:hidden}` 裁掉 —— 表现就是
> 「页面下拉不动、右侧没有滚动条」。现在行高锁死为容器高度，`.scroll` 内部滚动正常。

## 功能与数据

- **登录**：B 站二维码扫码（`qrcode` 渲染），凭证经 Electron `safeStorage`（DPAPI）加密后存于 `userData/study-bili.json`。
  登录态校验（`x/web-interface/nav`）**必须分清三种结果**：正常登录 → 更新 user；B 站**明确**回未登录
  （`code -101`，或 `code 0` 且 `isLogin === false`）→ 才清凭据；其余（-352 风控、超时、5xx、缺 `data`）算
  **暂时失败**，`restore()` 会重试一次并保留 cookie 与上次的 user 信息（`{loggedIn:true, stale:true}`）。
  判定逻辑抽在纯函数 `src/main/bili/nav-classify.js` 里，`tools/check-parsers.mjs` 有 7 项断言锁住它
  —— 旧写法「拿不到 user 就当未登录」会在 nav 被风控一次时 `clearAuth()` 清空 cookie，
  用户看到的就是「扫码登录后过一会儿自动退出」。扫码成功后 `qrPoll()` 也只在真的明确未登录时才不置 user。
  另外 `store.load()` 若发现 `secure` 是 `enc:` 但解不开（换了 Windows 账户 / 换了 userData 目录），
  会把原文件备份成 `study-bili.json.bak` 再继续，避免下一次 `persist()` 把最后的凭据覆盖掉。
- **UP 管理**：本机维护专注名单（UID / 空间链接 / 昵称添加，支持分组，登录后一键导入 B 站关注）；首页只显示这批 UP 的最新投稿。
- **播放**：DASH 按 `sidx` 直接定位到目标字节偏移起流；缓冲超前超过 45s 暂停拉流、低于 18s 恢复
  （音视频**各自**按自己的 SourceBuffer 计算，避免音轨甩开视频轨把配额撑爆）；配额不足时先淘汰
  「播放点前 5s 之外」与「播放点后 45s+ 之外」两侧的缓冲；网络 chunk 按批 append（视频 ≥512KB、
  音频 ≥128KB 或距上次 ≥300ms 才 flush 一次，首块立即 append 保证起播快），减少 appendBuffer 调用次数。
  可选择清晰度、分 P（右栏分P按钮显示分P标题，当前 P 的时长按 pagelist 单P时长算）、自动连播；
  **从首页 / 收藏 / UP 页 / 学习记录点进多分P视频会回到上次看的那一 P**（入口按 `?p` → `?cid` → 学习记录里的
  `page` 依次判定；老版本只认 `?p`，而 `LearnView` 的「继续学习」传的是 `?cid`，所以永远回 P1。
  进度是新分P真的播过才落的，所以「刚切过去、一秒都没播就离开」这种情况仍会回到上次看过的那个 P），
  **选轨按本次下发的画质**（`playurl.quality`）挑，找不到才退回最高带宽那条，
  实测出现过「报 720P 只回 480P 轨」的降级情况，此时清晰度面板会显示真正在播的档位。
  `sidx` 定位起流是**逐条线路试**的：探测失败 / 服务端忽略 Range / 64KB 内找不到 `sidx`（会放大到 512KB 再探一次）
  都只是换下一条备用线路，并把剩余备用地址一起带进续流；续流函数会回报「到底有没有真的 append 成功」，
  失败就回退到「从 0 顺序拉」，不会因为某条 CDN 403/404 就误判成功、让播放器一直空转。
  **音视频必须一起定位成功**才按偏移续流（`startStreams()` 先并行探测两条轨），否则两条一起从 0 顺序拉 ——
  只有一条轨跳到中途会让当前播放位置缺一半数据、直接卡死。
  `MediaSource.duration` 按「当前 P 的单P时长（pagelist）→ playurl 时长（合理才用）→ 投稿信息时长 → 先 `Infinity` 再按 `buffered` 收尾」取值（见下方时长坑）。
- **播放器**：控制栏是**浮在画面底部**的浮层，鼠标不动 2.8s 自动淡出、移到画面上再出现
  （双击画面 / 快捷键 `F` 全屏）。控制栏里依次是：播放/上一 P/下一 P/时间/进度条、倍速（0.5/0.75/1/1.25/1.5/2）、
  字幕（CC，可关闭；详见下面单独的「字幕」条）、静音、音量、全屏。
  欠载恢复时 Chromium **只补发 `playing` 事件**（不会再来一次 `play`），播放器两个都监听，否则 UI 会一直以为
  「还没开始播」；「缓冲中… 已加载 XXMB」也只在真的欠载（`readyState < 3` 或暂停）时才提示（500ms 节流），
  画面一恢复就清掉 —— 不会再有遮罩一直盖在正在播放的画面上。
  `.player-wrap` 的描边固定用纯黑（`border: 1px solid #000`）：浅色主题下 `--line` 是 `#e2e2e6`，
  围着黑画面就是一圈白边（用户反馈的「视频有白边」），播放器卡片必须用黑边。
- **本地播放**：侧栏「本地」用来放本机的视频文件：右上角「打开文件」（多选）与「打开文件夹」
  （递归扫 ≤4 层、最多 500 个文件，按文件名排序）。文件**不会被复制、转码或移动**，只是把绝对路径登记进
  本地库（Dexie **v6** 的 `locals` 表：`{id, path, name, size, mtime, duration, pos, thumb, addedAt, playedAt}`）。
  列表每行有时长徽标、封面缩略图与进度条；点「播放 / 继续播放」进 `#/local/<id>` 播放页，
  进度每 5 秒（以及暂停、离开页面时）写回本地库，所以下次接着看。
  时长与封面是**渲染层现场解析**的：一个隐藏的 `<video preload="metadata">` 读出时长后 seek 一帧
  `drawImage` 到 320px 宽的 canvas，出 JPEG dataURL 存进 IndexedDB 当封面；MediaRecorder 之类录出来的 webm
  头部没写时长（`duration === Infinity`）时，先 `currentTime = 1e101` 逼 Chromium 把时长算出来。
  播放页用的是原生 `<video :src="lmedia://…">`（本地文件不需要 MSE，也就不接 DASH 播放器）。
  文件被移动/改名后列表里标「文件不在了」，点播放会提示；磁盘上的文件不会被应用删掉。
  **自定义协议** `lmedia://local/<id>`（`src/main/local-media.js`）：`registerSchemesAsPrivileged` 声明
  `standard / secure / supportFetchAPI / stream / corsEnabled / bypassCSP`，`protocol.handle` 把请求映射到
  登记过的文件，并**完整支持 `Range`（206 / `Content-Range` / 416，无 Range 走 200）**。
  id 是绝对路径 sha1 的前 24 位，协议只认「登记表里存在的 id」——路径拼不进来，渲染层也拿不到任意文件读取能力；
  重启后由渲染层拿本地列表重新登记一遍（id 不变，地址稳定）。
  > 为什么不用 `file://`：播放要按自己的节奏发 `Range` 请求（拖进度就是定位字节），`file://` 既不受控，
  > 在 CSP / 跨源 / Range 上也不好办。
  > 这一段的前身是「离线缓存」（视频页选分P下载 → 缓存页 → 导出通用 MP4），2026-10-07 按用户要求整块摘掉：
  > 源码归档在 `backup\cache-module\`（含恢复指引 `MANIFEST.txt`），仓库里不再有 `video-cache.js` /
  > `cache-protocol.js` / `mp4/remux.js`，`tools/check-remux.mjs` 也一并删除。
- **字幕**：**在线字幕**改走**带 wbi 签名**的 `x/player/wbi/v2`（2024 年起不签名会被 -403；签名失败自动退回不签名的旧接口），
  取投稿级字幕列表、只拉前 5 种语言，条目结构和弹幕一样是 `{from,to,content}`，播放时按 `from` 二分查找当前句。
  **本地字幕**支持 `.srt / .vtt / .ass(ssa)`：CC 菜单里「选择字幕文件…」或把字幕文件**拖进窗口**都能加
  （复用同一条 `bili:files-dropped` 路径）；主进程 `sys:pickSubtitle` / `sys:readSubtitle` 负责选文件与读文本
  （只认这四种扩展名、上限 8MB、必须是普通文件），渲染层 `src/renderer/src/utils/subtitle.js` 解析
  （UTF-8 严格解码失败自动退 GB18030；VTT 跳过 `WEBVTT/NOTE/STYLE/REGION` 与时间行后的定位参数；
  ASS 按 `[Events]` 的 `Format:` 字段顺序取值、只切前 n-1 个逗号好让 Text 里的逗号保留、剥 `{\...}` 标记、`\N` 变换行），
  存 Dexie **v5** 的 `subs` 表（key = `bvid:cid:文件名`，一个分P可挂多份），**切分P自动换成本分P的字幕**
  （老版本切P后还会显示上一P的字幕）。CC 菜单里可调**字号（小/中/大/特大）、背景遮罩（有/无）、位置（靠下/居中/靠上）**，
  三项存在设置里、点完立刻生效；「自动开启在线字幕」打开后开播/切P会自动取字幕。
  ⚠️ CC 菜单（`.ctl-menu`）是**固定深色浮层**，里面的 chip / 选中行**不能用主题变量**：浅色主题下 `--soft` 是近白 `#ececef`、
  `--accent` 是近黑 `#17171a`，套进来就是「一排纯白小球」和「黑底黑字」（用户反馈的「选项纯白看不清」）。
  所以这里改用固定的 `rgba(255,255,255,.1)` 半透明底 + `#e8e8ee` 文字、选中态直接给白底深字，并且把字号 / 背景 / 位置
  **各拆成一行**（`.mrow.sub-row` + `.sublab` + `.chip-group`），不再让两组设置挤在同一个 flex-wrap 行里换行错乱；
  冒烟里有一条断言在算 chip 与选中行的**对比度 ≥ 4.5**，防止以后再退化。（同理的还有 `.ctl-menu .mi.on`。）
- **弹幕/画中画/在线人数（已按要求从播放页移除，底层代码保留）**：弹幕走旧版 XML 接口
  `api.bilibili.com/x/v1/dm/list.so`（匿名可用，实测单段数百到数千条），长视频按 360s 分段拉取最多 8 段；
  解析后按时间轴用 Web Animations 抛出（滚动 / 顶部 / 底部三种模式，轨道复用、seek 后二分重定位）；
  发送弹幕走 `x/v2/dm/post`（需登录态与 `bili_jct`）；在线人数走 `x/player/online/total`。
  实现见 `src/main/bili/danmaku.js` + `src/renderer/src/components/DanmakuLayer.vue` + IPC 通道
  `video:danmaku/online/sendDanmaku` + `.dm-*` 样式 —— 播放页不再挂载，要恢复只需在 `VideoView.vue` 里挂回组件与控制条。
  播放页仍保留视频信息行的「N 弹幕」统计 chip（那是投稿统计，不是控件）。
- **小窗播放**（`stores/mini.js` + `components/MiniPlayer.vue`，挂在 `App.vue` 最外层所以切页也一直在）：
  首页信息流/搜索结果的卡片缩略图右上角有一个 hover 才亮出来的小窗按钮（`.vcard .thumb .mini`，
  用 `opacity` 控制是因为 `display:none` 连脚本都点不到），视频页信息行也有一枚「小窗播放」按钮；
  点完视频进右下角的**应用内悬浮小窗**（不新开系统窗口）：可拖动（位置落 localStorage）、三档大小循环、
  收起成标题栏一条、关闭、以及「回到视频页」。小窗自己复用视频页同一个 `DashPlayer`（在线 DASH 与本机
  `lmedia://` 文件同一套逻辑），播放/暂停/进度跳转/静音也在小窗底栏。
  两个容易踩的点：①同一路流不能两处同时拉，所以视频页点「小窗播放」后会立刻 `teardown()`，反过来如果小窗里放的
  正是当前视频，视频页 `startPlay()` 直接不取流、只显示「视频正在小窗播放」+「收回本页播放」；
  ②「回到视频页」/「收回本页播放」都要把当前秒数写进 `?t=`，`startSeconds()` 优先读它，这样来回切不会跳回开头。
  卡片只给 `bvid`（没有 cid），小窗自己用 `video.pages()` 补出 cid，清晰度回落到设置里的默认档。
  ⚠ **一个必须守住的规矩：一次「点小窗」只准跑一遍取流**。这里原本写成 `watch(() => mini.open)` +
  `watch(() => mini.seq)` 两个 watcher，而 `mini.play()` 会同时改这两个值 → 同一次点击跑两遍 `reload()`，
  两次 `load()` 叠在一起把对方的 `MediaSource` 顶掉，症状是**小窗放两秒就停住、画面盖着「点一下继续播放」、
  再点也没反应**（用户就是这么反馈的：「小窗口功能不能用」）。现在合并成一个数组 watcher + 用 `inflight` 把
  `reload()` 串行化，并在 `window.__miniLoads` 里留了计数，冒烟直接断言它是 1。
  另外两条兜底（流真断了别让用户对着死画面）：没点过暂停却退回 `paused` 时自动救一次（最多 3 次，1.5 秒后
  若时间还不动就整条重建）；自动播放被拦下时退回「静音先播」并在画面上写「已静音播放，点右下角开声音」，
  点喇叭会把音量补回 0.8。
  ③「看到哪儿」一定以 `<video>.currentTime` 为准去读（`popMini()` 里就是先读元素、读不到才回落到那个响应式值）：
  元素暂停/缓冲时 `timeupdate` 不触发，一路只在 `onProgress` 里更新的值可能还停在 0，照它交接就会**点了小窗
  从头重放**；小窗这边同理，`syncTime()` 会在暂停/缓冲/拆流时把真实秒数落一次，「回到视频页」才不会拿着 0 秒回去。
- **收藏**：本机收藏（文件夹管理、可离线）与 B 站账户收藏（需登录）双 tab。
- **页面滚动与右侧悬浮操作**：内容区右侧是可拖动的滚动条（12px，`scrollbar-gutter: stable`），
  右下角常驻悬浮按钮组 —— 「换一换」把当前页面整个重新挂载、重新拉数据，「顶部」在往下拉过 200px 后出现、
  一点平滑回顶。`src/renderer/src/components/PageFloat.vue` + `stores/ui.js` 的 `refreshSeq`。
  另外**切换页面会自动回到顶部**（`App.vue` 里 watch `route.fullPath` + `scrollTo({behavior:'instant'})`）——
  否则从拉到一半的列表点进视频页，播放器会被顶到屏幕外，看起来像「没有播放器」。
- **侧栏可拖动换序**：按住侧栏项拖动就能调整顺序（HTML5 拖拽；dragstart 写 `text/plain`，
  dragover 里必须把 `dropEffect` 改回 `'move'` —— preload 在 capture 阶段已经把 window 上的 dragover 设成 `copy` 了）。
  新顺序落进设置的 `navOrder`，`App.vue` 的 `navList` 只认「仍存在的路径」、其余按 `DEFAULT_NAV` 顺序补后面，
  所以以后新增页面不会被老顺序弄丢，删页面也不会留空条目。
- **学习记录**：播放中每秒计时、每 5s 落一次进度，>95% 自动标记完成；按 UP 累计学习时长；
  学习页只留 **7 张统计卡**（总时长 / 看过视频 / 已看完 / 在看 / 连续签到 / 今日专注 / 本周专注）+ 专注面板 + 学习清单；
  **签到日历、近 14 天条形图、按 UP 分布饼图与手动打卡按钮已按需求移除**（`LearnView.vue` 487 → 194 行，
  只服务这几块的整个 `<style scoped>` 也删了；`stores/learn.js` 里的 `maxDailySeconds / recentDays / upDistribution`
  变成没人用但保留未删；`checkins` 表仍由「播放满 5 分钟自动打卡」写入，供「连续签到」卡使用）。
  数据可导出 JSON（含专注记录）。
- **专注**（学习页顶部卡片，`stores/pomodoro.js` + `components/FocusPanel.vue`）：TickTick 风格的
  圆环进度 + 大号倒计时（环上刻度随剩余时间逐个点亮）。**只有专注 / 休息两种模式**（2026-10-07 用户要求把原来的
  「短休息 / 长休息」合并成统一的「休息」），可开始暂停、重置、结束本轮，
  两个时长（默认专注 25 分钟 / 休息 5 分钟）可改（点面板右上角齿轮展开，有「恢复默认」；**计时进行中不让改**，否则这一轮算几分钟会前后不一致）；
  倒计时按**结束时间戳**推算（只用 250ms 的 `setInterval`
  刷新显示），挂机久了也不会走偏；一轮专注跑完自动进入休息，Web Audio 抖一声 + 系统通知，
  并把这一轮的专注时长通过 `learn.addSeconds()` 记进当天学习时长（所以会体现在「今日」「本周专注」里）
  —— **落库的秒数和计入学习时长的秒数是同一个值**（用真实已专注的秒数，不是配置的分钟数），少于 30 秒则两边都不记。
  每轮开始前可以**绑定本轮专注目标**：从「学习清单」挑一个视频，或者手输任务名（另有阅读/刷题/看课/整理笔记快捷项），
  这四个快捷项**自己也能改**：弹层里点「＋ 自定义」进入编辑态，点 chip 改名、点 chip 上的 ✕ 删掉，下面一行输入框回车或点
  「添加」新增，另有「恢复默认」；最多 8 个、每个 12 字、重名会被拦下并 toast。改动落在设置的 `focusTasks`（空数组 = 用默认四个），
  跟随设置一起持久化，所以换机器/清 IndexedDB 也还在。
  计时进行中锁定不可改，选择会持久化到 localStorage 下次带出。
  快捷键：`空格` 开始/暂停、`R` 重置、`S` 结束本轮、`Esc` 收起设置/关弹层（焦点在输入框或按钮上时不抢键）；
  「结束本轮」会二次确认，已专注超过 30 秒的按「部分完成」记下（不会白干）。
  每轮结束（走完或手动结束）在 IndexedDB 的 `focus` 表落一行（Dexie v4），少于 30 秒的轮次不记；
  `components/SessionHistory.vue` 按这些记录出「近 7 天迷你条形图 + 今日/本周次数与总时长 + 平均每轮 + 连续专注天数
  + 历史列表（可单条删除/清空）」，
  今日轮数直接由 `focus` 表算出（删记录后数字自动对齐）。只有三个时长与上次的任务名持久化在
  localStorage（`study-bili-pomodoro`），计时状态本身不落盘。
- **读书模块（已按要求摘除）**：2026-10-07 用户要求「去除读书项目」，整个模块（书架页 / 阅读页 / PDF 阅读器 /
  自研 ZIP+XML+EPUB+TXT 解析层 / `pdfjs-dist` 依赖）已从应用里移除，源码与恢复方法归档在本机的
  `backup\reader-module\`（那里有 `MANIFEST.txt`，列了归档清单和重新接线要改的 11 处）；
  注意 `backup/` 被 `.gitignore` 忽略、不进仓库，而读书模块当年也没被提交过任何一次，
  所以**仓库里没有它的历史版本**——那份归档是本机唯一副本，要长期保留得另存或另行提交。
  摘除后：侧栏 5 项、`pdfjs-dist` 依赖删除、`reader:*` 共 14 个 IPC 通道与 preload 门面删除、
  `out/main/pdfjs/` 不再产生（打包自检里是反向断言：包里出现它就算失败）、IndexedDB 里 v3 声明的
  `books` / `bookmarks` / `highlights` **表定义故意保留不动**（删表要走 Dexie 迁移，一旦表名清单写错就可能
  动到用户真实的 progress / daily / checkins 数据），只是应用里不再读写它们。
  用户之前导入的书和阅读进度按「不动用户数据」原则留在 `%APPDATA%\study-bili\books\` 里，没有删。

> 说明：网页版 `x/space/wbi/arc/search`（UP 空间投稿接口）匿名访问在本机（云电脑 IP）被 B 站**IP 级风控**，
> 实测固定返回 `-412 request was banned` / `-352 风控校验失败`（换 Referer、补 `dm_img_*` 参数、去掉 wbi 签名都无效）。
> 因此本项目改用**移动端 App 接口** `app.bilibili.com/x/v2/space/archive`（appkey/appsec 签名，实测匿名可用，
> `code=0` 正常返回投稿），失败时才退回网页版接口；两路都失败才报错并显示友好空态。
> 播放量取 `play`、发布时间取 `ctime`（App 接口无 `stat.view` / `pubdate`），分页用 `pn`。

## 免责声明

仅供个人学习与研究使用，请遵守 B 站用户协议与相关法律法规，不要用于任何商业或批量抓取用途。
