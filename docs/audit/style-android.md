# 全局样式 / 移动端适配层 / 安卓原生壳 —— 语义级核对报告

**审计对象**：`/root/学习软件`（从 APK 反编译产物还原的 Vue3+TS 工程）
**对照基线**：官方源码 tag `v0.4.3` → `/tmp/up043`
**审计方式**：只读静态核对（脚本化 diff + 逐行阅读）。**未修改 `/root/学习软件` 下任何文件。**
**产出**：本文件 `/tmp/audit/style-android.md`（辅助脚本 `/tmp/audit/cssdiff.py`、`/tmp/audit/vuediff.py`）

---

## 一句话结论

**样式层与移动端适配层是「近乎逐字复刻」级别的还原（CSS 变量 0 缺失、18 个组件样式选择器集合 100% 一致、6 个 mobile/*.js 的职责全部有等价实现），安卓原生壳也与上游 v0.4.3 的 Gradle 工程字节级一致（`diff -r` 零差异）；唯一的真实缺口在「工程可构建性」——`capacitor.settings.gradle` 硬编码了 pnpm 的 `.pnpm/...` 路径、`capacitor-cordova-android-plugins/` 目录整体缺失、`assets/public` 尚未生成，这三点会让 `./gradlew` 在配置阶段直接失败，与样式/源码还原质量无关。**

严重度总览：**严重 3 项（全在构建可运行性）· 中 4 项 · 低 6 项。**
代码语义层面：**missing 职责 0 项**（见 §B.4）。

---

## 0. 前置事实（影响可验证性）

| 事实 | 证据 |
|---|---|
| 本机无 JDK / Gradle / Android SDK | `which java javac gradle` → 全部无输出（exit 1）；`ls /opt` → 仅 `browser dshapp dshbox dshbox-cache pilot` |
| `app/android` 起初为空，审计时已复制完成且**与上游字节级相同** | `diff -rq /tmp/up043/mobile/android /root/学习软件/app/android` → 无输出、exit 0 |
| 因此 C 节的所有行号引用对「上游原件」与「复制件」同时成立 | md5 抽样：`MainActivity.java c282b2b5…`、`ImmersivePlugin.java 0d0f5648…`、`PipPlugin.java 3a3c5458…`、`capacitor.settings.gradle 62d3611b…` |

> 结论：**C 节的「还原工程 vs 上游」差异为零，真正的核对对象变成「上游工程 vs APK 解码事实」**（§C.5）与「工程能否在本机布局下构建」（§C.8）。

---

# A. 样式

## A.1 全局样式：`app/src/styles/global.css` vs 上游 `tokens.css + base.css + mobile.css`

### 文件映射表

| 还原侧 | 上游 | 行数 | 关系 |
|---|---|---|---|
| `app/src/styles/global.css:1-1329` | `src/renderer/src/styles/tokens.css:1-86` + `base.css:1-1376` | 1329 | 两份合并为一份，头部注释自证来源：`/* 来源: main-8cPy-pNJ.css （无作用域，全局） */`（global.css:1） |
| `app/src/styles/global.css:1330-1369` | `src/mobile/mobile.css:1-68` | 40 | 追加在文件尾，注释自证：`/* 来源: index-D9UzvbUq.css （无作用域，全局） */`（global.css:1330） |
| `app/src/styles/recovered/global.css` | 同 `global.css:1-1329` | 1329 | 同一内容的独立副本（**未被任何文件 import**） |
| `app/src/styles/recovered/global.global.css` | 同 `global.css:1330-1369` | 40 | 同一内容的独立副本（**未被任何文件 import**） |

**唯一引用点**：`app/src/main.ts:22` → `import './styles/global.css'`。`recovered/global.css`、`recovered/global.global.css` 是死文件（见 A.3-③）。

### 差异清单

#### 严重
无。

#### 中
无。

#### 低

① **CSS 自定义属性：62 个 `--*`，缺失 0 个，新增 0 个**
脚本提取两侧全部 `--var: value;` 声明后归一化（去引号、去逗号后空格）比对：
- 上游共 63 条、还原侧 62 条，**唯一"差异"是同一条 `--font` 被算成两条**：
  - 上游 `tokens.css:84` `--font: 'Microsoft YaHei UI', 'PingFang SC', ...`（单引号 + 逗号后有空格）
  - 还原 `global.css:68-69` `--font: "Microsoft YaHei UI", "PingFang SC", ...`（双引号）
  - 上游 `tokens.css:85` `--mono: 'Cascadia Mono', Consolas, 'Courier New', monospace`
  - 还原 `global.css:70` `--mono: "Cascadia Mono", Consolas, "Courier New", monospace`
  → **引号风格不同，值语义完全一致**（源自压缩器的引号规范化）。
- 逐个值核对一致，包括易错项：`--tap: 28px`（`global.css:67` / `tokens.css:83`）、`--side-w: 196px`、`--top-h: 56px`、`--radius 10px / --radius-sm 6px / --radius-lg 14px`、`--skeleton` 三段渐变、`--shadow 0 12px 32px rgba(0,0,0,.45)`。
- 暗/亮两套主题的 27 个语义色逐一相同（含 `base.css` 注释里"白底对比度 2.9:1 → 5.3:1"的修正值 `--t3 #6b6b75`）。

② **规则级 diff：219 选择器 vs 207 选择器，集合差异全部是压缩器写法差异**
`python3 /tmp/audit/cssdiff.py global.css base.css` 输出「仅上游有」9 条、「仅还原侧有」21 条，逐条确认**均为等价写法**：

| 上游写法（file:line 见 base.css） | 还原写法（global.css） | 判定 |
|---|---|---|
| `.nav-item.router-link-active::before` | `.nav-item.router-link-active:before` | 等价（CSS2 单冒号伪元素） |
| `@keyframes sk { 100% }` | `@keyframes sk { to }` | 等价 |
| `@keyframes toastin { from }` | `@keyframes toastin { 0% }` | 等价 |
| `*, *::before, *::after`（reduced-motion） | `*, *:before, *:after` | 等价 |
| `input[type='range']` / `.field > input[type='range']` / `.player-stage input[type='range']` | 双引号版 `input[type="range"]` | 等价（属性选择器引号） |
| `.chip.lock::before` | `.chip.lock:before` | 等价 |
| `@keyframes spin` 内部的 `100%` | 同 | 等价 |
| `html[data-theme='light'] .player-stage .progress .track i` | 双引号版 | 等价 |
| —— | `:root, html[data-theme="dark"]`、`html[data-theme="light"]`、`:root` 三块变量 | 还原侧把 tokens.css 合并进来，属预期新增 |
| —— | `html[data-platform="android"]` 系列 9 条 | 还原侧把 mobile.css 合并进来，属预期新增 |

③ **声明值 diff：53 处，全部是 `rgba()` → `#rrggbbaa` 压缩等价**
抽验换算（四舍五入到 0-255）：
`rgba(0,0,0,.55)`→`#0000008c`(140) ✓、`.72`→`b8`(184) ✓、`.84`→`d6`(214) ✓、`.62`→`9e`(158) ✓、`.5`→`80`(128) ✓、`rgba(255,255,255,.28)`→`#ffffff47`(71) ✓、`.58`→`94`(148) ✓、`.62`→`9e` ✓、`.85`→`d9`(217) ✓、`rgba(22,22,26,.97)`→`#16161af7`(247) ✓。
另有两处语法压缩：`transform: translateX(-50%)` → `translate(-50%)`、`#ffffff` → `#fff`。
典型落点（还原侧→上游）：`global.css` 的 `.vcard .thumb .mini/.dur/.watch`、`.overlay`、`.cc-line`、`.stage-online`、`.stage-ui`、`.player-stage .btn.ghost(:hover)`、`.player-stage .input(::placeholder)`、`.player-stage .chip.plain`、`.progress .track(.buf)`、`.ctl-menu` 全族（13 条）、`.player-msg`、`.perf-corner`。

**结论：`base.css` 的 1376 行被 1:1 还原，无任何声明丢失或数值改动。**

④ **mobile.css 是否被合并进 global.css —— 是，且 9 条规则逐条等价**
还原侧 `global.css:1331-1369`（40 行）vs 上游 `mobile.css:14-68`：

| 上游 | 还原侧 | 内容 |
|---|---|---|
| `mobile.css:14-17` `--tap: 36px` | `global.css:1331-1333` | 触屏最小点击目标 28→36 |
| `mobile.css:19-27` body | `global.css:1334-1340` | `-webkit-tap-highlight-color:transparent`；`overscroll-behavior:none`；`-webkit-user-select:none`；`user-select:none`；`-webkit-touch-callout:none` |
| `mobile.css:30-36` 输入类 | `global.css:1341-1347` | `input,textarea,[contenteditable='true']` 恢复 `user-select:text`、`touch-callout:default` |
| `mobile.css:39-43` `.app` | `global.css:1348-1352` | `padding-left/right/bottom: env(safe-area-inset-*)` ← **横屏左右刘海 + 底部手势条** |
| `mobile.css:45-47` `.side` | `global.css:1353-1355` | `padding-top: calc(14px + env(safe-area-inset-top))` |
| `mobile.css:49-51` `.top` | `global.css:1356-1358` | `padding-top: env(safe-area-inset-top)` |
| `mobile.css:54-56` `.kbd` | `global.css:1359-1361` | `display:none`（无物理键盘） |
| `mobile.css:59-62` `.nav-item` | `global.css:1362-1365` | `padding-top/bottom: 11px` |
| `mobile.css:65-68` `.page-float,.theater-exit` | `global.css:1366-1369` | `bottom: calc(18px + env(safe-area-inset-bottom))` |

**媒体查询核对**：上游 `mobile.css` 里**没有任何 `@media`**，全部靠 `html[data-platform='android']` 属性选择器作用域；还原侧同样没有新增 `@media`。全局唯一的媒体查询是 `@media (prefers-reduced-motion: reduce)`（上游 `base.css:1367-1375` / 还原 `global.css:1321-1329`），已逐字保留。
**safe-area 规则的触发前提**也一并对齐：`app/index.html:7-8` 与 `dist/index.html:7-8` 均含 `viewport-fit=cover`（与上游 `mobile/index.html:6-10` 一致）。

---

## A.2 组件样式抽样：`app/src/styles/recovered/*.css` vs 上游同名 `.vue` 的 `<style scoped>`

方法：抽出上游 `.vue` 的 `<style>` 块 → 与还原 `.css` 做「选择器集合 + 声明字典」比对，两侧都归一化（去注释、去空白、去引号、去 `[data-v-*]` 作用域属性）。
脚本：`python3 /tmp/audit/vuediff.py <组件名>`

| 组件 | 上游文件 | 选择器数（还原/上游） | 缺失选择器 | 值不同 | 实际差异 |
|---|---|---|---|---|---|
| **Icon** | `src/renderer/src/components/Icon.vue` | 1 / 1 | 0 | 0 | **完全一致** |
| **MiniPlayer** | `src/renderer/src/components/MiniPlayer.vue` | 20 / 20 | 0 | 0 | 5 处 `rgba()`→`#rrggbbaa`：`.mini-player box-shadow 0 18px 46px rgba(0,0,0,.42)`→`#0000006b`；`.mp-overlay`→`#0000008c`；`.mp-overlay.soft`→`#00000059`；`.mp-tip color`→`#ffffffd9`；`.mp-status`→`#00000080` |
| **FocusPanel** | `src/renderer/src/components/FocusPanel.vue` | 33 / 33 | 0 | 0 | **完全一致** |
| **HabitView** | `src/renderer/src/views/HabitView.vue` | 53 / 53 | 0 | 0 | 仅 `.hb-row.on::before`→`.hb-row.on:before`（内容 `left:0 top:8px bottom:8px width:3px background:var(--brand)` 相同） |
| **SettingsView** | `src/renderer/src/views/SettingsView.vue` | 10 / 10 | 0 | 0 | 仅 `.sec::before`→`.sec:before`（`width:3px height:13px border-radius:2px background:var(--brand)` 相同） |

**扩展核对（不止抽样 5 个）**：把 `recovered/_scope-map.json` 里全部 18 个 scope 都跑了一遍，结论一致 ——
`BiliImage 2/2`、`FavView 17/17`、`HabitView 53/53`、`Icon 1/1`、`FocusTargets 36/36`、`FocusOverview 10/10`、`FocusRecords 31/31`、`FocusPanel 33/33`、`HabitHome 5/5`、`LocalPlayerView 3/3`、`LocalView 13/13`、`SettingsView 10/10`、`UpManageView 16/16`、`PartList 17/17`、`CollectModal 5/5`、`PageFloat 7/7`、`Toasts 2/2`、`MiniPlayer 20/20`。
差异仅有两类：`::before`→`:before`（HabitView / FavView / FocusTargets / FocusRecords / SettingsView 共 5 处）、`@keyframes` 的 `from/100%`→`0%/to` 与 `rotate(0deg)`→`rotate(0)`（PageFloat）。**无一条声明值被改动，无一条规则丢失。**

## A.3 还原侧新增的样式（上游没有的）

| # | 内容 | 判定 |
|---|---|---|
| ① | **无任何 mock / 开发工具专用 CSS**。`grep -niE "mock" app/src/styles/**/*.css` 零命中；`?mock=1` 分支走的是 `app/src/main.ts:33-37` 动态 import `./bridge/mock`，它只替换 `window.bili`，不注入样式 | 干净 |
| ② | 组件样式同时存在于「`recovered/*.css`」与「`.vue` 内联 `<style>`」两处（18/18 组件都有内联 style，`FavView.vue:289` 更是直接注释掉来源） | **低**：双份副本，存在日后漂移风险；构建只吃 `.vue` 内联，`.css` 实际是"证据文件" |
| ③ | `recovered/global.css`、`recovered/global.global.css` 未被任何文件 import（全仓 `grep "recovered/"` 只命中 `FavView.vue` 的注释） | **低**：死文件，同样的漂移风险 |
| ④ | `native/pip.ts:12` 注释称"CSS 里用 `html[data-fullscreen="1"]` 收起导航/边框"，但两侧 CSS 都**没有** `[data-fullscreen]` / `[data-pip]` 选择器 | **低**（注释误导）；且**上游同样没有**，非还原缺陷 |

---

# B. 移动端适配层

## B.1 文件映射表

| 上游 `src/mobile/` | 还原侧 | 关系 |
|---|---|---|
| `main.js`（116 行） | `app/src/main.ts`（142 行） | 入口合并：上游 `main.js` 只做 bridge/platform 装配再 `await import('../renderer/src/main.js')`；还原工程因为已把渲染层源码合进同一棵树，合并为单一 `main.ts` |
| `platform.js`（159 行） | `app/src/native/{plugins,pip,clipboard}.ts` + `app/src/main.ts`(返回键) | 1 拆 4 |
| `store.js`（147 行） | `app/src/bridge/state.ts` | 1:1 |
| `native-http.js`（157 行） | `app/src/bridge/http.ts` | 1:1 |
| `local-files.js`（134 行） | `app/src/bridge/android.ts`（文件注册表部分） | 并入 |
| `bridge.js`（378 行） | `app/src/bridge/android.ts`（598 行） | 1:1（通道表 + `window.bili` 装配） |
| `mobile.css`（66 行） | `app/src/styles/global.css:1330-1369` | 见 §A.1④ |
| （无对应，上游属渲染层 `src/main/bili/*`） | `app/src/bridge/{api,wbi,types,mock,index}.ts` | 超出本次 6 文件范围 |

## B.2 职责覆盖表

| # | 职责 | 上游实现（file:line） | 还原实现（file:line） | 等价性 |
|---|---|---|---|---|
| 1 | **CapacitorHttp 注入** | `native-http.js:28` import；`:103-155` `createNativeFetch`；`:122` `CapacitorHttp.request` | `bridge/http.ts:19` import；`:113-160` 原生 fetch 工厂；`:142` `CapacitorHttp.request` | ✅ 等价。常量同值：`DEFAULT_CONNECT_TIMEOUT=15000`（`http.ts:34` / `native-http.js:30`）、`DEFAULT_READ_TIMEOUT=20000`（`http.ts:35` / `:31`） |
| 2 | **请求取消语义** | `native-http.js:45-60` `splitSetCookie`；`Promise.race` 模拟 abort；错误文案 `'请求已取消'` + `name='AbortError'` | `bridge/http.ts:37-41` 同文案同 name；`:327` `export { splitSetCookie }` | ✅ 等价（含 `Set-Cookie` 按 `, ` 切分时用 `/^\s*[!#$%&'*+\-.^_`\|~0-9A-Za-z]+=/` 判新 cookie 起点的防 `Expires` 误切逻辑） |
| 3 | **Preferences 持久化** | `store.js:22` import；`:74-107` `load()`；`:109-122` `persist()`；KEY `bililite.state.v1`；`raw:`+base64 编码 secure 字段；localStorage 兜底 + 首次迁移 | `bridge/state.ts:21` import；`:163-200` `load()`；`:204-220` persist；`STATE_KEY='bililite.state.v1'`(`:25`)；`encodeSecure:60` `'raw:'+btoa`；`:79-92` localStorage 镜像；`:177` 迁移 | ✅ 等价（含告警文案 `'[store] 读原生 Preferences 失败，回退 localStorage：'`，`state.ts:169`） |
| 4 | **Filesystem 备份** | `bridge.js` `'backup:write'`：`Filesystem.writeFile` → 先 `Directory.Documents` 失败退 `Directory.Cache` → `shareFile` | `bridge/android.ts:410-444`，完全同构（`Filesystem/Directory/Encoding` 见 `:412`）；返回文案同为 `` `${label}/${fileName}（已打开「保存到」面板，可另存到任意位置）` `` | ✅ 逐行等价 |
| 5 | **Share** | `bridge.js:94-97` `Share.share({title,text,files:[uri],dialogTitle:'保存到…'})` | `bridge/android.ts:253-258` `shareFile`，`:254` `await import('@capacitor/share')` | ✅ 等价 |
| 6 | **StatusBar** | `platform.js:74-99` `StatusBar.hide()/show()` | `native/pip.ts:5` import；`:17-19` hide / `:20` show | ✅ 等价 |
| 7 | **ScreenOrientation** | `platform.js`：`lock({orientation:'landscape'})` / `unlock()` | `native/pip.ts:5` import；`:21-22` lock/unlock 同参数 | ✅ 等价 |
| 8 | **App 返回键** | `main.js:64-115` `wireAndroidBack()`，优先级：login 弹窗 → confirm 弹窗 → 全屏 → 剧场(.app.theater + Escape) → `history.state.back` → `minimizeApp()` | `main.ts:89-131` `installBackButton()`，`:100` `addListener('backButton')`，`:117` fullscreen、`:121` `.app.theater`、`:125` `history.state.back`、`:129` `minimizeApp().catch(exitApp)` | ✅ 逐条等价（仅重构为函数） |
| 9 | **沉浸式插件** | `platform.js:20-27` `registerPlugin('Immersive')`；`:82` `setImmersive({ on })` | `native/plugins.ts:5` import、`:19` `registerPlugin<ImmersivePlugin>('Immersive')`；`native/pip.ts:15` `setImmersive({ on })` | ✅ 见 §C.6 字符串精确比对 |
| 10 | **PiP 插件** | `platform.js:20-27` `registerPlugin('Pip')`；`:122` `setPlaying`、`:145` `setGeometry` | `native/plugins.ts:18` `registerPlugin<PipPlugin>('Pip')`；`native/pip.ts:49` setPlaying、`:69` setGeometry | ✅ 等价 |
| 11 | **文件选择** | `bridge.js:47-73` `pickFilesFromInput()`（隐藏 `input[type=file]` + 800ms `window.focus` 兜底取消）；`local-files.js` `acceptFiles`/`registerPaths`/`forget` | `bridge/android.ts:211-241` `pickFilesWithInput`；`:176-210` `describeFiles`/`restoreEntries`/`removeEntry`；`:389/394/401/403/405` 五个 `local:*` 通道 | ✅ 等价（含 `localId = md5(name\|size\|lastModified).slice(0,24)`、伪路径 `android://<id>/<name>`、`^android:\/\/([0-9a-f]{24})\//` 反解） |
| 12 | **剪贴板** | `platform.js:32-69` `installClipboard()`：包 `navigator.clipboard`，`Clipboard.write` 失败回退原实现，打 `__bililite:'native-clipboard'` 标记，先实例后原型 | `native/clipboard.ts:8-35`，同结构（`Clipboard.write` 兜底、`__bililite` 标记、`defineProperty` 两级） | ✅ 等价 |
| 13 | **bridge 装配 + 通道表** | `bridge.js:362-376` `installBridge()`：`setBiliStore → setCookieMode('explicit') → setHttpFetch(createNativeFetch()) → await store.load() → window.bili` | `bridge/android.ts:582-598`：`useExplicitCookies → setFetchImpl(createNativeFetch) → await state.load() → window.bili` | ✅ 等价（顺序相同；均在 `app.mount` 之前 await，见 `main.ts:51-52` 与 `main.ts:70+`） |
| 14 | **通道数量** | 36 个（`bridge.js:107-247`） | 36 个（`android.ts:280-410`），逐个字符串比对一致 | ✅ 1:1，无 missing / 无 extra |

## B.3 missing 列表

**功能缺失：0 项。** 12 项职责（CapacitorHttp / Preferences / Filesystem / Share / StatusBar / ScreenOrientation / App-back / Immersive / PiP / 文件选择 / 剪贴板 / bridge 装配）全部有等价实现，36 个通道字符串 1:1。

**非功能性差异（均为低）**

| # | 差异 | 位置 | 严重度 |
|---|---|---|---|
| B-1 | 还原侧新增 `?mock=1` 分支（上游没有 mock 层）；`DEV && !window.bili` 时也会启用 | `app/src/main.ts:29-40` | 低（开发便利，生产环境 `import.meta.env.DEV=false` 关掉） |
| B-2 | `clipboard.ts:3` 注释写"再失败退回老式 `execCommand`"，但代码里**没有** `execCommand` 实现（只有 `Clipboard.write` → 原 `navigator.clipboard.writeText`） | `app/src/native/clipboard.ts:3` vs `:11-17` | 低（注释与实现不符；上游 `platform.js` 注释没这么写） |
| B-3 | `plugins.ts` 的 `PipPlugin` 接口只声明 `setPlaying`/`setGeometry`，Java 侧其实有 4 个 `@PluginMethod`（另有 `enter`/`isSupported`） | `app/src/native/plugins.ts:8-16` vs `PipPlugin.java:47,59,66,79` | 低（类型不完整，运行时无影响；前端也确实不调 `enter`） |
| B-4 | `pip.ts` 写入的 `dataset.fullscreen` / `dataset.pip` 在两侧 CSS 都没有消费者 | `app/src/native/pip.ts:13,45` | 低（上游同样如此，非还原引入） |

---

# C. 安卓原生壳（重点）

## C.1 结论先行

`/root/学习软件/app/android` 与 `/tmp/up043/mobile/android` **`diff -r` 完全一致（exit 0，零差异）**。因此本节实质是「上游 v0.4.3 工程 ↔ APK 解码事实」的核对，以及「该工程在 npm 布局下能否构建」。

## C.2 Manifest 逐项核对

| 核对项 | APK 解码（`/root/学习软件/android/AndroidManifest.xml`） | 上游/还原工程（`app/android/app/src/main/AndroidManifest.xml` + `app/build.gradle` + `variables.gradle`） | 判定 |
|---|---|---|---|
| `package` / `applicationId` / `namespace` | `com.bililite.app`（`AndroidManifest.xml:2`） | `app/build.gradle:4` namespace、`:7` applicationId | ✅ |
| `versionCode` | `7`（`:2`） | `app/build.gradle:10` `versionCode 7` | ✅ |
| `versionName` | `0.4.3`（`:2`） | `app/build.gradle:11` `versionName "0.4.3"` | ✅ |
| `compileSdkVersion` | `34` / codename `14`（`:2`） | `variables.gradle` `compileSdkVersion = 34` + `app/build.gradle:5` `compileSdk rootProject.ext` | ✅ |
| `minSdkVersion` | `22`（`:3`） | `variables.gradle` `minSdkVersion = 22` | ✅ |
| `targetSdkVersion` | `34`（`:3`） | `variables.gradle` `targetSdkVersion = 34` | ✅ |
| `INTERNET` 权限 | `:4` | `AndroidManifest.xml:41` | ✅ |
| activity `name` | `com.bililite.app.MainActivity`（`:8`） | `:14` `android:name=".MainActivity"`（相对名，等价） | ✅ |
| activity `theme` | `@style/AppTheme.NoActionBarLaunch`（`:8`） | `:16` 同 | ✅ |
| activity `label` | `@string/title_activity_main`（`:8`） | `:15` 同 | ✅ |
| `launchMode` | `singleTask`（`:8`） | `:17` 同 | ✅ |
| `supportsPictureInPicture` | `true`（`:8`） | `:18` 同 | ✅ |
| `exported` | `true`（`:8`） | `:19` 同 | ✅ |
| `configChanges` | `locale\|keyboard\|keyboardHidden\|orientation\|screenLayout\|uiMode\|screenSize\|smallestScreenSize`（=0xfb4，`:8`） | `:13` 完全同集合（顺序不同，语义等价） | ✅ |
| intent-filter | `MAIN` + `LAUNCHER`（`:9-12`） | `:21-24` | ✅ |
| FileProvider | `androidx.core.content.FileProvider`，`authorities=com.bililite.app.fileprovider`，`exported=false`，`grantUriPermissions=true`（`:14-16`） | `:28-36`，authorities 写作 `${applicationId}.fileprovider`（等价） | ✅ |
| FileProvider meta-data | `android.support.FILE_PROVIDER_PATHS` → `@xml/file_paths` | `:33-35` | ✅ |
| application 属性 | `theme=@style/AppTheme`、`label=@string/app_name`、`icon=@mipmap/ic_launcher`、`roundIcon=@mipmap/ic_launcher_round`、`allowBackup=true`、`supportsRtl=true`、`debuggable=true`、`extractNativeLibs=true`（`:7`） | `:4-10` 含前 6 项；`debuggable`（debug 构建默认）、`extractNativeLibs`（AGP 默认）、`appComponentFactory`（AndroidX 注入）由构建产生 | ✅ |
| `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | `:5-6`，`protectionLevel=signature` | **源码中不存在** | ✅ 正常：AGP 7.3+ 在 `targetSdk≥33` 时自动注入 |
| `androidx.startup.InitializationProvider` | `:17-21`（emoji2 / lifecycle / profileinstaller） | **源码中不存在** | ✅ 正常：由 AndroidX 库 manifest 合并 |
| `androidx.profileinstaller.ProfileInstallReceiver` | `:22-35` | **源码中不存在** | ✅ 正常：同上 |
| 其它权限 | 仅上述 + 无 `FOREGROUND_SERVICE` / `RECORD_AUDIO` / `READ_EXTERNAL_STORAGE` | 同 | ✅ 与文档"只要 INTERNET"一致 |

## C.3 Gradle 版本链核对

| 项 | 值 | 证据 | 判定 |
|---|---|---|---|
| AGP | `8.2.1` | `app/android/build.gradle:10` `classpath 'com.android.tools.build:gradle:8.2.1'` | ✅ |
| Gradle wrapper | `8.2.1` | `app/android/gradle/wrapper/gradle-wrapper.properties:3` `gradle-8.2.1-bin.zip` | ✅（与 AGP 8.2.1 匹配；AGP 8.2 要求 Gradle ≥ 8.2） |
| Java 编译目标 | `17` | `app/android/app/capacitor.build.gradle:3-8` `sourceCompatibility/targetCompatibility JavaVersion.VERSION_17` | ✅ |
| google-services | `4.4.0`（可选应用，`app/android/app/build.gradle` 尾部 try/catch 判断 `google-services.json`） | `build.gradle:11` | ✅ |
| SDK 版本 | 22 / 34 / 34 | `variables.gradle` | ✅ |
| androidx 版本 | activity 1.8.0 / appcompat 1.6.1 / coordinatorlayout 1.2.0 / core 1.12.0 / fragment 1.6.2 / core-splashscreen 1.0.1 / webkit 1.9.0 | `variables.gradle` | ✅ |
| 测试依赖 | junit 4.13.2 / androidxJunit 1.1.5 / espresso 3.5.1 / cordovaAndroid 10.1.1 | `variables.gradle` | ✅ |
| 中文路径规避 | `android.overridePathCheck=true` | `app/android/gradle.properties:17`（注释说明上游作者路径含 `学习APP`） | ✅ 对本仓库路径（`/root/学习软件` 也含中文）**恰好必需** |
| 内存参数 | `-Xmx2560m -Dfile.encoding=UTF-8` | `gradle.properties:12` | ✅ |

## C.4 三个 Java 插件逐文件说明

> 路径前缀统一省略为 `app/android/app/src/main/java/com/bililite/app/`（与 `/tmp/up043/mobile/android/app/src/main/java/com/bililite/app/` 字节相同）

### C.4.1 `MainActivity.java`（69 行）

- `MainActivity.java:25` `public class MainActivity extends BridgeActivity`
- `MainActivity.java:28-29` `DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"` —— 把 WebView 伪装成桌面 Chrome（B 站接口对移动 UA 有差异）
- `MainActivity.java:32-38` `onCreate`：
  ```java
  33:  // registerPlugin 必须在 super.onCreate() 之前调用，否则插件不会挂到 Bridge 上
  34:  registerPlugin(PipPlugin.class);
  35:  registerPlugin(ImmersivePlugin.class);
  36:  super.onCreate(savedInstanceState);
  ```
  **注意顺序：先 Pip 后 Immersive，但都必须在 `super.onCreate` 之前**（Capacitor 的 `BridgeActivity.onCreate` 才真正建 Bridge）。顺序本身对功能无影响，但**两条都必须在 super 前**是硬约束，已满足。
- `MainActivity.java:41-45` `onResume` 再次 `applyDesktopUserAgent()`
- `MainActivity.java:48-58` `applyDesktopUserAgent()`：`getBridge().getWebView().getSettings().setUserAgentString(DESKTOP_UA)`（`:54`），整体 `try/catch (Throwable ignored)`
- `MainActivity.java:61-68` `onUserLeaveHint()`：`super` → 取 `PipPlugin.get()` → `isPlaying()` 且 `SDK_INT >= O` 时 `pip.enterPip()`（`:67`）
- **`loadUrl`：没有。** 全文件无 `loadUrl`/`setServerUrl`；页面加载交给 `BridgeActivity` + Capacitor 的 `server.androidScheme/hostname` 机制（`app/capacitor.config.json` 里 `https` + `www.bilibili.com`）。
- **返回键：Java 里不处理。** 由 JS 侧 `@capacitor/app` 的 `backButton` 事件接管（`app/src/main.ts:100`）。上游 `main.js:64-115` 同。

### C.4.2 `ImmersivePlugin.java`（59 行）—— 0.4.3 新增

```java
25: @CapacitorPlugin(name = "Immersive")
26: public class ImmersivePlugin extends Plugin {
28:   @PluginMethod
29:   public void setImmersive(PluginCall call) {
```
- 唯一 `@PluginMethod`：`setImmersive(PluginCall)`，参数键 **`"on"`**（Boolean，缺省 `false`）
- `ImmersivePlugin.java:40` `WindowCompat.setDecorFitsSystemWindows(window, !on)` —— **`on=true` 时传 `false`**，即让内容铺到系统栏底下
- `ImmersivePlugin.java:41-42` `WindowInsetsControllerCompat ctl = WindowCompat.getInsetsController(window, window.getDecorView())`
- `ImmersivePlugin.java:45` `ctl.hide(WindowInsetsCompat.Type.systemBars())`（`systemBars()` = 状态栏 + 导航栏）
- `ImmersivePlugin.java:47-48` `ctl.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE)`（下滑临时唤出）
- `ImmersivePlugin.java:50` 退出时 `ctl.show(WindowInsetsCompat.Type.systemBars())`
- 整体 `runOnUiThread` + 逐层 `try/catch (Throwable ignored)`；`getActivity()==null` 时直接 `call.resolve()`；末尾总是 `call.resolve()`（**不 reject**，所以前端 `try/catch` 能兜住但永远不抛）
- **JS 调用方式**：`Immersive.setImmersive({ on: true|false })`（`app/src/native/pip.ts:15`）
- 存在理由（上游 `platform.js:74-99` 注释 + 本文件注释）：只 `StatusBar.hide()` 不够，小米平板 6 / Android 14 的 WebView 视口不含系统栏，全屏时上下各留黑带

### C.4.3 `PipPlugin.java`（126 行）

```java
25: @CapacitorPlugin(name = "Pip")
26: public class PipPlugin extends Plugin {
43:   static PipPlugin get() { ... }          // MainActivity.onUserLeaveHint 用
47:   @PluginMethod public void setPlaying(PluginCall call)   // :48
59:   @PluginMethod public void setGeometry(PluginCall call)  // :60
66:   @PluginMethod public void enter(PluginCall call)        // :67
79:   @PluginMethod public void isSupported(PluginCall call)  // :80
90:   boolean supported() { return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O; }
95:   boolean enterPip() { /* PictureInPictureParams.Builder + setSourceRectHint + setAspectRatio + enterPictureInPictureMode() */ }
```
- 静态单例：`PipPlugin.java:29` `static instance`，构造里 `instance = this`（`:39-41`），`get()` 在 `:43-45`
- 状态：`:32` `volatile boolean playing`，`:35` `Rect sourceRect`，`:37` `Rational aspect = new Rational(16, 9)`
- `setPlaying`（`:48-56`）读 `"playing"`，回 `JSObject {playing, supported, pip:false}`
- `enter`（`:67-77`）失败 reject 文案：`"当前系统不支持画中画（需要 Android 8.0 以上）"` / `"进入画中画失败"`
- `readGeometry`（`:111-125`）把 CSS px × `density` 换算成 `Rect`，并用 `Rational(width, height)` 覆盖 `aspect`
- **注意**：`enterPip()` 是私有辅助（`:95`），不是 `@PluginMethod`；**`@PluginMethod` 那个叫 `enter`**（`:66-67`）。

## C.5 插件名 / 注册字符串精确比对（最易错处）

| 侧 | 字符串 | 位置 |
|---|---|---|
| Java `@CapacitorPlugin(name = …)` | **`"Pip"`** | `PipPlugin.java:25` |
| Java `@CapacitorPlugin(name = …)` | **`"Immersive"`** | `ImmersivePlugin.java:25` |
| Java 注册顺序 | `PipPlugin.class` → `ImmersivePlugin.class` | `MainActivity.java:34-35` |
| JS `registerPlugin(...)` | **`'Pip'`** | `app/src/native/plugins.ts:18` |
| JS `registerPlugin(...)` | **`'Immersive'`** | `app/src/native/plugins.ts:19` |
| 上游 JS | `registerPlugin('Pip')` / `registerPlugin('Immersive')` | `src/mobile/platform.js:20-27` |

**✅ 完全一致（大小写敏感，无空格、无下划线、无 `Plugin` 后缀）。** 方法名也一致：`setPlaying`（`plugins.ts:9` ↔ `PipPlugin.java:48`）、`setGeometry`（`:10` ↔ `:60`）、`setImmersive`（`:15` ↔ `ImmersivePlugin.java:29`）。
**唯一未在 TS 侧声明的**：`enter`、`isSupported`（B-3，低）。

## C.6 `res/` 与 APK 解码资源对照

| 资源 | 上游/还原（`app/android/app/src/main/res/`） | APK 解码（`/root/学习软件/android/res/`） | 判定 |
|---|---|---|---|
| `values/strings.xml` `app_name` | `BiliLite` | `strings.xml:5` `BiliLite`；`strings-all.xml:32` 同 | ✅ |
| `values/strings.xml` `title_activity_main` | `BiliLite` | `strings.xml:9`；`strings-all.xml:45` 同 | ✅ |
| `custom_url_scheme` / `package_name` | `com.bililite.app` / `com.bililite.app` | `strings.xml:6,8` 同 | ✅ |
| `no_webview_text` | 源码里**没有** | `strings.xml:7` `"This app requires a WebView to work"` | ✅ 来自 Capacitor 库资源 |
| `values/styles.xml` 主题名 | `AppTheme`（parent `Theme.AppCompat.Light.DarkActionBar`）、`AppTheme.NoActionBar`（`Theme.AppCompat.DayNight.NoActionBar`）、`AppTheme.NoActionBarLaunch`（`Theme.SplashScreen`，`android:background=@drawable/splash`） | 解码 `styles.xml` **只有注释占位**：`<!-- AppTheme = <style 复合资源，需从编译产物反查> -->`（含三个主题名），无实际值 | ⚠️ **无法比对具体值**；三个主题名存在性 ✅ |
| 主题色 `@color/colorPrimary` 等 | 源码 `styles.xml:7-9` 引用，值由 `node_modules/@capacitor/android/capacitor/src/main/res/values/colors.xml` 提供（`colorPrimary #3F51B5`、`colorPrimaryDark #303F9F`） | 解码 `colors.xml:47-49` `colorAccent #ffff4081`、`colorPrimary #ff3f51b5`、`colorPrimaryDark #ff303f9f` | ✅ **闭环验证成功**（也说明 APK 主题色就是 Capacitor 默认的靛蓝，深色外观全靠 CSS 变量） |
| `xml/file_paths.xml` | `<external-path name="my_images" path="." />` + `<cache-path name="my_cache_images" path="." />`（`:3-4`） | `res/xml/file_paths.xml:3-4` 与 `xml-raw/file_paths.xml` **逐字相同** | ✅ |
| `xml/config.xml`（Cordova 残留） | 工程里**没有**（Capacitor 6 已不生成） | `res/xml/config.xml`、`xml-raw/config.xml` 存在（`<widget version="1.0.0"><access origin="*"/></widget>`） | ⚠️ **中**：APK 里有、v0.4.3 源码里没有。属 `capacitor-cordova-android-plugins` 模块产物（该模块缺失，见 C.7），不影响 manifest 校验，但说明构建链里确实曾存在 cordova 兼容模块 |
| `mipmap-*/ic_launcher{,_round,_foreground}.png` | 5 个密度 × 3 个文件 | 5 个密度（`-v4` 后缀）× 3 个文件；**像素尺寸逐个相同**（mdpi 48/108/48、hdpi 72/162/72、xhdpi 96/216/96、xxhdpi 144/324/144、xxxhdpi 192/432/192） | ✅（字节不同属 aapt 重编码，属正常） |
| `drawable*/splash.png`（land/port × 5 密度 + 默认） | 11 个 `splash.png` | 解码树里 **`drawable*` 目录整体未导出** | ⚠️ **无法验证**（解码器只导出了 `mipmap`/`values`/`xml`），而 `AppTheme.NoActionBarLaunch` 依赖 `@drawable/splash` |
| `mipmap-anydpi-v26/ic_launcher{,_round}.xml` | 存在 | `res/mipmap-anydpi-v26/` 目录存在 | ✅（存在性） |
| `layout/activity_main.xml` | 存在 | 解码 `layout` 计数 46，未导出文件 | 低（模板文件，无定制） |

## C.7 Gradle 工程在 **npm（非 pnpm）** 布局下的可构建性

### 严重

**S-1 `.pnpm` 硬编码路径 —— Gradle 配置阶段必失败**
`app/android/capacitor.settings.gradle` 的 9 个模块（含 `:capacitor-android`）全部指向 pnpm store：
```groovy
include ':capacitor-android'
project(':capacitor-android').projectDir = new File('../node_modules/.pnpm/@capacitor+android@6.2.2_@capacitor+core@6.2.2/node_modules/@capacitor/android/capacitor')
include ':capacitor-app'
project(':capacitor-app').projectDir = new File('../node_modules/.pnpm/@capacitor+app@6.0.3_@capacitor+core@6.2.2/node_modules/@capacitor/app/android')
… （clipboard 6.0.3 / filesystem 6.0.4 / preferences 6.0.4 / screen-orientation 6.0.4 / share 6.0.4 / status-bar 6.0.3 同型）
```
本仓库是 **npm 布局**：`/root/学习软件/app/node_modules/.pnpm` **不存在**（`ls -d .pnpm` → NO），实际路径是 `node_modules/@capacitor/<pkg>/...`。
→ `gradlew` 会在 settings 求值阶段抛 `Could not find` / `project directory does not exist`。
（`capacitor.settings.gradle:1` 自己写着 `DO NOT EDIT THIS FILE! IT IS GENERATED EACH TIME "capacitor update" IS RUN`，正解不是手改而是重跑 `cap sync`。）
**已核实的 npm 侧替代路径存在**：`app/node_modules/@capacitor/android/capacitor/{build.gradle,src,…}` ✅、`app/node_modules/@capacitor/app/android/{build.gradle,src}` ✅，8 个插件全部就位且**版本与 .pnpm 路径里写的一致**（core 6.2.2 / android 6.2.2 / app 6.0.3 / clipboard 6.0.3 / filesystem 6.0.4 / preferences 6.0.4 / screen-orientation 6.0.4 / share 6.0.4 / status-bar 6.0.3）—— 所以只需改路径，不需要改版本。

**S-2 `capacitor-cordova-android-plugins/` 目录整体缺失，却被 3 处引用**
| 引用点 | 内容 |
|---|---|
| `app/android/settings.gradle:2-3` | `include ':capacitor-cordova-android-plugins'` + `projectDir = new File('./capacitor-cordova-android-plugins/')` |
| `app/android/app/build.gradle:42` | `implementation project(':capacitor-cordova-android-plugins')` |
| `app/android/app/capacitor.build.gradle:10` | `apply from: "../capacitor-cordova-android-plugins/cordova.variables.gradle"` |
| `app/android/app/build.gradle:27-31` | `flatDir dirs '../capacitor-cordova-android-plugins/src/main/libs'` |
实测：`ls -d app/android/capacitor-cordova-android-plugins` → **NO cordova dir**。
→ settings 阶段 `include` 一个不存在的目录即 `projectDir` 无效，配置直接失败。该目录由 `npx cap sync` 自动生成（即使一个 cordova 插件都没装，Capacitor 也会生成一个空壳模块）。

**S-3 没有 `assets/public` —— 构建即使成功也是白屏**
`app/android/app/src/main/` 下只有 `AndroidManifest.xml`、`java/`、`res/`，**无 `assets/`**。
Capacitor 的 `webDir`（上游 `www`，本仓库 `dist`，见 `app/capacitor.config.json`）必须由 `npx cap copy android` 拷到 `app/src/main/assets/public/`。未拷贝 → APK 里没有前端产物 → 打开是纯白屏（且 `server.androidScheme/https` 下 `index.html` 404）。

### 中

**M-1 无 `local.properties`，也没有 `ANDROID_HOME`**
`ls app/android/local.properties` → 不存在。AGP 需要 `sdk.dir` 或环境变量 `ANDROID_HOME`/`ANDROID_SDK_ROOT`，否则报 `SDK location not found`。
**M-2 `@capacitor/cli` 不在 `package.json`**
`app/node_modules/@capacitor/cli` 存在（随 `@capacitor/android` 传递安装），但 `app/package.json` 的 `dependencies`/`devDependencies` **都没有列 `@capacitor/cli`**，也没有任何 `cap`/`sync` script。
→ 一旦 `rm -rf node_modules && npm i`，`npx cap sync` 就没了（npm 的传递依赖提升不可依赖）。**这是修复 S-1/S-2/S-3 的前提工具，必须先补上。**
**M-3 `webDir` 已改 `dist`，但 `vite.config.ts`/构建产物需自查**：`app/capacitor.config.json` 写 `"webDir": "dist"`（上游是 `www`），`app/dist/index.html` 存在（`dist` 959K）✅ 对齐；但 `cap copy` 只认 `webDir`，所以 `npm run build` 必须先跑。
**M-4 文档与工程现状严重脱节**：`docs/06-原生能力与安卓工程.md:183` 仍写"本仓库**不含**完整的 Gradle 工程……推荐做法是用 Capacitor 重新生成壳"，而 `app/android` 现在就是完整的 v0.4.3 原工程。同节 `docs/06:194` "需要手动补的东西"7 条全部已具备。详见 §C.9。

### 低

**L-1** `gradle/wrapper/gradle-wrapper.jar` 无法在本机校验（见 §E）。
**L-2** `app/android/.gitignore` 忽略 `local.properties`、`*.apk`、`assets/public`（Capacitor 默认），属正常。
**L-3** `app/capacitor.config.json` 与上游仅 `webDir` 一项不同（`dist` vs `www`），其余 8 个字段（`appId/appName/loggingBehavior/android.allowMixedContent/webContentsDebuggingEnabled/server.androidScheme/hostname/plugins.CapacitorHttp.enabled`）**完全一致**。

## C.8 「构建 APK 还差什么」清单

按依赖顺序，**1-4 必须做，5-7 视环境**：

| # | 缺什么 | 证据 | 修法 |
|---|---|---|---|
| 1 | `@capacitor/cli` 未声明 | `app/package.json`（无该依赖、无 cap script） | `cd app && npm i -D @capacitor/cli@6` |
| 2 | 前端产物未拷进 android | 无 `app/android/app/src/main/assets/` | `cd app && npm run build && npx cap copy android` |
| 3 | cordova 兼容模块缺失 | `settings.gradle:2-3`、`app/build.gradle:42`、`capacitor.build.gradle:10` 引用空目录 | `npx cap sync android` 自动生成空壳模块 |
| 4 | `capacitor.settings.gradle` 全是 `.pnpm` 路径 | `capacitor.settings.gradle:2-19` | `npx cap sync android` 会按 npm 布局重写；**若手改**：把 `../node_modules/.pnpm/@capacitor+X@VER_@capacitor+core@VER/node_modules/` 整体删掉，得到 `../node_modules/@capacitor/X/...`（已核实 8 个包在此路径下都有 `android/` 或 `capacitor/` 子目录） |
| 5 | 无 Android SDK 路径 | 无 `local.properties`；`/opt` 无 sdk | 装 SDK 后写 `app/android/local.properties`: `sdk.dir=/path/to/Android/Sdk`（该文件已被 `.gitignore` 忽略） |
| 6 | 无 JDK 17 | `which java javac gradle` 全空 | 装 JDK 17（AGP 8.2 要求 17+） |
| 7 | 无 Gradle 分发缓存 | 只能靠 wrapper 首次联网下载 `gradle-8.2.1-bin.zip` | 联网或预置 `~/.gradle/wrapper/dists/` |

命令序列（**满足 5-7 后**）：
```bash
cd app
npm i -D @capacitor/cli@6
npm run build                     # 产出 dist/
npx cap sync android              # 重写 capacitor.settings.gradle + 建 cordova 空壳 + 拷 assets/public
cd android && ./gradlew assembleDebug
# 产物：app/android/app/build/outputs/apk/debug/app-debug.apk
```

### 本机可做的静态验证命令（全部已执行，可复现）

```bash
# 1) 上游工程 vs 复制件是否一致（应为空输出 + exit 0）
diff -rq /tmp/up043/mobile/android /root/学习软件/app/android

# 2) 插件注册字符串是否一致（两侧应各命中 1 条，字符串相同）
grep -n 'CapacitorPlugin(name' /root/学习软件/app/android/app/src/main/java/com/bililite/app/*.java
grep -n 'registerPlugin' /root/学习软件/app/src/native/plugins.ts

# 3) 注册顺序是否都在 super.onCreate 之前
grep -n 'registerPlugin\|super.onCreate' /root/学习软件/app/android/app/src/main/java/com/bililite/app/MainActivity.java

# 4) 关键 gradle 数字
grep -n 'gradle:8.2.1' /root/学习软件/app/android/build.gradle
grep -n 'distributionUrl' /root/学习软件/app/android/gradle/wrapper/gradle-wrapper.properties
grep -n 'VERSION_17' /root/学习软件/app/android/app/capacitor.build.gradle
grep -n 'SdkVersion' /root/学习软件/app/android/variables.gradle
grep -n 'versionCode\|versionName\|applicationId\|namespace' /root/学习软件/app/android/app/build.gradle

# 5) npm 布局下 .pnpm 路径是否存在（应为 NO .pnpm）
ls -d /root/学习软件/app/node_modules/.pnpm 2>/dev/null || echo "NO .pnpm"

# 6) 引用但缺失的目录
ls -d /root/学习软件/app/android/capacitor-cordova-android-plugins 2>/dev/null || echo "NO cordova dir"
ls -d /root/学习软件/app/android/app/src/main/assets 2>/dev/null || echo "NO assets (未 cap copy)"
ls /root/学习软件/app/android/local.properties 2>/dev/null || echo "NO local.properties"

# 7) Capacitor 插件实际安装版本 vs .pnpm 路径里的版本
for p in core android app clipboard filesystem preferences screen-orientation share status-bar; do
  echo -n "@capacitor/$p = "; node -p "require('/root/学习软件/app/node_modules/@capacitor/$p/package.json').version"; done

# 8) 样式：CSS 变量差集（预期只剩 --font/--mono 引号风格）
python3 /tmp/audit/cssdiff.py /root/学习软件/app/src/styles/global.css /tmp/up043/src/renderer/src/styles/base.css

# 9) 组件样式抽样（预期每行 "recovered N / upstream N" 数字相等）
for n in Icon MiniPlayer FocusPanel HabitView SettingsView; do python3 /tmp/audit/vuediff.py $n; done

# 10) 通道数与通道名比对（两侧应各 36）
grep -oE "'[a-z]+:[a-zA-Z]+'" /root/学习软件/app/src/bridge/android.ts | sort -u | wc -l
```

## C.9 文档 `docs/06` 与源码不一致（额外发现）

| # | 文档说法 | 实际 | 严重度 |
|---|---|---|---|
| 1 | `docs/06:70,77,175` 写 `Immersive.setImmersive({enabled})` / `{enabled:true}` | 参数键是 **`on`**（`native/pip.ts:15`、`platform.js:82`、`ImmersivePlugin.java:29` 读 `"on"`） | 中（照文档写调用会静默无效） |
| 2 | `docs/06:79,176` 写"播放页「画中画」按钮 → `Pip.enterPip()`" | 前端**从不调用**进入 PiP：全仓 `grep "Pip\."` 只有 `setPlaying`(`pip.ts:49`) 与 `setGeometry`(`pip.ts:69`)。进入时机由原生 `MainActivity.onUserLeaveHint()`(`:61-67`) 决定。`VideoView.vue:1525,1533` 的 `pip` 图标是**页内小窗**播放（`miniHere`），不是系统画中画 | 中（行为描述错误） |
| 3 | `docs/06:86` 写 `@PluginMethod public void enterPip(PluginCall call)` | `@PluginMethod` 名字是 **`enter`**（`PipPlugin.java:66-67`）；`enterPip()` 是私有辅助（`:95`） | 中 |
| 4 | `docs/06:69,71` 写 `registerPlugin<any>('Pip')` | 还原侧是 `registerPlugin<PipPlugin>('Pip')`（有类型） | 低 |
| 5 | `docs/06:183` "本仓库不含完整的 Gradle 工程" | `app/android` 已是完整 v0.4.3 工程（且与上游字节一致） | 中（已过时，会误导后续工作） |
| 6 | `docs/06:194-207` 列"要手动补的东西"7 项 | 全部已具备（MainActivity/PipPlugin/ImmersivePlugin/capacitor.config.json/file_paths.xml/主题/图标） | 中（同上） |
| 7 | `docs/06:115` 权限"只有 INTERNET + DYNAMIC_RECEIVER…" | ✅ 正确 | — |
| 8 | `docs/06:111-112` versionCode 7 / versionName 0.4.3 / 22-34-34 | ✅ 正确 | — |

---

# D. 未能验证部分（受本机环境限制，非"已通过"）

| # | 项 | 原因 | 影响 |
|---|---|---|---|
| D-1 | Gradle 同步/构建是否真的成功 | 无 `java`/`javac`/`gradle`、无 Android SDK（`which java javac gradle` 全空，`/opt` 只有 browser/dshapp/dshbox/dshbox-cache/pilot） | S-1/S-2 是**静态推断的必然失败**，但"改完后是否成功"未验证 |
| D-2 | `gradle/wrapper/gradle-wrapper.jar` 是否完好（能否引导 8.2.1） | 需要 JVM 才能校验 zip/jar 内部与主类 | 低 |
| D-3 | **`res/values/styles.xml` 三个主题的实际属性值** | APK 解码器把 `<style>` 复合资源输出为注释占位（`/root/学习软件/android/res/values/styles.xml:9-11`），没有解析 arsc 的 `map` 条目 | 只能确认"主题名存在"，`parent` 与 `<item>` 需靠上游源码（已一致） |
| D-4 | `drawable*/splash.png`（11 个）与 `mipmap-anydpi-v26/*.xml` 内容 | 解码器只导出了 `mipmap/`、`values/`、`xml/`，`drawable*` 目录整体未导出 | `AppTheme.NoActionBarLaunch` 的 `@drawable/splash` 无法与 APK 侧比对 |
| D-5 | APK 内 Java 字节码是否与这 3 个 `.java` 完全对应 | 无 `jadx`/`dex` 工具链；只有 `classes*.dex` 里的类名/方法名（`docs/06:49-58` 记录过） | C.4 的语义描述来自源码 + dex 符号一致性，**不是逐条字节码比对** |
| D-6 | 真机行为：沉浸式是否真的消掉上下黑带、PiP 是否真能进入 | 无安卓设备/模拟器 | 属运行时验证 |
| D-7 | 资源合并后 manifest 的最终形态 | 需 AGP 才能跑 `processDebugManifest` | 已用"解码 manifest 减去上游 manifest = AGP/AndroidX 注入项"的方式反向确认（§C.2 后三行） |
| D-8 | `npm i` 后 `.pnpm` 路径问题是否会因 `cap sync` 自愈 | 跑 `npx cap sync` 会**修改** `app/android`，与"只读"约束冲突，故未执行 | 需父 agent 授权后在可写环境验证 |

---

# E. 附：严重度汇总

| 级别 | 数量 | 条目 |
|---|---|---|
| **严重** | 3 | S-1 `.pnpm` 硬编码路径（`capacitor.settings.gradle:2-19`）；S-2 `capacitor-cordova-android-plugins/` 缺失（`settings.gradle:2-3` / `app/build.gradle:42` / `capacitor.build.gradle:10`）；S-3 无 `assets/public`（未 `cap copy`） |
| **中** | 4 | M-1 无 `local.properties`/SDK；M-2 `@capacitor/cli` 未进 `package.json`；M-3 `docs/06` 的 `{enabled}`/`enterPip`/`enter` 方法名与行为错误（3 条文档错）；M-4 `docs/06:183`「不含 Gradle 工程」已过时 |
| **低** | 6 | `--font`/`--mono` 引号风格；53 处 `rgba()`→hex 写法；`::before`→`:before` 5 处 + keyframes `from/100%`→`0%/to`；`recovered/*.css` 与 `.vue` 内联双份（18×2）；`plugins.ts` 未声明 `enter`/`isSupported`；`clipboard.ts:3` 注释提到不存在的 `execCommand` 兜底 |
| **样式实质缺陷** | **0** | 变量缺失 0、规则缺失 0、数值改动 0、组件选择器差异 0 |
| **适配层职责缺失** | **0** | 12 项职责全覆盖、36 通道 1:1 |
| **原生壳与上游差异** | **0**（`diff -r` 零差异） | 与 APK 解码事实冲突 0 项 |
