# StudyBili · 学习 B 站

学习专注型的 B 站桌面客户端（Windows / Electron）。参考 [BiliLite](https://github.com/ywmoyue/biliuwp-lite) 的功能取舍重新实现：
保留**扫码登录、UP 管理、首页（只看关注 UP 更新）、搜索、视频播放（分 P / 画质 / DASH）、本机收藏 + B 站收藏夹、UP 主主页、学习记录与打卡**，
界面走黑白极简 token 体系，不引入娱乐化的信息流。

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
      router.js  App.vue     布局（侧栏 6 项 + 顶栏搜索）
      api/index.js           window.bili 门面
      db/index.js            Dexie：progress / daily / notes / shelf / ups / collect / checkins / upTime
      stores/                ui / settings / auth / learn / ups / collect
      player/dash.js         DASH 播放核心
      views/                 Home / UpManage / Search / Video / Fav / FavFolder / Up / Learn / Settings
      components/            Icon / BiliImage / VideoCard / Pager / LoginModal / ConfirmModal / CollectModal …
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

断言项：bridge 注入/通道齐全/`app:ping`、侧栏 6 项、主题令牌、`home.feed`、`search.videos`、`video.view`、
`video.playurl`（DASH 轨道）、视频页渲染、`<video>` 起流（`readyState=4`）、点播放后 `currentTime` 前进、
学习进度写入 IndexedDB、顶栏搜索跳转、侧栏 6 个路由真实点击可达，以及本机 UP 名单（写入/渲染/首页只显示名单）、
`up.latest`（匿名可拉取，失败才软跳过）、本机收藏写入、学习页 5 卡 / 371 格签到日历 /
近 14 天条形图 / 按 UP 分布饼图、手动打卡写入 `checkins`、UP 主页投稿列表（同一接口，含分页 `count`）、
右侧悬浮操作组、页面确实可上下滚动（`.scroll` 的 `scrollHeight > clientHeight`）、下拉后出现「顶部」并点回顶部、
「换一换」后页面重新渲染。

> 布局坑（已修）：`.app` 是 `display:grid`，若不给 `grid-template-rows: minmax(0, 1fr)`，内容会把这一行撑高，
> `.main` 跟着变成内容高度（实测 2354px / 窗口 717px），再被 `body{overflow:hidden}` 裁掉 —— 表现就是
> 「页面下拉不动、右侧没有滚动条」。现在行高锁死为容器高度，`.scroll` 内部滚动正常。

## 功能与数据

- **登录**：B 站二维码扫码（`qrcode` 渲染），凭证经 Electron `safeStorage`（DPAPI）加密后存于 `userData/study-bili.json`。
- **UP 管理**：本机维护专注名单（UID / 空间链接 / 昵称添加，支持分组，登录后一键导入 B 站关注）；首页只显示这批 UP 的最新投稿。
- **播放**：DASH 按 `sidx` 直接定位到目标字节偏移起流；缓冲超前超过 30s 暂停拉流、低于 12s 恢复；
  配额不足时淘汰播放点前 5s 之外的缓冲。可选择清晰度（默认 1080P）、分 P、自动连播。
- **收藏**：本机收藏（文件夹管理、可离线）与 B 站账户收藏（需登录）双 tab。
- **页面滚动与右侧悬浮操作**：内容区右侧是可拖动的滚动条（12px，`scrollbar-gutter: stable`），
  右下角常驻悬浮按钮组 —— 「换一换」把当前页面整个重新挂载、重新拉数据，「顶部」在往下拉过 200px 后出现、
  一点平滑回顶。`src/renderer/src/components/PageFloat.vue` + `stores/ui.js` 的 `refreshSeq`。
- **学习记录**：播放中每秒计时、每 5s 落一次进度，>95% 自动标记完成；按 UP 累计学习时长；
  学习页有签到日历、近 14 天条形图、按 UP 分布饼图、连续签到天数，支持手动打卡与（设置里）播放满 5 分钟自动打卡。
  数据可导出 JSON。

> 说明：网页版 `x/space/wbi/arc/search`（UP 空间投稿接口）匿名访问在本机（云电脑 IP）被 B 站**IP 级风控**，
> 实测固定返回 `-412 request was banned` / `-352 风控校验失败`（换 Referer、补 `dm_img_*` 参数、去掉 wbi 签名都无效）。
> 因此本项目改用**移动端 App 接口** `app.bilibili.com/x/v2/space/archive`（appkey/appsec 签名，实测匿名可用，
> `code=0` 正常返回投稿），失败时才退回网页版接口；两路都失败才报错并显示友好空态。
> 播放量取 `play`、发布时间取 `ctime`（App 接口无 `stat.view` / `pubdate`），分页用 `pn`。

## 免责声明

仅供个人学习与研究使用，请遵守 B 站用户协议与相关法律法规，不要用于任何商业或批量抓取用途。
