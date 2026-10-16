# BiliLite 安卓版（Capacitor）

和桌面版**共用同一份渲染层与 B 站接口层**，只换掉外壳（Electron → Capacitor + Android WebView）
和平台适配层（文件对话框 / 加密存储 / 网络头）。

目标设备：**小米平板 6**（`23043RP34C`，Android 14 / HyperOS，11 英寸 2880×1800，8 GB）。
横屏 CSS 视口约 **1047×654 dp**，和桌面窗口 1267×717 很接近，所以布局基本沿用桌面版，
只加了一层触屏/安全区的微调（`src/mobile/mobile.css`）。

版本：`versionCode 4` / `versionName 0.4.0`（`mobile/android/app/build.gradle`）。

## 三层结构

| 层 | 复用方式 |
| --- | --- |
| `src/renderer/**` | **原样复用，一行没改逻辑**。11 个 view 只通过 `src/renderer/src/api/index.js` 接触桥，只要在 Vue 挂载前把 `window.bili` 装好即可 |
| `src/main/bili/**` | **原样复用**（12 个文件，已无 electron / node: 依赖）：`runtime.js` 注入 store、`md5.js` 纯 JS 签名、`http.js` 的 `setCookieMode()` + `setHttpFetch()` |
| `src/mobile/**` | 新写的安卓平台层：`bridge.js`（IPC 通道表的 web 版）+ `store.js`（localStorage）+ `native-http.js`（原生 HTTP） |

`src/shared/default-settings.js` 是两端共用的默认设置，避免默认值漂移。

## 启动路径

```
mobile/index.html
  └─ src/mobile/main.js
       ├─ import './mobile.css'             触屏样式，只在 html[data-platform='android'] 下生效
       ├─ document.documentElement.dataset.platform = 'android'
       ├─ installBridge()                    src/mobile/bridge.js
       │    ├─ setBiliStore(store)           把 B 站接口层接到 WebView 版 store
       │    ├─ setCookieMode('explicit')     桌面/安卓都自己拼 Cookie 头（Cookie 来自接口应答，见下）
       │    ├─ setHttpFetch(createNativeFetch())  接口 JSON 走原生 CapacitorHttp
       │    ├─ store.load()                  localStorage['bililite.state.v1']
       │    └─ window.bili = api             （多一个 platform: 'android'）
       ├─ await import('../renderer/src/main.js')   ← 必须动态 import
       └─ wireAndroidBack()                  物理返回键
```

> 动态 import 是**必须**的：`src/renderer/src/api/index.js` 在模块顶层就读 `window.bili`，
> 静态 import 会被提升到 `installBridge()` 之前，桥还没装上。

渲染层里只有一处直接碰网络（不经桥）：`src/renderer/src/player/dash.js` 用
`fetch(url, { headers: { Range } })` 拉 DASH 分片喂 MSE。这条路径**故意保留走 WebView 的 fetch**，
因为它会被 Capacitor 的原生代理接管（见下节）。

## 网络方案（两条腿）

安卓 WebView 里 `Referer` / `Origin` 是 forbidden header，JS 设了也会被丢掉；
而 B 站 CDN 校验 `Referer`（本项目实测）：

| 媒体分片请求 | 结果 |
| --- | --- |
| 不带 `Referer` | **403** |
| `Referer: https://localhost/`（Capacitor 默认 hostname） | **403** |
| `Referer: https://www.bilibili.com/` | **206** |

所以方案是分而治之：

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

## 构建

前置：JDK 17 + Android SDK（本机装在 `C:\Users\zouyx\android-toolchain\`）。
Capacitor 侧依赖在 `mobile/` 里**独立安装**（`--ignore-workspace`，避免出现两份 Vue）：

```powershell
$env:JAVA_HOME  = 'C:\Users\zouyx\android-toolchain\jdk-17'
$env:ANDROID_HOME = 'C:\Users\zouyx\android-toolchain\sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"

# 本机 node / pnpm 不在 PATH，用绝对路径（普通机器直接 node / pnpm 即可）
$NODE = 'C:\Users\zouyx\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$PNPM = 'C:\Users\zouyx\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'

Set-Location 'C:\Users\zouyx\Desktop\学习APP\_work\BiliLite-src\mobile'
& $NODE $PNPM install --ignore-workspace                        # 只装 @capacitor/* + vite + plugin-vue
& $NODE $PNPM run build                                         # = vite build → mobile/www
& $NODE node_modules\@capacitor\cli\bin\capacitor sync android  # 拷 www → android/app/src/main/assets/public
Set-Location android
& .\gradlew.bat assembleDebug --console=plain
```

产物：`mobile/android/app/build/outputs/apk/debug/app-debug.apk`（当前 ≈ **4.1 MB**）。

> `mobile/android/local.properties` 里写 `sdk.dir=...`（Capacitor 的 `.gitignore` 已忽略它，不要提交）。
> 改了 `src/renderer` / `src/mobile` / `capacitor.config.json` 之后都要重新
> `vite build` + `cap sync android`，否则 APK 里还是旧资源（`android/app/src/main/assets/public` 是同步产物，同样不提交）。

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

## 已知限制 / 尚未在真机验证

- **本地视频**：安卓端侧栏已隐藏「本地」入口（`src/renderer/src/App.vue` 按
  `window.bili.platform === 'android'` 过滤），`sys:pickFile` / `local:pickFiles` 会抛
  「安卓版暂不支持本机文件选择」。WebView 里没有 Electron 文件对话框，也留不住 File 句柄。
- **备份导出**：`backup:write` 用 `@capacitor/filesystem` 的 `Directory.Documents`，
  Android 10+ 分区存储下是否可写**未验证**。
- **真机未验证项**：原生 HTTP 的实际响应形态、Cookie 跨会话保持、物理返回键的手势交互、
  刘海/手势条安全区、播放起流。这些都只能在平板上跑一次才算数（`adb install` 后我可以再验）。
- 安卓端不做 Electron 端的 `ses.webRequest` 头注入（那是桌面独有的 `src/main/index.js` 逻辑）。
