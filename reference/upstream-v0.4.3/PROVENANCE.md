# 上游官方源码快照（tag `v0.4.3`）— 出处与用途

## 出处

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/1suien/BiliLite |
| tag | `v0.4.3` |
| commit | `dd3e5cff8d8daa6184d91dd1fd1c25b7f4f8985d` |
| commit 时间 | 2026-10-16 20:32:16 +0800 |
| commit 说明 | `fix(mobile): 全屏上下黑带（沉浸式全屏 + 舞台居中），并补回被误忽略的原生 Java 源（v0.4.3）` |
| 许可 | MIT（GitHub 仓库标注） |
| 快照方式 | `git clone` 后取 tag `v0.4.3` 的树；本目录内文件已与 `git show v0.4.3:<path>` 的 blob 逐字节核对一致 |
| 抓取时间 | 本机 2026-10-25 |

> `v0.4.3` 与 `v0.3.3` 指向**同一个 commit**（打 tag 时忘了切分支，见 GitHub tags），因此 `v0.3.3` 的 APK 也是从这个源码树构建的。

## 为什么会有这份快照

本工程的主体 `app/` 是**从 APK 反编译产物逐函数重写**出来的等价源码（APK 里没有 sourcemap，不能直接解出原 TS/JS）。重写完成后，发现上游仓库在这个 tag 上**公开了原始源码**，于是把这份源码快照放在这里，用于：

1. **核对**：`docs/08-与官方源码逐模块核对.md` 里的每条结论都以本目录为 ground truth；
2. **补齐安卓壳**：`app/android/` 的 Gradle 工程、`MainActivity.java` / `PipPlugin.java` / `ImmersivePlugin.java` 是**原样复制**自 `mobile/android/`（这条路此前被判定为「dex 无法反编译、环境无 java/jadx，只能按 Capacitor 重新生成」）；
3. **可复查**：任何人想复核某条还原结论，不必再访问网络。

## 目录内容

```
reference/upstream-v0.4.3/
├── PROVENANCE.md            ← 本文件
├── README.md                ← 上游仓库根 README
├── package.json             ← 上游根 package.json（pnpm workspace，Electron 桌面端）
├── electron.vite.config.mjs
├── pnpm-workspace.yaml
├── src/                     ← 上游全部共用源码（JavaScript）
│   ├── renderer/src/        ← Vue 3 渲染层（桌面端与安卓端共用）
│   ├── mobile/              ← 安卓平台适配层（bridge.js / platform.js / native-http.js / store.js / local-files.js）
│   ├── main/                ← Electron 主进程（B 站接口层的「原生半」）
│   ├── preload/             ← Electron preload
│   └── shared/default-settings.js
└── mobile/                  ← 安卓构建入口的配置文件
    ├── README.md            ← 上游的安卓构建/真机验证说明（19 KB，含踩坑记录）
    ├── package.json  vite.config.mjs  index.html  capacitor.config.json  .gitignore
    └── （android/ 见 app/android/，避免同一份 Gradle 工程在两处重复）
```

## 与 APK 的同源证据

`app/android/` 里的 Java 源不是「按行为重写」的，而是与实际发布 APK 同源。用 APK 内 `classes4.dex` 的字符串池可以直接对上：

- 符号：`Lcom/bililite/app/MainActivity;`、`Lcom/bililite/app/PipPlugin;`、`Lcom/bililite/app/ImmersivePlugin;`、`Lcom/bililite/app/ImmersivePlugin$$ExternalSyntheticLambda0;`
- 方法名：`applyDesktopUserAgent`、`onUserLeaveHint`、`onResume`、`registerPlugin`、`enterPictureInPictureMode`、`setSourceRectHint`、`setAspectRatio`、`setDecorFitsSystemWindows`、`getInsetsController`、`setSystemBarsBehavior`、`runOnUiThread`、`setUserAgentString`、`getWebView`、`getDisplayMetrics`
- 常量：`MainActivity.DESKTOP_UA` 的完整字符串 `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36`
- 引用：`Landroidx/core/view/WindowCompat;`、`Landroidx/core/view/WindowInsetsControllerCompat;`、`Landroid/app/PictureInPictureParams$Builder;`、`Landroid/webkit/WebSettings;`

复现命令：

```bash
cd .work/unzipped
strings -a classes4.dex | grep -E "bililite/app|setImmersive|enterPip|setGeometry|setPlaying|DESKTOP_UA"
strings -a classes4.dex | grep -E "WindowCompat|PictureInPictureParams|setDecorFitsSystemWindows"
```

## 版权与使用

上游源码为 MIT 许可，版权归原作者（1suien）所有。本目录只作**本地学习/核对**用，不随本工程再分发，也不含任何账号凭据。`src/main/**` 等桌面端代码与本工程目标（安卓 APK 还原）无关，仅作接口层对照保留。
