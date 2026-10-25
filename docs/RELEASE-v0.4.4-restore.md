# BiliLite 0.4.4 安卓端 —— 源码还原工程 + 可直接安装的 APK

这是把官方 `BiliLite-0.4.4-android-debug.apk`（4,104,456 B）**还原成可维护源码**的成果，并且用这份源码**真的重新构建出**了一个可安装的 APK。

本版相对 0.4.3 只有一处真实行为改动：安卓剧场模式下右上角的「退出剧场」按钮被 `top` + `bottom` 同时约束、拉成贯穿屏幕的竖白条（还压住页面右上角的操作），修法见 [docs/11-0.4.4同步记录.md](../docs/11-0.4.4同步记录.md)；其余是版本号（versionCode 7→8、versionName 0.4.3→0.4.4、bridge 兜底值 `0.4.1`→`0.4.4`）。原生壳（4 个 dex）与官方 0.4.4 APK **逐字节相同**。

## 资产

| 文件 | 说明 |
|---|---|
| `BiliLite-0.4.4-debug.apk` | 由本仓库源码构建，4,107,559 B，sha256 `d7ceccfe86aa17e582b7b380c26f337acb62e1dd0e09bf4ad031004e5fcc81c0` |

> 与官方同包名 `com.bililite.app`、同版本号（versionCode 8 / versionName 0.4.4）、同 debug 签名类型，但签名证书不同 → 【装过官方版需先卸载】再安装本包；若手机里装的是本仓库 0.4.3 产物则可直接覆盖升级（同一 debug 证书、versionCode 更高）。

## 校验

- `aapt dump badging`：package `com.bililite.app`，versionCode `8`，versionName `0.4.4`，minSdk 22，targetSdk 34
- `apksigner verify`：v1 + v2 通过，`CN=Android Debug`
- `zipalign -c -p 4`：通过；`resources.arsc` 未压缩
- APK 内 `assets/public` 与构建目录 `app/dist` 逐字节一致
- 与官方 0.4.4 APK 逐条目比对（排除 `assets/public` 与签名目录）：445 个条目里 444 个哈希相同，唯一不同的是 `assets/capacitor.config.json`（本工程 `webDir` 用 `dist`，官方用 `www`，属还原工程刻意保留的差异）

## 这个还原工程包含什么

- `app/`：Vue 3 + TypeScript + Vite 还原工程（13 条路由、9 个 Pinia store、37 条原生桥通道、自研 DASH 播放内核、IndexedDB 数据层）
- `app/android/`：官方 v0.4.3/v0.4.4 的完整 Gradle 工程 + `MainActivity` / `PipPlugin` / `ImmersivePlugin` 三个 Java 插件真源码
- `docs/`：还原方法、接口映射、原生能力、与上游源码的逐模块核对（含 5 份审计报告）、出包记录、0.4.4 增量记录
- `reference/upstream-v0.4.3/`、`reference/upstream-v0.4.4/`：上游 MIT 源码快照（各带 `PROVENANCE.md`）
- `tools/`：解包/比对/审计/出包脚本

## 已知限制

- 本仓库不包含原始 APK、反编译 JS/CSS 等还原依据（见 README「仓库说明」）
- 未在真机上验证启动、登录、播放、沉浸式全屏、画中画与剧场模式修复（构建环境无安卓设备）
- 构建环境为 aarch64 无 root，aapt2 经 qemu-x86_64 运行，详见 `docs/09-生成可安装APK.md`

## 免责声明

仅供个人学习、研究与备份使用，请勿用于分发或商业用途；BiliLite 与哔哩哔哩相关内容版权归各自所有者。
