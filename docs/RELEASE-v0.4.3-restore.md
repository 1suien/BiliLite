# BiliLite 0.4.3 安卓端 —— 源码还原工程 + 可直接安装的 APK

这是把官方 `BiliLite-0.4.3-android-debug.apk`（4,104,453 B）**还原成可维护源码**的成果，并且用这份源码**真的重新构建出**了一个可安装的 APK。

## 资产

| 文件 | 说明 |
|---|---|
| `BiliLite-0.4.3-debug.apk` | 由本仓库源码构建，4,109,301 B，sha256 `2f056529b49368f68bfba4bcfcb517457a1001fbb6cf92c91d7e3012e14aa1cd`（含 [docs/11](11-0.6.25播放能力移植.md) 的播放交互移植） |

> 与官方同包名 `com.bililite.app`、同版本号（versionCode 7 / versionName 0.4.3）、同 debug 签名类型，但签名证书不同 → 【装过官方版需先卸载】再安装本包。

## 校验

- `aapt dump badging`：package `com.bililite.app`，versionCode `7`，versionName `0.4.3`，minSdk 22，targetSdk 34
- `apksigner verify`：v1 + v2 通过，`CN=Android Debug`
- `zipalign -c -p 4`：通过；`resources.arsc` 未压缩
- APK 内 `assets/public` 与构建目录逐字节一致

## 本版新增（相对上一版资产）

从用户提供的 **BiliLite 0.6.25 原生版**（Compose + Media3/ExoPlayer）逆向结果里，把可移植的播放交互搬了过来（详见 [docs/11](11-0.6.25播放能力移植.md)）：

- **长按倍速** 2×/3×：播放中按住画面不动临时加速，松手恢复
- **双击左退右进**：画面左/右三分之一双击 = ±5/10/15/30 秒（中间双击仍是全屏）
- **连播延迟倒计时**：结束后 0/3/5/10 秒再切下一 P，期间可点「取消」
- **播放时保持屏幕常亮**：Wake Lock 实现，可在设置里关
- **在线字幕秒/毫秒归一化**：移植原生 `dc.Q` 的启发式（`max(to) > max(时长×2, 5000)` 判毫秒）

播放内核仍是 0.4.3 的自研 MSE/DASH 内核；ExoPlayer、前台服务后台播放、离线缓存属于原生独占，搬不过来（原因见 docs/11）。

## 这个还原工程包含什么

- `app/`：Vue 3 + TypeScript + Vite 还原工程（13 条路由、9 个 Pinia store、37 条原生桥通道、自研 DASH 播放内核、IndexedDB 数据层）
- `app/android/`：官方 v0.4.3 的完整 Gradle 工程 + `MainActivity` / `PipPlugin` / `ImmersivePlugin` 三个 Java 插件真源码
- `docs/`：还原方法、接口映射、原生能力、与上游源码的逐模块核对（含 5 份审计报告）、出包记录
- `reference/upstream-v0.4.3/`：上游 MIT 源码快照（带 PROVENANCE）
- `tools/`：解包/比对/审计/出包脚本

## 已知限制

- 本仓库不包含原始 APK、反编译 JS/CSS 等还原依据（见 README「仓库说明」）
- 未在真机上验证启动、登录、播放、沉浸式全屏与画中画（构建环境无安卓设备）
- 构建环境为 aarch64 无 root，aapt2 经 qemu-x86_64 运行，详见 `docs/09-生成可安装APK.md`

## 免责声明

仅供个人学习、研究与备份使用，请勿用于分发或商业用途；BiliLite 与哔哩哔哩相关内容版权归各自所有者。
