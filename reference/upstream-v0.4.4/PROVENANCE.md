# 上游官方源码增量快照（tag `v0.4.4`）— 出处与用途

## 出处

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/1suien/BiliLite |
| tag | `v0.4.4` |
| commit | `8506f1b3b3f41db4edea4877b68aea196c4e6301` |
| commit 时间 | 2026-10-16 22:05:26 +0800 |
| commit 说明 | `fix(mobile): 剧场模式「退出剧场」被拉成竖白条（v0.4.4）` |
| 许可 | MIT（GitHub 仓库标注） |
| 快照方式 | `git clone --depth 1 --branch v0.4.4`；本目录内每个文件与 `git show v0.4.4:<path>` 的 blob 逐字节一致 |
| 抓取时间 | 本机 2026-10-25 |

## 为什么只有增量文件

`v0.4.4` 相对 `v0.4.3` **只改动了 6 个文件**（其中 4 个影响构建产物）：

| 文件 | 改动 |
|---|---|
| `src/mobile/mobile.css` | 安卓剧场模式「退出剧场」CSS 修复（本次唯一的行为改动） |
| `src/mobile/bridge.js` | `getAppVersion()` 兜底值 `'0.4.1'` → `'0.4.4'` |
| `mobile/package.json` | `version` 0.4.3 → 0.4.4 |
| `mobile/android/app/build.gradle` | `versionCode 7` → `8`，`versionName "0.4.3"` → `"0.4.4"` |
| `README.md`、`mobile/README.md` | 只改文案（记录这次修复与实测数据） |

其余全部文件与 `v0.4.3` 逐字节相同，因此 `reference/upstream-v0.4.3/`（完整快照）+ 本目录（4 个改动文件 + `CHANGES.diff`）= 完整的 `v0.4.4` 源码树，不必再存一份 1.1 MB 的重复快照。

- `CHANGES.diff`：`v0.4.3` → `v0.4.4` 的**完整 unified diff**（含两个 README 的文案改动）。
- 本目录复制的文件：`src/mobile/mobile.css`、`src/mobile/bridge.js`、`mobile/package.json`、`mobile/android/app/build.gradle`、`mobile/README.md`（文案对照用）。
- 核对命令（需要先按 `reference/upstream-v0.4.3/PROVENANCE.md` 的方式拿到上游仓库）：

```bash
cd <upstream-clone>
git diff v0.4.3 v0.4.4            # 应与本目录 CHANGES.diff 等价
git show v0.4.4:src/mobile/mobile.css | sha256sum
sha256sum reference/upstream-v0.4.4/src/mobile/mobile.css   # 两者应相同
```

## 这 6 个文件在 APK 上怎么验证

官方 `BiliLite-0.4.4-android-debug.apk`（4,104,456 B，sha256 `0a01c318da93fa83237b3ebaf06ba839b5f5a801c29add294d32c944e4b25062`）与 0.4.3 的 APK 比对：

- `AndroidManifest.xml`：只有 `versionCode 7→8`、`versionName 0.4.3→0.4.4` 两个字段不同；
- `assets/public/assets/index-*.css`：压缩后的安卓平台段与上游 `mobile.css` 的新写法一一对应（`page-float` 单独给 `bottom`、`theater-exit` 给 `top/right`、`.app.theater .scroll { padding-top: 60px }`）；
- `assets/public/assets/index-*.js`：`getAppVersion` 的兜底字符串从 `0.4.1` 变成 `0.4.4`；
- 4 个 `classes*.dex`、`resources.arsc`、`res/**`、`assets/native-bridge.js`、`capacitor.config.json`、`capacitor.plugins.json` **哈希全部一致**——这也从产物侧证明「原生壳一行没动」。

## 与本还原工程的关系

`app/` 已于 2026-10-25 从 0.4.3 升到 0.4.4，改动点与上游这 6 个文件一一对应：

| 上游文件 | 本工程落点 |
|---|---|
| `src/mobile/mobile.css` | `app/src/styles/global.css` 末尾安卓平台段（`/* 来源: index-oM37tz4E.css（0.4.4，无作用域，全局） */` 之后） |
| `src/mobile/bridge.js` | `app/src/bridge/android.ts:269`（`getAppVersion` 兜底值） |
| `mobile/package.json` | `app/package.json` + `app/package-lock.json` |
| `mobile/android/app/build.gradle` | `app/android/app/build.gradle:10,11` |

还原方式与 0.4.3 一致：只改「行为/版本相关的源」，样式按还原工程的书写风格（双引号选择器、中文注释）重写，语义与上游等价；逐条依据见 [docs/11-0.4.4同步记录.md](../../docs/11-0.4.4同步记录.md)。

## 版权与使用

上游源码为 MIT 许可，版权归原作者（1suien）所有。本目录只作**本地学习/核对**用，不随本工程再分发，也不含任何账号凭据。
