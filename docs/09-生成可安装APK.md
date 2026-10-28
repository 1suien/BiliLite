# 09 生成可安装 APK（2026-10-25 实测通过）

本工程的源码**已经真正构建出可安装的 debug APK**。当前产物是 0.4.17（2026-10-28 为「本地『打开文件』改走系统选择器」第十五次出包），0.4.16 / 0.4.15 / 0.4.14 / 0.4.13 / 0.4.12 / 0.4.11 / 0.4.10 / 0.4.9 / 0.4.8 / 0.4.7 / 0.4.6 / 0.4.5 / 0.4.4 / 0.4.3 的历史出包记录保留在下面。

> 0.4.17 / 0.4.16 / 0.4.15 / 0.4.14 / 0.4.13 / 0.4.12 目前只在本地出包，**还没发 GitHub Release**（要发就按同样流程：workflow 的 tag 分支加 `v0.4.17-restore*`、写 `docs/RELEASE-v0.4.17-restore.md`、打 tag 并 push）。上一个已发布版本：[v0.4.11-restore](https://github.com/1suien/BiliLite/releases/tag/v0.4.11-restore)（资产 `BiliLite-0.4.11-debug.apk`，4,105,236 B，sha256 `36210b14…`）。上一版 [v0.4.10-restore](https://github.com/1suien/BiliLite/releases/tag/v0.4.10-restore)（4,105,161 B，sha256 `ff69103d…`）、[v0.4.9-restore](https://github.com/1suien/BiliLite/releases/tag/v0.4.9-restore)（4,105,445 B，sha256 `37e15de5…`）、[v0.4.8-restore](https://github.com/1suien/BiliLite/releases/tag/v0.4.8-restore)（4,108,755 B，sha256 `bb61006c…`）保留。

## 当前产物：`BiliLite-0.4.17-debug.apk`（本机构建）

| 项目 | 值 |
|---|---|
| 文件 | `BiliLite-0.4.17-debug.apk` |
| 大小 | 4,153,163 B |
| SHA-256 | `b49b2d313d7f774af3df4efba6290a1561bb4ab86493104eb8b4a3e0d7507416` |
| versionCode / versionName | `21` / `0.4.17` |
| minSdk / targetSdk / compileSdk | 22 / 34 / 34 |
| 签名 | debug，v1 + v2 通过（v3 false） |
| 构建 | `clean assembleDebug` 26s；又一次 clean 22s，sha 完全相同 |
| 下载 | `http://127.0.0.1:3080/dl/BiliLite-0.4.17-debug.apk`（固定名 `.../dl/BiliLite-latest.apk`，指向本版） |
| 校验 | `aapt2 dump badging` = package com.bililite.app / versionCode 21 / versionName 0.4.17 / minSdk 22 / target 34；`apksigner verify` v1+v2 通过；`zipalign -c -p 4` 通过；APK 内 `assets/public` 与 `app/dist` 逐字节一致（`diff -r` 只多 `cordova.js` / `cordova_plugins.js`） |
| 包内抽查 | 版本串只有 0.4.17；`LocalView-*.js` 含「正在打开系统文件选择器」「原生导入（实验）」；这一版是**纯 web 层改动**（原生侧与 0.4.16 相同，四个插件不变） |

## 上一版产物：`BiliLite-0.4.16-debug.apk`（本机构建）

| 项目 | 值 |
|---|---|
| 文件 | `BiliLite-0.4.16-debug.apk` |
| 大小 | 4,152,761 B（0.4.15 是 4,151,404 B；+1,357 B 是失败回退与诊断的 JS/原生代码） |
| SHA-256 | `1c9cde7f34c54ce11d1b9b92498440857d2a6ebced7c9bf599d85141575990f8` |
| versionCode / versionName | `20` / `0.4.16` |
| minSdk / targetSdk / compileSdk | 22 / 34 / 34 |
| 签名 | debug，v1 + v2 通过（v3/v3.1/v4 false） |
| 构建 | web `npm run build` 7.99s → `cap sync` 0.81s → Gradle `clean assembleDebug` **33s**（302 tasks / 251 executed）；再跑一次 clean **34s**，两次 sha256 相同 |
| 校验 | `aapt2 dump badging` = `com.bililite.app` / versionCode 20 / versionName 0.4.16 / minSdk 22 / target 34；`apksigner verify` v1+v2 通过；`zipalign -c -p 4` 通过；APK 内 `assets/public` 与 `app/dist` 逐字节一致（`diff -r` 只多 `cordova.js` / `cordova_plugins.js`） |
| 包内抽查 | `LocalMediaPlugin` 新增 `diagnose()` 与 `ACTION_GET_CONTENT` 兜底（`classes*.dex` 里能搜到 `local:diagnose` 相关的 JS 字符串）；版本串只有 0.4.16 |
| 下载 | `http://127.0.0.1:3080/dl/BiliLite-0.4.16-debug.apk`（固定名 `.../dl/BiliLite-latest.apk`，指向本版） |

## 更早的产物：`BiliLite-0.4.15-debug.apk`（本机构建）

| 项目 | 值 |
|---|---|
| 文件 | `BiliLite-0.4.15-debug.apk` |
| 大小 | 4,151,404 B（0.4.14 是 4,142,542 B；+8,862 B 主要是新增 `LocalMediaPlugin` 与分享 Intent 处理） |
| SHA-256 | `a8b0bd8ad0293d508d496d4186dfb8a857440198abc643ecb5658289a9665c1d` |
| versionCode / versionName | `19` / `0.4.15` |
| minSdk / targetSdk / compileSdk | 22 / 34 / 34 |
| 签名 | debug，v1 + v2 通过（v3/v3.1/v4 false） |
| 构建 | web `npm run build` 6.89s → `cap sync` 0.83s → Gradle 增量 `assembleDebug` 19s；`clean assembleDebug` **42s**，再跑一次 clean **28s**，两次 sha256 相同 |
| 决定产物 | 用 `clean assembleDebug` 的输出（增量包条目之间会留大量对齐 padding，比 clean 包大 ~160 KB，安装使用没问题但仓库里存 clean 包） |
| 校验 | `aapt2 dump badging` = `com.bililite.app` / versionCode 19 / versionName 0.4.15 / minSdk 22 / target 34；`apksigner verify` v1+v2 通过；`zipalign -c -p 4` 通过；APK 内 `assets/public` 与 `app/dist` 逐字节一致（`diff -r` 只多 `cordova.js` / `cordova_plugins.js`） |
| 包内抽查 | `AndroidManifest.xml` 有 3 个 intent-filter（`ACTION_SEND` / `SEND_MULTIPLE` / `VIEW`，各带 `video/*`、`audio/*`）；`classes4.dex` 有 5 处 `LocalMediaPlugin` / `local-media` / `sharedPending`；`assets/public/assets/index-*.js` 含 `localShare` 与「已收到」；版本串只有 0.4.15 |
| 下载 | `http://127.0.0.1:3080/dl/BiliLite-0.4.15-debug.apk`（固定名 `.../dl/BiliLite-latest.apk`，指向本版） |

## 更早的产物：`BiliLite-0.4.14-debug.apk`（本机构建）

| 项目 | 值 |
|---|---|
| 文件 | `BiliLite-0.4.14-debug.apk` |
| 大小 | 4,142,542 B（0.4.13 是 4,169,861 B；-27,319 B 主要是删掉自定义提示音 WAV） |
| SHA-256 | `526a82a55acf4ed76213f168a99f209c4915c8dd3b8bd76c88c121e8c9a2e9c7` |
| package | `com.bililite.app` |
| versionCode / versionName | `18` / `0.4.14` |
| minSdk / targetSdk / compileSdk | 22 / 34 / 34 |
| 签名 | debug，CN=Android Debug，APK Signature Scheme v1 + v2（v3/v3.1/v4 false） |
| 构建 | web `npm run build` 7.47s + `cap sync` 0.88s；`clean assembleDebug` 冷构建 **1m 52s**（302 tasks / 251 executed，复跑一次 49s） |
| 可复现 | 两次 `clean` 后重建的 APK 与仓库产物 sha256 **完全相同** |

0.4.14 = 两项（本机定制）：**课表精简** —— 弹窗删掉「地点 / 老师 / 开始 / 结束」，只留「提醒时间」（`Course.remindAt`，Dexie `courses` 升 v9）；**通知换系统默认提示音** —— 自定义 WAV 在部分 ROM 上静音，改用原生插件 `ReminderChannelPlugin` 建的 `bililite-reminders-v2` 通道（`Settings.System.DEFAULT_NOTIFICATION_URI`），并在设置页加「测试通知 / 通知设置」两个按钮。改动与 29/29 + 16/16 验证见 [21-课表精简与通知声音.md](21-课表精简与通知声音.md)。**原生侧第二次改动**（新增 1 个 Java 插件、删掉 `res/raw/bililite_reminder.wav`）。

校验：`aapt2 dump badging` = package `com.bililite.app` / versionCode 18 / versionName 0.4.14 / minSdk 22 / target 34；`apksigner verify` v1+v2 通过；`zipalign -c -p 4` 通过；APK 内 `assets/public` 与 `app/dist` 逐字节一致（`diff -r` 只多 `cordova.js` / `cordova_plugins.js`）；包内**没有** `res/raw/bililite_reminder.wav`，`classes4.dex` 含 `ReminderChannel` / `bililite-reminders-v2`，权限含 `SCHEDULE_EXACT_ALARM` / `USE_EXACT_ALARM` / `RECEIVE_BOOT_COMPLETED` / `WAKE_LOCK` / `POST_NOTIFICATIONS`。

## 更早的产物：`BiliLite-0.4.13-debug.apk`（本机构建）

| 项目 | 值 |
|---|---|
| 文件 | `BiliLite-0.4.13-debug.apk` |
| 大小 | 4,169,861 B（0.4.12 是 4,117,107 B；+52,754 B 是通知插件与提示音） |
| SHA-256 | `c590aa884e349f6c46cba46a5718693bfd28b8a5bdfc24ad7eb2c69b277fd24e` |
| package | `com.bililite.app` |
| versionCode / versionName | `17` / `0.4.13` |
| minSdk / targetSdk / compileSdk | 22 / 34 / 34 |
| 签名 | debug，CN=Android Debug，APK Signature Scheme v1 + v2（v3/v3.1/v4 false） |
| 构建 | web `npm run build` 6.87s + `cap sync` 0.78s；增量 `assembleDebug` **12s**（290 tasks / 23 executed）；`clean assembleDebug` 冷构建 **46s**（302 tasks / 252 executed，复跑一次 42s） |
| 可复现 | 两次 `clean` 后重建的 APK 与仓库产物 sha256 **完全相同** |

## 更早的产物：`BiliLite-0.4.12-debug.apk`（本机构建）

| 项目 | 值 |
|---|---|
| 文件 | `BiliLite-0.4.12-debug.apk` |
| 大小 | 4,117,107 B（0.4.11 是 4,105,236 B） |
| SHA-256 | `4a2aa44cf24260207cfaa6bd10f9f08bc25ced0baa41a45454688cf60427162f` |
| package | `com.bililite.app` |
| versionCode / versionName | `16` / `0.4.12` |
| minSdk / targetSdk / compileSdk | 22 / 34 / 34 |
| 签名 | debug，CN=Android Debug，APK Signature Scheme v1 + v2（v3/v3.1/v4 false） |
| 构建 | web `npm run build` 7.44s + `cap sync` 0.81s；增量 `assembleDebug` **52s**（264 tasks / 29 executed）；`clean assembleDebug` 冷构建 **1m 20s**（275 tasks / 230 executed） |
| 可复现 | `clean` 后重建的 APK 与增量构建 sha256 **完全相同** |

0.4.13 = 三项（本机定制 + 修复，上游没有）：**提醒能出 App** —— 专注/习惯/课表的到点提醒除 App 内卡片外，还会经 `@capacitor/local-notifications` 排进安卓系统通知（App 退后台/锁屏也能收到），带自定义提示音 `res/raw/bililite_reminder.wav`，点通知直接跳对应页面；App 内提醒卡片改到**屏幕最右下角**（出现时右下角刷新浮钮让位）；**修备份 bug** —— 安卓上「写入 JSON 备份」不再被「请先选择备份目录」拦住（直接写 Documents/Cache 后弹系统「保存到」）；**学习页瘦身** —— 删掉标题行、三张统计卡、「导出 JSON」「清空」按钮。改动与 13/13 验证见 [20-系统通知与备份修复.md](20-系统通知与备份修复.md)。**这一版原生侧首次有改动**（新增通知插件、提示音资源与精确闹钟权限）。

校验：`aapt2 dump badging` = package `com.bililite.app` / versionCode 17 / versionName 0.4.13 / minSdk 22 / target 34；`apksigner verify` v1+v2 通过；`zipalign -c -p 4` 通过；APK 内 `assets/public` 与 `app/dist` 逐字节一致（`diff -r` 只多 `cordova.js` / `cordova_plugins.js`）；含 `res/raw/bililite_reminder.wav`（28,708 B），权限含 `SCHEDULE_EXACT_ALARM` / `USE_EXACT_ALARM` / `RECEIVE_BOOT_COMPLETED` / `WAKE_LOCK` / `POST_NOTIFICATIONS`，dex 里能搜到 local-notifications 插件类。
**专注目标可设多个提醒时间**（每目标最多 8 个，到点弹右下角卡片）；**习惯打卡弹打卡心得**（可选填、存进打卡记录、日志可见），习惯到点提醒也从「6 秒 toast / 系统通知」改成**右下角常驻卡片**；**新增周课表**（7 列、可关联 B 站视频与专注目标、到点提醒）。改动与 27/27 + 19/19 验证见 [19-多提醒-打卡心得与课表.md](19-多提醒-打卡心得与课表.md)。

校验：`aapt2 dump badging` = package `com.bililite.app` / versionCode 16 / versionName 0.4.12 / minSdk 22 / target 34；`apksigner verify` v1+v2 通过；`zipalign -c -p 4` 通过；APK 内 `assets/public` 与 `app/dist` 逐字节一致（`diff -r` 只多 `cordova.js` / `cordova_plugins.js`）；原生侧仍与 0.4.4 官方产物逐字节相同（只有 web 层与版本号变）。

## 更早的产物：`BiliLite-0.4.11-debug.apk`（本机构建）

| 项目 | 值 |
|---|---|
| 文件 | `BiliLite-0.4.11-debug.apk` |
| 大小 | 4,105,236 B |
| SHA-256 | `36210b14fffce2cb3dc56e62e9dbffebe7731999b14f6d45317e26edc7ea494a` |
| versionCode / versionName | `15` / `0.4.11` |
| 构建 | web `npm run build` 7.09s + `cap sync` 0.74s；增量 `assembleDebug` 36s；`clean assembleDebug` 冷构建 57s |
| 说明 | 退出播放页后再次播放接着上次的进度，见 [18-退出后继续上次进度.md](18-退出后继续上次进度.md) |

## 更早的产物：`BiliLite-0.4.10-debug.apk`（本机构建）

| 项目 | 值 |
|---|---|
| 文件 | `BiliLite-0.4.10-debug.apk` |
| 大小 | 4,105,161 B（0.4.9 是 4,105,445 B） |
| SHA-256 | `ff69103ddef60fa82b93687a9d48b83f026a931afed6d8b693b82cb7bc37cc73` |
| package | `com.bililite.app` |
| versionCode / versionName | `14` / `0.4.10` |
| minSdk / targetSdk / compileSdk | 22 / 34 / 34 |
| 签名 | debug，CN=Android Debug，APK Signature Scheme v1 + v2（v3/v3.1/v4 false） |
| 构建 | web `npm run build` 9.28s + `cap sync` 0.99s；增量 `assembleDebug` **57s**（264 tasks / 29 executed）；`clean assembleDebug` 冷构建 **1m46s**（275 tasks / 230 executed） |
| 可复现 | `clean` 后重建的 APK 与增量构建 sha256 **完全相同** |

0.4.10 = 0.4.9 + 一处本机删减（上游没有）：**删掉「自带的专注目标」**——不再用 阅读/刷题/看课/整理笔记 四个默认值自动创建目标（全新安装列表为空），旧版本留下的这四个预设升级后一次性清掉（`focusPresetsCleared` 标记），并删掉两处「恢复默认」入口。改动与 11/11 验证见 [17-删除自带专注目标.md](17-删除自带专注目标.md)。

## 更早的产物：`BiliLite-0.4.9-debug.apk`（本机构建）

| 项目 | 值 |
|---|---|
| 文件 | `BiliLite-0.4.9-debug.apk` |
| 大小 | 4,105,445 B（0.4.8 是 4,108,755 B，少了一个首页 chunk） |
| SHA-256 | `37e15de561925ca4ab53c643d456f9a2017e4a4c27af21ed0dd07db93fec0c3f` |
| package | `com.bililite.app` |
| versionCode / versionName | `13` / `0.4.9` |
| minSdk / targetSdk / compileSdk | 22 / 34 / 34 |
| 签名 | debug，CN=Android Debug，APK Signature Scheme v1 + v2（v3/v4 false） |
| 构建 | web `npm run build` 7.90s + `cap sync` 0.96s；增量 `assembleDebug` **57s**（264 tasks / 29 executed）；`clean assembleDebug` 冷构建 **54s**（275 tasks / 230 executed） |
| 可复现 | `clean` 后重建的 APK 与增量构建 sha256 **完全相同** |

0.4.9 = 0.4.8 + 一处本机删减（上游没有）：**删除「首页」**——左侧导航条目、`/` 路由、`views/HomeView.vue` 文件全删，打开 App 直接进「学习」页；`#/` 与旧地址 `#/home` 都自动落到 `#/learn`。改动、影响与 10/10 验证见 [16-删除首页.md](16-删除首页.md)。

校验：`aapt2 dump badging` = package `com.bililite.app` / versionCode 13 / versionName 0.4.9 / minSdk 22 / target 34；`apksigner verify` v1+v2 通过；`zipalign -c -p 4` 通过；APK 内 `assets/public` 与 `app/dist` 逐字节一致（`diff -r` 只多 `cordova.js` / `cordova_plugins.js`）；包内**没有** HomeView chunk、没有 `HomeView` 字样，版本串只有 0.4.9；`LearnView` chunk 含「去搜索找视频」、`VideoView` chunk 含「回学习」；原生侧仍与 0.4.4 官方产物逐字节相同（只有 web 层与版本号变）。

## 更早的产物：`BiliLite-0.4.8-debug.apk`（本机构建）

| 项目 | 值 |
|---|---|
| 文件 | `BiliLite-0.4.8-debug.apk` |
| 大小 | 4,108,755 B（官方 0.4.4 APK 是 4,104,456 B） |
| SHA-256 | `bb61006c654f1d49eb04bee9fe9cdc8a3fd35ffc51310d9c45c94de041e20ca1` |
| package | `com.bililite.app` |
| versionCode / versionName | `12` / `0.4.8` |
| minSdk / targetSdk / compileSdk | 22 / 34 / 34 |
| 签名 | debug，CN=Android Debug，APK Signature Scheme v1 + v2（v3/v4 false） |
| 构建 | web `npm run build` 12.39s + `cap sync` 1.34s；增量 `assembleDebug` **1m20s**（264 tasks / 29 executed）；`clean assembleDebug` 冷构建 **2m15s**（275 tasks / 230 executed） |
| 可复现 | `clean` 后重建的 APK 与增量构建 sha256 **完全相同** |

0.4.8 = 0.4.7 + 一处本机定制（上游没有）：**离开播放页时视频自动缩成右下角小圆并暂停**——点左侧导航、首页卡片、返回等任何页面切换都会触发；点小圆回播放页从暂停处**自动继续播**；同页换分P、换视频、刷新/关窗口、拉流失败都不触发。改动与 18/18 验证见 [15-离开播放页自动暂停小窗.md](15-离开播放页自动暂停小窗.md)。

校验：`aapt2 dump badging` = package `com.bililite.app` / versionCode 12 / versionName 0.4.8 / minSdk 22 / target 34；`apksigner verify` v1+v2 通过；`zipalign -c -p 4` 通过；APK 内 `assets/public` 与 `app/dist` 逐字节一致（`diff -r` 只多 `cordova.js` / `cordova_plugins.js`）；包内无 `jumpNote`，含「视频已缩到右下角小圆圈并暂停」「已暂停 · 点一下回到视频页继续看」，版本串只有 0.4.8；原生侧与 0.4.4 产物仍逐字节相同（只有 web 层与版本号变）。

## 更早的产物：`BiliLite-0.4.7-debug.apk`（本机构建）

| 项目 | 值 |
|---|---|
| 文件 | `BiliLite-0.4.7-debug.apk` |
| 大小 | 4,108,456 B（官方 0.4.4 APK 是 4,104,456 B） |
| SHA-256 | `bee3d8169cc0d0db914c12b51799dfbb76a4138ac588a78501e43017e5d9f8bc` |
| package | `com.bililite.app` |
| versionCode / versionName | `11` / `0.4.7` |
| minSdk / targetSdk / compileSdk | 22 / 34 / 34 |
| 签名 | debug，CN=Android Debug，APK Signature Scheme v1 + v2（v3/v4 false） |
| 构建 | 增量 `assembleDebug` **1m03s**（264 tasks / 29 executed）；`clean assembleDebug` 冷构建 **1m02s**（275 tasks / 230 executed） |
| 可复现 | `clean` 后重建的 APK 与增量构建 sha256 **完全相同** |

0.4.7 = 0.4.6 + 两处界面调整（上游没有）：①笔记行去掉「▶ 跳转」按钮（用户要「完全不要跳转」），删除按钮挪到整行最右；②播放页「小窗播放」文字按钮改成圆形图标入口，播放中的视频从长方形小窗改成右下角 **112×112 圆形气泡**——点气泡回到播放页并从当前进度继续、可拖动、跨页面常驻、右上角 × 关闭。改动与 17/17 验证见 [14-小窗圆形气泡与笔记行按钮.md](14-小窗圆形气泡与笔记行按钮.md)。

校验：`aapt2 dump badging` = package `com.bililite.app` / versionCode 11 / versionName 0.4.7 / minSdk 22 / target 34；`apksigner verify` v1+v2 通过；`zipalign -c -p 4` 通过；APK 内 `assets/public` 与 `app/dist` 逐字节一致（`diff -r` 只多 `cordova.js` / `cordova_plugins.js`）；包内 JS 已无 `jumpNote`，有 `note-del`/`mini-entry`/`mp-ring`，版本串只有 0.4.7；原生侧与 0.4.4 产物仍逐字节相同（只有 web 层与版本号变）。

## 更早的产物：`BiliLite-0.4.6-debug.apk`（本机构建）

| 项目 | 值 |
|---|---|
| 文件 | `BiliLite-0.4.6-debug.apk` |
| 大小 | 4,109,055 B（官方 0.4.4 APK 是 4,104,456 B） |
| SHA-256 | `b34d26d539fa93c62032c661ac5147c681dbe846d27472e381fa74f5c7da16c8` |
| package | `com.bililite.app` |
| versionCode / versionName | `10` / `0.4.6` |
| minSdk / targetSdk / compileSdk | 22 / 34 / 34 |
| 签名 | debug，CN=Android Debug，APK Signature Scheme v1 + v2 |
| 构建 | 增量 `assembleDebug` 1m03s；`clean assembleDebug` 冷构建 **1m49s**（275 tasks，230 executed） |
| 可复现 | `clean` 后重建的 APK 与增量构建 sha256 **完全相同** |

0.4.6 = 0.4.5 + 备份交互修正与导入恢复（上游没有）：安卓上不再显示名不副实的「备份目录 / 打开」（隐藏后改成「备份位置」说明），新增「恢复学习数据 → 打开 JSON 备份…」，选一份导出的 `.json` 与现有数据**合并**恢复（进度按 `updatedAt` 取新、每日时长取大、清单按 `bvid` 取新、笔记按 `bvid+cid+at+text` 去重）。改动与验证见 [13-备份打开与导入恢复.md](13-备份打开与导入恢复.md)。校验：`aapt dump badging` versionCode 10 / versionName 0.4.6 / minSdk 22 / target 34；`apksigner verify` v1+v2 通过；`zipalign -c -p 4` 通过；APK 内 `assets/public` 与 `app/dist` 逐字节一致（`diff -r` 只多 `cordova.js` / `cordova_plugins.js`）；原生侧与 0.4.4 产物相同（只有 web 层与版本号变）。

## 更早的产物：`BiliLite-0.4.5-debug.apk`（本机构建）

| 项目 | 值 |
|---|---|
| 文件 | `BiliLite-0.4.5-debug.apk` |
| 大小 | 4,107,722 B（官方 0.4.4 APK 是 4,104,456 B） |
| SHA-256 | `9f0bda8d9e9a74810dd55815fb74b4f2169a539c2b67da18ba15a6890186e6c4` |
| package | `com.bililite.app` |
| versionCode / versionName | `9` / `0.4.5` |
| minSdk / targetSdk / compileSdk | 22 / 34 / 34 |
| 签名 | debug，CN=Android Debug，APK Signature Scheme v1 + v2 |
| 构建 | 增量 `assembleDebug` 16s（264 tasks，29 executed）；`clean assembleDebug` 冷构建 **1m 02s**（275 tasks，230 executed） |
| 可复现 | `clean` 后重建的 APK 与增量构建 sha256 **完全相同** |

0.4.5 = 0.4.4 + 两项本机改动（上游没有）：笔记按 `bvid + cid`（分P）独立、输入框改多行 textarea（回车换行，Ctrl+Enter 或「保存」按钮写入）。改动、验证与升级说明见 [12-笔记按分P独立.md](12-笔记按分P独立.md)。校验：`aapt dump badging` versionCode 9 / versionName 0.4.5 / minSdk 22 / target 34；`apksigner verify` v1+v2 通过；`zipalign -c -p 4` 通过；APK 内 `assets/public` 与 `app/dist` 逐字节一致（`diff -r` 只多 `cordova.js` / `cordova_plugins.js`）；原生侧与 0.4.4 产物相同（只有 web 层与版本号变）。

## 更早的产物：`BiliLite-0.4.4-debug.apk`

| 项目 | 值 |
|---|---|
| 文件 | `BiliLite-0.4.4-debug.apk` |
| 大小 | 4,107,559 B（官方 0.4.4 APK 是 4,104,456 B） |
| SHA-256 | `d7ceccfe86aa17e582b7b380c26f337acb62e1dd0e09bf4ad031004e5fcc81c0` |
| package | `com.bililite.app` |
| versionCode / versionName | `8` / `0.4.4` |
| minSdk / targetSdk / compileSdk | 22 / 34 / 34 |
| 签名 | debug，CN=Android Debug，APK Signature Scheme v1 + v2 |
| 构建 | 增量 `assembleDebug` 55s（264 tasks，29 executed）；`clean assembleDebug` 冷构建 **1m50s**（275 tasks，230 executed） |
| 可复现 | `clean` 后重建的 APK 与增量构建 sha256 **完全相同** |

0.4.4 相对 0.4.3 只同步了 3 处版本号 + 1 处安卓剧场模式 CSS 修复（上游 `v0.4.4`），过程、逐条目比对与校验细节见 [11-0.4.4同步记录.md](11-0.4.4同步记录.md)。要点：

- `aapt dump badging`：versionCode `8` / versionName `0.4.4` / minSdk 22 / target 34 / label `BiliLite`；
- `apksigner verify` v1+v2 通过；`zipalign -c -p 4` 通过；APK 内 `assets/public` 与 `app/dist` 逐字节一致；
- **与官方 0.4.4 APK 逐条目比对**（排除 `assets/public` 与 `META-INF`）：445 个条目中 444 个 sha256 相同，唯一差异是 `assets/capacitor.config.json` 的 `webDir`（`dist` vs `www`，还原工程刻意保留）；4 个 `classes*.dex` / `AndroidManifest.xml` / `resources.arsc` 与官方**逐字节相同**。

## 首次出包记录：`BiliLite-0.4.3-debug.apk`（2026-10-25）

| 项目 | 值 |
|---|---|
| 文件 | `BiliLite-0.4.3-debug.apk`（仓库内保留作对照） |
| 大小 | 4,107,542 B（官方 0.4.3 APK 是 4,104,453 B） |
| SHA-256 | `b4fd3333abe25a1e2881ca142ee187ad7bca0d015398c4cd81babb0e7350abe3` |
| package | `com.bililite.app` |
| versionCode / versionName | `7` / `0.4.3` |
| minSdk / targetSdk / compileSdk | 22 / 34 / 34 |
| 签名 | debug，CN=Android Debug，APK Signature Scheme v1 + v2 |
| 构建 | `./gradlew assembleDebug`，BUILD SUCCESSFUL in 4m 39s，264 tasks |

构建来源：`app/`（还原工程）→ `npm run build` → `npm run sync` → `app/android`（官方 Gradle 工程）→ `gradlew assembleDebug`。中间产物在 `app/android/app/build/outputs/apk/debug/app-debug.apk`。

## 校验结果

```bash
# 包信息
aapt dump badging BiliLite-0.4.4-debug.apk
#   package: name='com.bililite.app' versionCode='8' versionName='0.4.4'
#   sdkVersion:'22'  targetSdkVersion:'34'  application-label:'BiliLite'

# 签名
apksigner verify --verbose BiliLite-0.4.4-debug.apk
#   Verified using v1 scheme (JAR signing): true
#   Verified using v2 scheme (APK Signature Scheme v2): true

# 对齐（resources.arsc 必须 4 字节对齐且不压缩，Android 11+ 强制检查）
zipalign -c -p 4 BiliLite-0.4.4-debug.apk   # → 通过
# zip 检查：resources.arsc compress_type=0（stored）296,232 B

# web 资源与本工程构建产物逐字节一致
unzip -q BiliLite-0.4.4-debug.apk 'assets/public/*'
diff -r assets/public app/dist   # → 无差异
```

0.4.4 出包后原生侧与官方 APK 的关系变了：`classes.dex`（及 `classes2/3/4.dex`）、`AndroidManifest.xml`、`resources.arsc`、`res/**` 与官方 0.4.4 APK **逐字节相同**，唯一差异是 `assets/capacitor.config.json` 的 `webDir`（`dist` vs `www`，还原工程刻意保留）——逐条目比对见 [11-0.4.4同步记录.md](11-0.4.4同步记录.md)。0.4.3 首次出包时这几项与官方不同（当时是本地重新编译、AGP 版本与签名顺序不同），属正常。

## 构建环境（aarch64、无 root、无 Java/SDK 的机器上从零搭出来）

这台机器是 aarch64、非 root、起初没有 JDK / Android SDK，且 `apt-get` 安装需要 root。做法是全部解压到 `/opt/toolchain` 用户目录，不碰系统：

| 组件 | 版本 / 做法 |
|---|---|
| JDK | Temurin **17.0.13** aarch64（Gradle 8.2.1 不支持 JDK 21；Debian 只提供 21，且其 `java.security` 在 `/etc` 下，解压后不可用） |
| Android SDK | cmdline-tools **12.0** → `sdkmanager "platforms;android-34" "build-tools;34.0.0"`（sdkmanager 必须用 JDK 17 跑，JDK 21 的 Debian 包会抛 `JceSecurity` 异常） |
| Gradle | wrapper 自动下载 `gradle-8.2.1-bin.zip`（约 130 MB），依赖从 Google Maven 拉取（缓存约 540 MB） |
| aapt2 | **关键坑**：Google 的 aapt2 只有 x86_64 版。用 `qemu-x86_64-static` + amd64 glibc rootfs（`/opt/x86root`：libc6 / libstdc++6 / libgcc-s1 / zlib1g 的 amd64 deb 解压）跑 `build-tools/34.0.0/aapt2`，再通过 AGP 的 `-Pandroid.aapt2FromMavenOverride=` 指过去（脚本见 `tools/build/aapt2-qemu.sh`） |
| 内存 | 主机剩余内存不足 1 GB，用 `-Dorg.gradle.jvmargs="-Xmx900m -XX:MaxMetaspaceSize=320m"` 临时覆盖（增量构建可用 `-Xmx1200m`），不改 `app/android/gradle.properties` 里的 `-Xmx2560m` |

复现命令（0.4.4 实测通过的形态）：

```bash
cd app
npm run build && npm run typecheck
npm run sync    # = cap sync android

cd android
printf 'sdk.dir=/opt/android-sdk\n' > local.properties
JAVA_HOME=/opt/toolchain/jdk17 PATH=/opt/toolchain/jdk17/bin:$PATH \
GRADLE_USER_HOME=/tmp/gradle-home ./gradlew --no-daemon --max-workers=2 --offline \
  -Pandroid.aapt2FromMavenOverride=/opt/toolchain/aapt2-bin/aapt2 \
  -Dorg.gradle.jvmargs="-Xmx900m -XX:MaxMetaspaceSize=320m -Dfile.encoding=UTF-8" \
  clean assembleDebug
# 产物：app/android/app/build/outputs/apk/debug/app-debug.apk
```

aarch64 上跑之前要把 qemu 加进 PATH（`export PATH=/opt/toolchain/usr/bin:$PATH`，`qemu-x86_64-static` 在 `/opt/toolchain/usr/bin`），aapt2 代理也可换成 `tools/build/aapt2-qemu.sh`；x86_64 机器上不需要 qemu，直接 `tools/build/build-apk.sh`（JDK 17 + Android SDK 即可）。本沙箱 uid 在 `/etc/passwd` 里没有条目，`cap sync` 会抛 `uv_os_get_passwd returned ENOENT`，用 `NODE_OPTIONS="--require /tmp/patch-userinfo.cjs"` 兜一下（普通机器不需要）。

## 备用出包方案（不需要 JDK / Gradle / aapt2）

aarch64 上如果不想折腾 qemu，也可以「重打包」：官方 APK 的原生壳（classes.dex、资源、Manifest）与我们的壳完全相同，只要把 `assets/public` 换成自己构建的产物再重签：

```bash
python3 tools/build/repack-apk.py \
  --base .work/apk-0.4.4/BiliLite-0.4.4-android-debug.apk \
  --web  app/dist \
  --out  /tmp/repacked-unsigned.apk
zipalign -p -f 4 /tmp/repacked-unsigned.apk /tmp/repacked-aligned.apk
apksigner sign --ks debug.keystore --ks-pass pass:android --key-pass pass:android \
  --min-sdk-version 22 --out BiliLite-0.4.4-repacked.apk /tmp/repacked-aligned.apk
```

此方案在 0.4.3 上实测通过（3,781,178 B，签名/对齐/安装校验同样通过；`classes.dex`、`AndroidManifest.xml`、`resources.arsc` 与官方 APK 逐字节相同），适合只改了 web 资源、想快速出包的场景。注意重打包产物的原生侧就等于官方包，出包后仍要做一遍 `apksigner verify` / `zipalign -c` 和 web 资源 diff。

## 安装

**浏览器直接下载**（本机 DSH Web 上装了 `@local/download-route` 插件，源码在 `tools/dsh-download-route/`，把工作目录做成只读下载路由；只在回环地址下用）：

**固定文件名入口（推荐，方便覆盖本地那份）**：`http://127.0.0.1:3080/dl/BiliLite-latest.apk`。它指向仓库根的软链 `BiliLite-latest.apk` → 版本号最大的产物，重复下载得到的是同名文件（选「替换」就覆盖了旧的）。每次出完新包跑一次 `tools/build/link-latest-apk.sh` 刷新软链即可。

```
http://127.0.0.1:3080/dl/BiliLite-latest.apk        # ★ 固定名，指向最新版本（软链）
http://127.0.0.1:3080/dl/BiliLite-0.4.17-debug.apk  # 最新（带版本号）
http://127.0.0.1:3080/dl/BiliLite-0.4.16-debug.apk  # 上一版
http://127.0.0.1:3080/dl/BiliLite-0.4.15-debug.apk  # 上一版
http://127.0.0.1:3080/dl/BiliLite-0.4.14-debug.apk  # 旧版本也留着
http://127.0.0.1:3080/dl/BiliLite-0.4.13-debug.apk  # 旧版本也留着
http://127.0.0.1:3080/dl/BiliLite-0.4.12-debug.apk  # 旧版本也留着
http://127.0.0.1:3080/dl/BiliLite-0.4.11-debug.apk  # 上一版
http://127.0.0.1:3080/dl/BiliLite-0.4.10-debug.apk  # 旧版本也留着
http://127.0.0.1:3080/dl/BiliLite-0.4.9-debug.apk   # 旧版本也留着
http://127.0.0.1:3080/dl/BiliLite-0.4.8-debug.apk   # 旧版本也留着
http://127.0.0.1:3080/dl/BiliLite-0.4.7-debug.apk   # 旧版本也留着
http://127.0.0.1:3080/dl/BiliLite-0.4.6-debug.apk
http://127.0.0.1:3080/dl/BiliLite-0.4.5-debug.apk
```

地址栏回车即下载（`Content-Disposition: attachment`，MIME `application/vnd.android.package-archive`，4,108,755 B，sha256 `bb61006c…`）。路由只允许 `config.dir`（默认 `/root/学习软件`）内的相对路径，`..` 穿越返回 403。

**adb / 拷贝**：

```bash
adb install -r BiliLite-0.4.17-debug.apk
# 或拷到手机点安装（需允许「安装未知来源应用」）
```

注意：与官方 APK **包名相同、签名不同**，手机上已装官方 0.4.3/0.4.4 的话会报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`，需要先卸载官方版（卸载会清掉该应用本地数据）；装的是本仓库 0.4.3–0.4.16 产物的可以直接覆盖升级（同 debug 签名，versionCode 21 > 20 > 19 > 18 > 17 > 16 > 15 > 14 > 13 > 12 > 11 > 10 > 9 > 8 > 7）。

## 未验证

- 真机启动、登录、播放（B 站接口需要外网与本机 cookie）；
- 沉浸式全屏与画中画（`ImmersivePlugin` / `PipPlugin`）没有真机可测；
- 本机没有 `adb`/模拟器，安装与首启未实测，只做了 apksigner/zipalign/aapt 层面的静态校验。
