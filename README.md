# StudyBili · 学习 B 站

学习专注型的 B 站桌面客户端（Windows / Electron）。参考 [BiliLite](https://github.com/ywmoyue/biliuwp-lite) 的功能取舍重新实现：
保留**扫码登录、首页推荐、搜索、视频播放（分 P / 画质 / DASH）、收藏夹、UP 主主页、学习记录**，
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
      router.js  App.vue     布局（侧栏 5 项 + 顶栏搜索）
      api/index.js           window.bili 门面
      db/index.js            Dexie：progress / daily / marks / notes / shelf
      stores/                ui（toast + 确认框）/ settings / auth / learn
      player/dash.js         DASH 播放核心
      views/                 Home / Search / Video / Fav / FavFolder / Up / Learn / Settings
      components/            Icon / BiliImage / VideoCard / Pager / LoginModal / ConfirmModal …
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

### 本机（DSH 沙箱）注意事项

这台机器上 `node` / `pnpm` 不在 `PATH`，且环境变量 `ELECTRON_RUN_AS_NODE=1` 会让 Electron 退化成 Node：

```powershell
$env:PATH = 'C:\Users\zouyx\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;' + $env:PATH
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
node 'C:\Users\zouyx\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs' run package
```

GUI 启动需要 `--no-sandbox`（本机内核下无沙箱会直接 ACCESS_VIOLATION），
并且默认 `%APPDATA%` 不可写，需要指定可写的 userData 目录：

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
& cmd /c "`"$PWD\release\win-unpacked\StudyBili.exe`" --no-sandbox --disable-gpu --autoplay-policy=no-user-gesture-required > smoke-pkg.out 2>&1"
Get-Content smoke-pkg-report.txt -Encoding UTF8
```

断言项：bridge 注入/通道齐全/`app:ping`、侧栏 5 项、主题令牌、`home.feed`、`search.videos`、`video.view`、
`video.playurl`（DASH 轨道）、视频页渲染、`<video>` 起流（`readyState=4`）、点播放后 `currentTime` 前进、
学习进度写入 IndexedDB、顶栏搜索跳转、侧栏 5 个路由真实点击可达。

## 功能与数据

- **登录**：B 站二维码扫码（`qrcode` 渲染），凭证经 Electron `safeStorage`（DPAPI）加密后存于 `userData/study-bili.json`。
- **播放**：DASH 按 `sidx` 直接定位到目标字节偏移起流；缓冲超前超过 30s 暂停拉流、低于 12s 恢复；
  配额不足时淘汰播放点前 5s 之外的缓冲。可选择清晰度（默认 1080P）、分 P、自动连播。
- **学习记录**：播放中每秒计时、每 5s 落一次进度，>95% 自动标记完成；学习页有 30 天柱状图、
  已完成统计、连续天数、学习清单与 JSON 导出。

## 免责声明

仅供个人学习与研究使用，请遵守 B 站用户协议与相关法律法规，不要用于任何商业或批量抓取用途。
