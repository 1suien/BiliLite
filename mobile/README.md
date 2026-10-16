# BiliLite 安卓版（Capacitor）

和桌面版**共用同一份渲染层与 B 站接口层**，只换掉外壳（Electron → Capacitor + Android WebView）
和平台适配层（文件对话框 / 加密存储 / 网络头）。

目标设备：**小米平板 6**（`23043RP34C`，Android 14 / HyperOS，11 英寸 2880×1800，8 GB）。
横屏 CSS 视口约 **1047×654 dp**，和桌面窗口 1267×717 很接近，所以布局基本沿用桌面版，
只加了一层触屏/安全区的微调（`src/mobile/mobile.css`）。

版本：`versionCode 6` / `versionName 0.4.2`（`mobile/android/app/build.gradle`）。

## 三层结构

| 层 | 复用方式 |
| --- | --- |
| `src/renderer/**` | **原样复用，一行没改逻辑**。11 个 view 只通过 `src/renderer/src/api/index.js` 接触桥，只要在 Vue 挂载前把 `window.bili` 装好即可 |
| `src/main/bili/**` | **原样复用**（12 个文件，已无 electron / node: 依赖）：`runtime.js` 注入 store、`md5.js` 纯 JS 签名、`http.js` 的 `setCookieMode()` + `setHttpFetch()` |
| `src/mobile/**` | 新写的安卓平台层：`bridge.js`（IPC 通道表的 web 版）+ `store.js`（原生 Preferences）+ `native-http.js`（原生 HTTP）+ `platform.js`（剪贴板 / 全屏 / 画中画）+ `local-files.js`（本地视频库，SAF → `blob:`） |

`src/shared/default-settings.js` 是两端共用的默认设置，避免默认值漂移。

## 启动路径

```
mobile/index.html
  └─ src/mobile/main.js                      （boot() 里按顺序做，失败会把堆栈画到页面上）
       ├─ import './mobile.css'             触屏样式，只在 html[data-platform='android'] 下生效
       ├─ document.documentElement.dataset.platform = 'android'
       ├─ await installBridge()              src/mobile/bridge.js
       │    ├─ setBiliStore(store)           把 B 站接口层接到 WebView 版 store
       │    ├─ setCookieMode('explicit')     桌面/安卓都自己拼 Cookie 头（Cookie 来自接口应答，见下）
       │    ├─ setHttpFetch(createNativeFetch())  接口 JSON 走原生 CapacitorHttp
       │    ├─ await store.load()            原生 Preferences（异步，所以 installBridge 也变成 async）
       │    └─ window.bili = api             （多一个 platform: 'android'）
       ├─ installPlatformShims()             剪贴板 / 全屏 / 画中画（渲染层无感）
       ├─ await import('../renderer/src/main.js')   ← 必须动态 import
       └─ await wireAndroidBack()            物理返回键
```

> 动态 import 是**必须**的：`src/renderer/src/api/index.js` 在模块顶层就读 `window.bili`，
> 静态 import 会被提升到 `installBridge()` 之前，桥还没装上。
>
> `boot()` 也没有用顶层 await：vite 的 `target` 是 es2020，esbuild 在 es2020 下拒绝顶层 await。

渲染层里只有一处直接碰网络（不经桥）：`src/renderer/src/player/dash.js` 用
`fetch(url, { headers: { Range } })` 拉 DASH 分片喂 MSE。这条路径**故意保留走 WebView 的 fetch**，
因为它会被 Capacitor 的原生代理接管（见下节）。

## 网络方案（两条腿）

安卓 WebView 里 `Referer` / `Origin` 是 forbidden header，JS 设了也会被丢掉；
而 B 站 CDN 既校验 `Referer`、又**按 User-Agent 放行**（下面这张表是拿真视频的签名分片
URL 逐个 curl 出来的，2026-10-16 真机上报的「HTTP 403 这条线路暂时拿不到数据」就是它）：

| 媒体分片请求（GET + `Range`） | 结果 |
| --- | --- |
| 不带 `Referer` | **403** |
| `Referer: https://localhost/`（Capacitor 默认 hostname） | **403** |
| `Referer: https://www.bilibili.com/` + **桌面** Chrome UA | **206** |
| `Referer: https://www.bilibili.com/` + Chrome **安卓** UA | **403** |
| `Referer: https://www.bilibili.com/` + WebView（UA 里带 `; wv`） | **403** |

也就是说媒体请求必须**同时**满足「Referer 像 bilibili.com」和「UA 是桌面浏览器」。
UA 那半边在原生侧解决：`MainActivity#applyDesktopUserAgent()` 覆写
`WebSettings.setUserAgentString()`，用的就是 `src/main/bili/http.js` 里那个 `UA` 常量
（同一个串实测 206）。接口调用本来就由 `BASE_HEADERS` 带桌面 UA，所以只需改 WebView 这一处。

于是方案是分而治之：

1. **媒体分片**（DASH，含 `Range`）走 WebView 自己的 `window.fetch`。
   `capacitor.config.json` 里把 **`server.hostname` 设成 `www.bilibili.com`**，页面同源就是 B 站，
   WebView 自动带上的 `Referer` 天生正确；同源还顺带让 `Origin` 也对。
   Capacitor 的 fetch 补丁（`native-bridge.js`）会把 GET 改写成
   `https://<hostname>/_capacitor_http_interceptor_?url=<真实地址>`，由原生
   `WebViewLocalServer.handleCapacitorHttpRequest` 用 OkHttp 代理并流式返回（`WebResourceResponse`），
   **没有 CORS 限制**，`Range` 请求也照原样转发。
2. **接口 JSON** 走 `setHttpFetch(createNativeFetch())` → `CapacitorHttp.request()`（原生 OkHttp）：
   可以自定义 `Referer` / `Origin` / `Cookie`，也不受 CORS 约束。源码 `src/mobile/native-http.js`。

**Cookie**：`cookieMode` 保持 `'explicit'`（两端一致）。扫码登录时
`src/main/bili/auth.js` 从轮询应答的 URL 里 `absorbCrossDomain()` 解析出 Cookie 存进 store，
之后每个请求由 `http.js` 拼成 `Cookie` 头 —— 不依赖 WebView 的 Set-Cookie 行为。
（媒体分片不需要 Cookie，签名 URL 自带鉴权；CookieManager 里也有的话由原生代理自动补。）

## 起播速度（2026-10-16 真机反馈「视频加载时间长」）

先量数据再改代码。用真视频（BV1zY4y187cK）实测了候选线路，结论是**带宽不是瓶颈**：

- 未登录时 `playurl` 只给到 480P（视频 164 kbps、音频 86 kbps ≈ 20 KB/s），6 条候选线路
  TTFB 128–238 ms、实速 2.89–5.10 MB/s，最快的镜像与 `baseUrl` 只差 **~72 ms** —— 抢线路没有收益。
- 耗时在**轮次**上：`video.view` + `video.playurl` 两次接口往返之后才建 MSE 拉流；
  每条轨（视频、音频）各自要等**首个 ≥64KB 的分片**才会让 `player.load()` 返回。
- 音频轨的 `baseUrl` 实测落在 **`*.mcdn.bilivideo.cn`（P2P 线路）** 上：官方播放器能跟它的
  WebRTC/私有通道配合，第三方客户端拿不到，首包可能干等十几秒。

于是改了三处（都在共用层 `src/renderer/src/player/dash.js`，桌面端同享）：

1. `trackUrls()` 把 mcdn 线路**排到所有直连 CDN 后面**，只在直连线路都用不了时才回退过去。
2. `streamFrom()` 加 **8s 首包看门狗**（`FIRST_BYTE_TIMEOUT`）：连接接上了却一直不发字节就
   `abort()` 换下一条线路 —— 否则用户看到的是「缓冲中…」十几秒不动。
3. 新增起流读数 `player.stat`（`t0/tResp/tFirst/host/vBytes/aBytes`），安卓端显示在播放器上
   （`VideoView.vue` 的 `perfText`）：

```
地址 0.8s · 首块 2.1s · 首帧 2.6s · sz-mirrorhw · 1.2MB · 0.6MB/s
```

缓冲时显示在提示文字下面，播起来缩到左上角，30 秒后自动消失；桌面端不显示（`IS_ANDROID_UI`）。
定位方式：**地址**久 = 接口慢/风控；**首块**久 = CDN 线路（看 host 是不是 mcdn）；首块快但
**首帧**久 = 解码；**MB/s** 低 = 带宽不够。

## 安卓平台能力（`src/mobile/platform.js` + 原生插件）

桌面端的这些能力原来在 Electron 主进程里，安卓端换成了 Capacitor 插件 / 自写插件。
原则是**渲染层一行不改**：能在 window 上打补丁就打补丁。

| 能力 | 实现 | 渲染层 |
| --- | --- | --- |
| 设置 / 登录态存储 | `@capacitor/preferences`（安卓侧 SharedPreferences，应用私有目录，升级不丢）+ localStorage 镜像兜底；`load()` 是异步的，`installBridge()` 会 await 它再挂渲染层，否则会先闪一下默认主题和「未登录」 | 无感（`window.bili.settings.*`） |
| 剪贴板 | `navigator.clipboard` 被替换成 `@capacitor/clipboard`（原生，不挑焦点/手势），原生不可用时回退浏览器实现；shim 上留了 `__bililite = 'native-clipboard'` 便于自动化验证 | 无感（`LearnView.vue` 导出 JSON、`VideoView.vue` 复制 BV 号都照旧写 `navigator.clipboard.writeText`） |
| 全屏 | 监听 `fullscreenchange`：进全屏 `StatusBar.hide()` + `ScreenOrientation.lock({orientation:'landscape'})`，退出还原 | 无感（`VideoView.vue` 的 `requestFullscreen()` 照旧） |
| 画中画 | 自写原生插件 `mobile/android/.../PipPlugin.java`：JS 只汇报「在播没有 + 视频区域」，`MainActivity.onUserLeaveHint()` 在按 Home 时进入 PiP，并用 `setSourceRectHint` / `setAspectRatio` 让小窗贴着视频区域。Manifest 里 `android:supportsPictureInPicture="true"` | 无感（`platform.js` 在 document 上捕获 `play`/`pause`/`ended`，不必拿播放器引用） |
| 物理返回键 | `@capacitor/app` 的 `backButton` 监听，按优先级：登录弹层 → 确认框 → 全屏 → 剧场模式 → 路由历史 → `minimizeApp()`（回首页时收到后台，不是杀进程） | 无感 |
| 本地视频库 | `src/mobile/local-files.js`：隐藏 `<input type="file">`（系统 SAF 选择器）→ `URL.createObjectURL(file)` 成 `blob:` URL；条目形状与桌面 `src/main/local-media.js` 的 `entryFor()` 一致（`id` = `md5(文件名｜大小｜修改时间)` 前 24 位，与桌面同算法，所以「重选同一个文件」能接上原来的进度） | 无感（`LocalView.vue` 的「打开文件 / 打开文件夹」→ `local:pickFiles/pickFolder`；「打开文件夹」在安卓上等价于一次多选） |
| 数据导出 / 备份 | `backup:write` 先试公共「文档」目录（`Directory.Documents`），分区存储下写不进去就退到应用缓存目录，然后一律弹 `@capacitor/share` 的**系统分享面板**（「保存到…」），用户自己选存到文件 / 网盘 / 微信；`sys:pickFile` 返回一个说明串（安卓没有可回写的绝对路径），`sys:revealPath` = 再分享一次上次导出的文件 | 无感（`SettingsView.vue` 的「选择 / 写入 JSON 备份 / 打开」） |

> 为什么 SESSDATA 不能像桌面端那样判断登录态：WebView 里它是 HttpOnly，JS 读不到
> （Cookie 由原生 CookieManager 自动随请求带上），所以安卓端 `store.isLoggedIn()` 看 `state.user`。

## 构建

前置：JDK 17 + Android SDK（本机装在 `C:\Users\zouyx\android-toolchain\`）。
Capacitor 侧依赖在 `mobile/` 里**独立安装**（`--ignore-workspace`，避免出现两份 Vue）：

```powershell
$env:JAVA_HOME  = 'C:\Users\zouyx\android-toolchain\jdk-17'
$env:ANDROID_HOME = 'C:\Users\zouyx\android-toolchain\sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME

# 本机 node / pnpm 不在 PATH，用绝对路径（普通机器直接 node / pnpm 即可）
$NODEDIR = 'C:\Users\zouyx\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin'
$NODE = "$NODEDIR\node.exe"
$PNPM = 'C:\Users\zouyx\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'

# node 必须进 PATH：pnpm 跑 script 时执行的是 node_modules\.bin\vite.cmd，它内部再调 node
$env:PATH = "$env:JAVA_HOME\bin;$NODEDIR;$env:PATH"

Set-Location 'C:\Users\zouyx\Desktop\学习APP\_work\BiliLite-src\mobile'
& $NODE $PNPM install --ignore-workspace                        # 只装 @capacitor/* + vite + plugin-vue
& $NODE $PNPM run build                                         # = vite build → mobile/www
& $NODE node_modules\@capacitor\cli\bin\capacitor sync android  # 拷 www → android/app/src/main/assets/public
Set-Location android
& .\gradlew.bat assembleDebug --console=plain
```

产物：`mobile/android/app/build/outputs/apk/debug/app-debug.apk`（当前 **4,103,477 B / 4.10 MB**，
`versionCode 6` / `versionName 0.4.2`；本机已核对该 APK 与 `pnpm run build` 重建的 www 字节一致）。

> `mobile/android/local.properties` 里写 `sdk.dir=...`（Capacitor 的 `.gitignore` 已忽略它，不要提交）。
> 改了 `src/renderer` / `src/mobile` / `capacitor.config.json` 之后都要重新
> `vite build` + `cap sync android`，否则 APK 里还是旧资源（`android/app/src/main/assets/public` 是同步产物，同样不提交）。
> 检查 APK 里的 web 层是不是新的：`assets/public/assets/index-*.js` 的哈希应和 `mobile/www/assets/` 一致。
>
> `pnpm install` 会以**退出码 1** 结束并打印 `ERR_PNPM_IGNORED_BUILDS ... esbuild@0.21.5`：
> 这只是 pnpm 拦下了 esbuild 的安装脚本，平台二进制已经在 `node_modules` 里，`vite build` 照常成功；
> 想消掉提示就跑一次 `pnpm approve-builds`。
>
> ⚠️ 上面这个退出码 1 还会连带搞坏 `pnpm run build`：pnpm 11 在跑 script 前会先自动
> `pnpm install` 做依赖校验，那个 install 以 1 退出，script 根本不会执行（表现为
> `pnpm run build` 只打印 pnpm 的报错、`www/` 一点没变）。已在 `mobile/pnpm-workspace.yaml`
> 里写 `verifyDepsBeforeRun: false` 关掉这个预检（`mobile/.npmrc` 里写
> `verify-deps-before-run=false` **不生效**，实测过）。
>
> `build` 脚本是 `vite build --config vite.config.mjs`，路径相对 `mobile/`，
> 所以**必须在 `mobile/` 目录里跑**（`vite.config.mjs` 自身用 `import.meta.url`
> 定位 root / 入口 / 依赖，与 cwd 无关）。

### 安装到平板

```powershell
& "$env:ANDROID_HOME\platform-tools\adb.exe" install -r app-debug.apk
# 或者：直接把 app-debug.apk 拷到平板（微信/网盘/数据线），在文件管理器里点开安装
```

## 本机已踩过的坑

- **工程路径含中文**：本机仓库在 `...\Desktop\学习APP\...`，AGP 会直接报
  `Your project path contains non-ASCII characters`。已在 `mobile/android/gradle.properties`
  固化 `android.overridePathCheck=true`（另加 `-Dfile.encoding=UTF-8`）。
- **Gradle wrapper 下载**：`-all.zip`（230 MB）在本机代理下 85% 处超时。已改成 `-bin.zip` +
  `networkTimeout=120000`，并把 zip 手工放进
  `%USERPROFILE%\.gradle\wrapper\dists\gradle-8.2.1-bin\<hash>\`（`<hash>` 是对
  distributionUrl 做 `BigInteger(1, md5(url)).toString(36)`）。
- **代理**：`GRADLE_OPTS` 里写 `-Dhttp.nonProxyHosts=localhost|127.0.0.1` 时，
  `|` 会被 `cmd /c` 当管道；本机构建统一用 `& .\gradlew.bat` 直接跑，不加 nonProxyHosts。
- **模拟器**：本机 `HypervisorPlatform`（WHPX）为 `Disabled`，Android 模拟器无法加速
  （启用需要重启），所以早期验证走的是「headless 浏览器 + 安卓 UA + 1047×654 视口加载
  `mobile/www`」这条等价路径：它没有 Electron preload，`window.bili` 为空，
  跑的正是 `installBridge()` 这条安卓启动分支。

## 验证方式（本机模拟器不可用，走的是等价路径）

`_work/mobile-preview.mjs`：把 `mobile/www` 用静态服务器喂给 headless Edge，以「安卓平板 UA
+ 1047×654 视口」加载。它没有 Electron preload，`window.bili` 为空，所以走的正是
`installBridge()` 这条安卓启动分支。逐路由截图落在 `_work/shots-mobile/`，同时检查：

- **冷启动**：`dataset.platform='android'`、`window.bili.platform='android'`、侧栏含「本地」、
  无横向溢出、导航项触控高度 46 px、`#app` 有内容（白屏会带出堆栈）
- **平台补丁**：剪贴板 shim 标记为 `native-clipboard`；派发一次 `fullscreenchange` 后
  `dataset.fullscreen` 被写值（证明监听器挂上且原生调用失败被兜住）；对临时 `<video>`
  派 `play` / `pause` 时 `dataset.pip` 跟着变 1 / 0
- **存储往返**：写一个设置 → `Page.reload` → 读回同一个值，并且重载后 App 仍能正常挂载
- **本地视频库**：用 CDP 的 `DOM.setFileInputFiles` 往隐藏 `<input type="file">` 里塞真文件
  （等价于用户在 SAF 选择器里点了文件），验证四件事：条目 id/路径/大小/MIME 正确、
  `register()` 命中 1 条 + 未登记的路径进 `missing`、`blob:` URL 能当媒体源播
  （`loadedmetadata` 拿到真实时长）、进「本地」页点「打开文件」后列表里真的出现行
  （`0:02 probe-tone.wav 31 KB 播放` / `0:05 屏幕录制 ….mp4 9.0 MB 播放`）

原生侧另用 `aapt dump badging/xmltree` + 在 `classes*.dex` 里搜字符串确认：
`PipPlugin` 类进了 `classes4.dex`（含 `setSourceRectHint` / `enterPictureInPictureMode`），
`MainActivity` 里的桌面 UA 串（`Windows NT 10.0; Win64; x64`）也在 `classes4.dex`，
Manifest 上 `android:supportsPictureInPicture` 已生效。

## 已知限制 / 尚未在真机验证

- **本地视频**：走 SAF 选择器 + `blob:` URL，所以**只在本次页面会话里有效** —— App 重启后
  系统不再把同一个文件的读权限给 WebView，条目会显示成「文件不在了」（红字），需要重新选一次。
  id 由「文件名+大小+修改时间」哈希得到，重选同一个文件会拿到同一个 id，之前存的进度/笔记能接上。
  没有自定义协议（桌面的 `lmedia://`）也没有绝对路径，「打开位置」在安卓上不可用（会提示）。
- **画中画**：只在 Android 8.0+ 生效（低版本 `supported()` 返回 false）；平板上的 PiP 是
  **整页缩放**，`setSourceRectHint` 只是给系统的裁剪提示，效果要真机看。
- **设置存储**：web 端验证跑的是 Preferences 的 localStorage 实现，真机上是 SharedPreferences，
  首次启动的读写行为待真机确认（失败会回退 localStorage 镜像，不会丢设置）。
- **全屏**：进全屏会锁横屏，部分平板系统会忽略方向锁定，忽略即可（异常已兜住）。
- **备份导出**：`backup:write` 先试 `Directory.Documents`（分区存储下多半失败），失败退到应用
  缓存目录，然后弹系统分享面板让用户另存 —— 真机上「保存到文件/网盘」这一步**未验证**。
- **真机未验证项**：原生 HTTP 的实际响应形态、Cookie 跨会话保持、物理返回键的手势交互、
  刘海/手势条安全区、画中画小窗。这些都只能在平板上跑一次才算数（`adb install` 后可以再验）。
  拉流 403 的修复（桌面 UA）是 curl 层面实测 206 + APK 里确认代码已编进去，但**没有在真机上
  重新播过一次**；万一还 403，错误卡现在会多显示一行 `源=… · UA=桌面/Chrome126`，一眼能看出
  UA 到底换成功没有。
- 安卓端不做 Electron 端的 `ses.webRequest` 头注入（那是桌面独有的 `src/main/index.js` 逻辑）。
