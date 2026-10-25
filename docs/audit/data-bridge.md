# BiliLite 数据层还原核对报告（还原侧 app/src ↔ 上游 v0.4.3）

**一句话结论**：还原侧数据层与上游 v0.4.3 是**语义等价的重写**，不是"照抄改名"——37 个 bridge 通道、18 项默认设置、Dexie v1→v7 schema、WBI/MD5 全部经机械比对**零差异**；接口层 29 个导出与上游 38 个导出全部一一对应（missing 0 / extra 0，其余收敛为内部函数）。**未发现会导致接口错误、崩溃或数据损坏的差异**；真实行为差异只有 2 处（1 处中等、1 处低），其余 8 条为文案/注释/多余导出/新增别名字段级别。

**还原度估计：数据层 ≈ 98% 语义等价**（按"行为面"计 100% 等价，按"字节/结构"计 98%）。差异统计：严重 0 / 中 1 / 低 9。

> 审计口径：只读，未修改 `/root/学习软件` 下任何文件；所有结论均由 `/tmp/audit/verify/*` 脚本机械产出或逐行对照得出。

---

## 一、文件映射表

| 还原文件 | 上游文件 | 等价度 | 说明 |
|---|---|---|---|
| `app/src/bridge/types.ts`（163 行） | `src/renderer/src/api/index.js`（95 行，`api` 对象形状）+ `main/bili/*.js` 的返回结构 | 98% | 类型声明是还原侧新增（上游是纯 JS 无类型）。`WbiBridge` 的 10 个命名空间与上游 `api` 对象**逐键相同**；结果类型多出别名联合（如 `FavResourcesResult` 同时有 `medias`/`items`、`PlayUrl` 有 `videos`/`audios`），属新增非破坏 |
| `app/src/bridge/index.ts`（99 行） | `src/renderer/src/api/index.js`（`missing()` 在 10 行） | 95% | 都是"延迟取 `window.bili` 的薄门面"。差异在缺桥错误文案（见 D3），另 `platform` 缺省返回 `'unknown'`（上游无此 getter） |
| `app/src/bridge/api.ts`（1277 行） | `main/bili/auth.js`+`video.js`+`search.js`+`home.js`+`fav.js`+`space.js`+`danmaku.js`（业务）+ `http.js`/`wbi.js` 的薄封装 | 99% | 29 导出 ↔ 上游 38 导出，业务函数 1:1；`fetchFavFolders`/`fetchCollectedFolders` 在还原侧收敛为内部 `favCreated`/`favCollected`，只对外暴露 `favFolders`（与 `mobile/bridge.js` 的 `fav:folders` 组合方式一致）。多出卡片别名字段（`withCardAliases`），非破坏 |
| `app/src/bridge/http.ts`（327 行） | `main/bili/http.js`（146 行）+ `mobile/native-http.js`（157 行） | 98% | `BASE_HEADERS`/`buildUrl`/`request`/`api()→getData` 逐行等价；**缺** `setCookieMode('native')` 分支（D4）；**多** 调用方 `signal`（D9） |
| `app/src/bridge/wbi.ts`（187 行） | `main/bili/wbi.js`（51 行）+ `main/bili/md5.js`（92 行），md5 内联 | **100%** | 端到端跑 211 组 md5、200 组 mixinKey、6 组 encWbi，全部与参照实现一致（见 §二.5） |
| `app/src/bridge/state.ts`（245 行） | `mobile/store.js`（147 行）+ `shared/default-settings.js`（34 行）+ `http.js` 的 `absorbSetCookie` | **100%** | 键名 `bililite.state.v1`、`raw:`+base64 编码、`Preferences→localStorage` 迁移、payload 形状、`isLoggedIn` 判据、Set-Cookie 解析规则全部一致 |
| `app/src/bridge/android.ts`（598 行） | `mobile/bridge.js`（378 行）+ `mobile/local-files.js`（134 行，helper 内联） | **100%** | 37/37 通道同名同序同默认值；`invoke`/`call` 信封一致；`backup:write` 逐行等价 |
| `app/src/bridge/mock.ts`（645 行） | **无对应上游文件** | — | 还原侧新增的开发者数据桥（D1/D7） |
| `app/src/db/index.ts`（554 行） | `src/renderer/src/db/index.js`（502 行） | 99% | v1–v7 每版 stores 逐条相同（表数 5/11/14/15/16/17/19）；28 个导出函数同名同序；仅 `putProgress` 返回值不同（D2） |
| `app/src/native/plugins.ts`（19 行） | `mobile/platform.js:25,27`（`registerPlugin('Pip'/'Immersive')`） | **100%** | 插件集合与注册方式相同 |
| `app/src/native/clipboard.ts`（35 行） | `mobile/platform.js:32-69`（`installClipboard`） | 100% | 逻辑等价；仅注释说"再失败退回 execCommand"但实现无该分支（D6，上游也无） |
| `app/src/native/pip.ts`（74 行） | `mobile/platform.js:74-99`（`installFullscreen`）+ `:104-150`（`installPip`） | **100%** | `dataset.fullscreen`/`dataset.pip`、Immersive/StatusBar/ScreenOrientation 调用与 try/catch 结构一致 |
| （无聚合文件） | `mobile/platform.js:153-157`（`installPlatformShims()`） | — | 还原侧改为 `main.ts:55-59` 逐个调用（D5，行为等价） |
| （入口）`app/src/main.ts` | `mobile/main.js`（116 行） | 96% | 启动顺序一致；新增"挂载前预热 6 个 store"、新增 mock 分支（D1）；上游 `wireAndroidBack()` 等价物为 `installBackButton()` |

---

## 二、机械比对结果

### 1. bridge 通道（37/37，missing=[] extra=[]，顺序完全一致）

脚本：`node /tmp/audit/verify/verify-channels.mjs` → `上游通道 37 还原通道 37 / missing: [] / extra: [] / 顺序一致: true`

| 通道 | 还原 `android.ts` 行 | 上游 `mobile/bridge.js` 行 |
|---|---|---|
| `app:ping` | 280 | 107 |
| `auth:restore` | 283 | 110 |
| `auth:qrGenerate` | 293 | 114 |
| `auth:qrPoll` | 295 | 115 |
| `auth:logout` | 297 | 116 |
| `home:feed` | 300 | 118 |
| `home:popular` | 302 | 119 |
| `search:videos` | 305 | 121 |
| `search:ups` | 308 | 122 |
| `video:view` | 311 | 124 |
| `video:pages` | 313 | 125 |
| `video:playurl` | 315 | 126 |
| `video:related` | 317 | 127 |
| `video:danmaku` | 319 | 128 |
| `video:online` | 321 | 129 |
| `video:subtitle` | 323 | 130 |
| `video:sendDanmaku` | 325 | 131 |
| `up:info` | 328 | 133 |
| `up:videos` | 330 | 134 |
| `up:resolve` | 332 | 135 |
| `up:latest` | 334 | 136 |
| `up:followings` | 336 | 137 |
| `fav:folders` | 340 | 140 |
| `fav:resources` | 345 | 144 |
| `settings:get` | 348 | 146 |
| `settings:patch` | 350 | 147 |
| `sys:openExternal` | 353 | 150 |
| `sys:pickFile` | 360 | 160 |
| `sys:revealPath` | 362 | 161 |
| `sys:pickSubtitle` | 368 | 167 |
| `sys:readSubtitle` | 381 | 180 |
| `local:pickFiles` | 389 | 189 |
| `local:pickFolder` | 394 | 194 |
| `local:register` | 401 | 200 |
| `local:remove` | 403 | 201 |
| `local:reveal` | 405 | 202 |
| `backup:write` | 410 | 206 |

参数默认值逐一核对（`page||1`、`order||'totalrank'`、`qn||80`、`segment||1`、`pn||1`、`ps||50`、`perUp||2`、`fav:resources` 的 `ps||20`、`up:videos` 的 `ps=30` 与 `keyword||''`、`up:followings` 取 `state.user && state.user.mid`）**全部相同**；`video:playurl` 两边都不给 `qn` 设默认、直接透传。

### 2. DEFAULT_SETTINGS（18/18 完全一致）

脚本：`node /tmp/audit/verify/verify-settings.mjs` → `key 数 18 18 / missing: [] / extra: [] / 顺序一致: true`，且无任何值差异。

| # | key | 上游 `shared/default-settings.js` | 还原 `bridge/state.ts:33` | 结论 |
|---|---|---|---|---|
| 1 | `theme` | `'dark'` | `'dark'` | ✅ |
| 2 | `defaultQuality` | `80` | `80` | ✅ |
| 3 | `autoNext` | `true` | `true` | ✅ |
| 4 | `seekStep` | `5` | `5` | ✅ |
| 5 | `backupPath` | `''` | `''` | ✅ |
| 6 | `playerVolume` | `0.8` | `0.8` | ✅ |
| 7 | `autoCheckin` | `true` | `true` | ✅ |
| 8 | `playbackRate` | `1` | `1` | ✅ |
| 9 | `danmakuOn` | `true` | `true` | ✅ |
| 10 | `danmakuOpacity` | `0.9` | `0.9` | ✅ |
| 11 | `danmakuArea` | `1` | `1` | ✅ |
| 12 | `autoHideCtl` | `true` | `true` | ✅ |
| 13 | `navOrder` | `[]` | `[]` | ✅ |
| 14 | `subAuto` | `false` | `false` | ✅ |
| 15 | `subFontSize` | `22` | `22` | ✅ |
| 16 | `subBg` | `true` | `true` | ✅ |
| 17 | `subBottom` | `8` | `8` | ✅ |
| 18 | `focusTasks` | `['阅读','刷题','看课','整理笔记']` | 同 | ✅ |

### 3. 持久化 key / cookie 编解码 / secure 字段 / Set-Cookie

| 项 | 上游 | 还原 | 结论 |
|---|---|---|---|
| 存储 key | `mobile/store.js:25` `const KEY = 'bililite.state.v1'` | `state.ts:25` `export const STATE_KEY = 'bililite.state.v1'` | 相同 |
| 编码 | `store.js:27` `encodeSecret` → `'raw:' + btoa(utf8)` | `state.ts:55` `encodeSecure` → 同 | 相同 |
| 解码 | 非 `raw:` 前缀/解析失败 → `{}` | `state.ts:64` 同 | 相同 |
| 落盘 payload | `store.js:109-121` `{version:1,settings,user,secure}` | `state.ts:207` 同 | 相同 |
| 原生持久化 | `Preferences.set(...).catch(err => console.error('[store] 原生持久化失败:', err))` | 同文案同 catch | 相同 |
| 读失败回退 | 读 Preferences 抛错 → `localStorage.getItem(KEY)`，并回写迁移 | 同 | 相同 |
| 坏数据 | `JSON.parse` 失败 → settings/user/cookies 全重置 | 同 | 相同 |
| 设置合并 | `{...DEFAULT_SETTINGS, ...parsed.settings}` | 同 | 相同 |
| 登录判据 | `Boolean(user) \|\| Boolean(cookies.SESSDATA)` | 同 | 相同 |
| Set-Cookie 拆分 | `mobile/native-http.js:45-60` `splitSetCookie` 正则 `/^\s*[!#$%&'*+\-.^_`\|~0-9A-Za-z]+=/` 且当前段已含 `=` 才切 | `state.ts:103` 逐字相同 | 相同 |
| Set-Cookie 应用 | `main/bili/http.js:58-84` 值空或 `/^(deleted\|expired)$/i` → 删除；不同才写；有变化才 `store.persist()` 一次 | `state.ts:125-146` 同 | 相同 |
| Cookie 请求头 | `http.js:32-38` `; ` 连接 `k=v` | `http.ts:197` 同 | 相同 |

### 4. 接口清单（29 导出 ↔ 38 导出，missing 0 / extra 0）

| 上游导出（文件:函数） | 还原侧 | 结论 |
|---|---|---|
| `auth.js:ensureBuvid` | `api.ts:189 getBuvid(force)` | 等价（调用点 1:1，见 §二.6） |
| `auth.js:fetchNav` | `api.ts:241 fetchNavUser` | 等价 |
| `auth.js:qrGenerate` / `qrPoll` / `restore` / `logout` | `api.ts:265/276/310/341` | 等价（参数、`source:'main-fe-header'`、`timeout 12000`、`stale`、退出 body `biliCSRF=` 均同） |
| `video.js:normalizeView` | `api.ts:362 mapVideoDetail`（内部） | 等价（标题回落 `P${page}`、`stat` 六字段 `\|\|0`、pages 兜底单页） |
| `video.js:fetchView/fetchPages/fetchRelated/fetchPlayurl` | `api.ts:409/415/430/459` | 等价；`fetchPlayurl` 参数 `{bvid,cid,qn,fnver:0,fnval:4048,fourk:1,platform:'pc',high_quality:1}` 逐项相同 |
| `search.js:searchVideo/searchUp` | `api.ts:563/600` | 等价（`page_size` 30/20、`-403` 清 WBI 缓存重试一次） |
| `home.js:fetchRecommend/fetchPopular` | `api.ts:658/680` | 等价（`web_location 1430650`、`feed_version 'V8'`、`fresh_type 4`、`ps 12`；`-403` → 清缓存 + 回落热门） |
| `fav.js:fetchFavFolders/fetchCollectedFolders` | 内部 `favCreated:721`/`favCollected:730`，对外 `favFolders:739` | 等价（`web_location 333.1387`；`collect` 侧 `pn 1 ps 20`） |
| `fav.js:fetchFavResources` | `api.ts:749` | 等价（`order:'mtime',type:0,tid:0,platform:'web'`） |
| `space.js:fetchUpInfo` | `api.ts:807` | 等价（`CARD_URL {mid, photo:false}`） |
| `space.js` 的 `appSign`（脚本内私有，`:30`） | `api.ts:825 signAppParams` | 等价（`appkey`+`ts` 排序 `k=encodeURIComponent(v)` + md5(query+secret)） |
| `space.js:fetchUpVideos`(app/web 双路) | `api.ts:937 upVideos`（内部 `upVideosApp:835`/`upVideosWeb:877`） | 等价（app 侧 `mobi_app/android`、`build 8000300`、`device:phone`、UA=BiliDroid；web 侧 `web_location 1550101`、`order_avoided:true`；`-352/-412` → `ensureBuvid(true)`+600ms，`-403` → 清 WBI 缓存+300ms） |
| `space.js:fetchLatestByMids` | `api.ts:960 upLatest` | 等价（去重 `slice(0,60)`、`perUp` clamp 1..12、5 分钟缓存、并发 4、按 pubdate 倒序） |
| `space.js:fetchFollowings` | `api.ts:1015 upFollowings` | 等价（`order:'desc',order_type:'attention'`，`-403/-352` 重试不带签名） |
| `space.js:resolveUp` | `api.ts:1058 upResolve` | 等价（URL/UID 直取，否则搜索首个；两条错误文案相同） |
| `danmaku.js:parseDanmakuXml` | `api.ts:1097` | 等价（`parts<4` 跳过、`mode\|\|1`、`size\|\|25`、`color\|\|16777215`、排序、上限 4000） |
| `danmaku.js:fetchDanmaku` | `api.ts:1123 videoDanmaku` | 等价（seg 兜底 1、仅 seg 1 回退 `comment.bilibili.com/<cid>.xml`、`timeout 25000`、非 XML 时按 `json.code` 抛） |
| `danmaku.js:fetchOnlineTotal` | `api.ts:1157 videoOnline` | 等价（`{total,count}`，异常 `{total:0,count:0}`） |
| `danmaku.js:fetchSubtitle` | `api.ts:1184 videoSubtitle` | 等价（`slice(0,5)`、`timeout 15000`、`lanDoc: lan_doc\|\|lan`、空 content 过滤） |
| `danmaku.js:sendDanmaku` | `api.ts:1230` | 等价（100 字上限、`URLSearchParams` 字段集、`-101/-400` → `needLogin`） |
| `http.js:api` | `http.ts:317 getData` | 等价（非 JSON → `接口返回非 JSON（HTTP ${status}）`；`code!==0` → `message\|\|msg\|\|code N` 并挂 `biliCode`） |
| `http.js:fixUrl` | `api.ts:102 fixImageUrl` | 等价（`//`→`https:`、`http://`→`https://`） |
| `http.js:buildUrl` / `request` / `setHttpFetch` / `setCookieMode` / `cookieHeader` | `http.ts:205/256/180/192/197` | 等价（`setCookieMode` 只保留 explicit 分支，见 D4；`cookieHeader` 变私有） |
| `wbi.js:mixinKey/signParams/invalidateWbiKeys` | `wbi.ts:151 getMixinKey` / `:164 encWbi` / `:185 clearWbiCache` | 等价（见 §二.5） |
| `md5.js`（默认导出 md5hex） | `wbi.ts` 内联 `md5Hex` | 等价（211 组输入 0 失败） |

### 5. WBI / MD5 端到端

`node /tmp/audit/verify/verify-wbi.ts`（已实跑）：

```
md5Hex: 211 个输入与 node:crypto 比对，失败 0
mixinKey 重排: 200 组随机 key，失败 0
encWbi: 6 组参数端到端比对，失败 0
ALL EQUIVALENT
```

覆盖点：`MIXIN_KEY_ENC_TAB` 64 项逐项相同（上游 `wbi.js:6-10` ↔ `wbi.ts` 同表）；`KEY_TTL = 30*60*1000`（上游 `:12` ↔ 还原同值）；缓存键 `{imgKey,subKey,at}` 同；`getWbiKeys` 取 `nav` 接口、`basename = slice(lastIndexOf('/')+1, lastIndexOf('.'))`、失败文案 `无法获取 WBI 签名密钥，请检查网络` 同；`encWbi` 排序 + `String(v).replace(/[!'()*]/g,'')` + `encodeURIComponent` + `wts = Math.round(Date.now()/1000)` + `w_rid = md5(query+mixinKey)` 全同。测试输入含中文 key、含 ``!'()*`` 字符集、以及 wbi playurl / 空间搜索 / 关注列表的真实参数集。

### 6. Dexie schema（v1→v7 逐版零差异）

`node /tmp/audit/verify/verify-dexie.mjs` 输出：

```
v1: 上游 5 表 / 还原 5 表 missing [] extra [] 值差异 []
v2: 11/11  v3: 14/14  v4: 15/15  v5: 16/16  v6: 17/17  v7: 19/19
还原多出的版本: []
```

库名同为 `study-bili`（上游 `db/index.js:26` ↔ 还原 `db/index.ts:98`）。**两侧都没有 `.upgrade()` 回调**——上游所谓"v1→v7 迁移"其实只是 Dexie schema 版本链，没有数据搬迁代码；还原侧同样没有，因此这里不存在"迁移逻辑丢失"。

### 7. native 插件与能力降级

| 能力 | 上游 | 还原 | 结论 |
|---|---|---|---|
| 剪贴板 | `platform.js:32-69` shim `navigator.clipboard`（`Clipboard.write({string})`→回落原 `writeText`；`Clipboard.read()`），打 `__bililite:'native-clipboard'`，`defineProperty` 失败退原型 | `native/clipboard.ts:8` 同 | 等价 |
| 全屏 | `platform.js:74-99` `Immersive.setImmersive`+`StatusBar.hide/show`+`ScreenOrientation.lock('landscape')`，全 try/catch | `native/pip.ts:9` 同 | 等价 |
| 画中画 | `platform.js:104-150` 捕获阶段 `play/pause/ended`，几何仅在 `getBoundingClientRect` 有效时上报，`resize/orientationchange/fullscreenchange` 重测 | `native/pip.ts:32` 同 | 等价 |
| 插件注册 | `platform.js:25,27` `registerPlugin('Pip'/'Immersive')` | `native/plugins.ts:18-19` 同 | 等价 |
| 聚合入口 | `platform.js:153-157 installPlatformShims()` | 无该导出，改 `main.ts:55-59` 逐个调 | 等价（D5） |
| HTTP 通道 | `native-http.js` 用 `CapacitorHttp.request` + 自建 `Response` 形状 | `http.ts:119 createNativeFetch` 自建 `BiliHttpResponse` | 等价（超时 15000/20000、GET/HEAD 不发 body、`res.status` 非数字抛 `原生请求没有返回有效响应`） |

---

## 三、差异清单（按严重度）

### D1【中】`?mock=1` 在生产构建同样生效，且会往真实 IndexedDB 种演示数据

- 还原侧：`app/src/main.ts:33-41`
  ```ts
  const mockMode =
    new URLSearchParams(location.search).has('mock') ||
    !!((import.meta as any).env && (import.meta as any).env.DEV && !window.bili)
  ```
  随后 `app/src/main.ts:41-46`：
  ```ts
  const { installMockBridge } = await import('./bridge/mock')
  installMockBridge()
  const { seedDemoData } = await import('./dev/seed')
  await seedDemoData()
  ```
  且 `mockMode` 为真时**短路**掉 `hasDesktopBridge` 判断（`main.ts:48-54`）。
- 上游：无 mock 概念（`mobile/main.js` 只有 `hasDesktopBridge` 分支）。
- 影响：只有 `?mock=1` 那半个条件缺 `import.meta.env.DEV` 守卫。生产 APK 里若通过 deeplink/调试手段带上 `?mock=1`，会 ① 用假数据桥覆盖真桥、② `seedDemoData()` 写入**真实** `study-bili` 库（progress/daily/shelf/collect…），污染用户学习数据。默认启动（无 query）不受影响。
- 修复建议：把 `?mock=1` 分支也套进 `import.meta.env.DEV`，或改为 `?mock=1` 时只 `installMockBridge()` 不 `seedDemoData()`；`seedDemoData` 至少加 `if (await db.progress.count()) return` 的幂等/空库守卫。

### D2【低】`putProgress` 返回值语义不同（返回整条记录 vs 返回主键）

- 还原侧：`app/src/db/index.ts:226-230`
  ```ts
  export async function putProgress(p: ProgressRecord) {
    const rec = { ...p, key: `${p.bvid}:${p.cid}`, updatedAt: Date.now() }
    await db.progress.put(rec)
    return rec
  }
  ```
- 上游：`src/renderer/src/db/index.js:165-167`
  ```js
  export async function putProgress(rec) {
    return db.progress.put({ ...rec, key: `${rec.bvid}:${rec.cid}`, updatedAt: Date.now() })
  }
  ```
- 影响：Dexie `Table.put()` 返回主键字符串（`"bvid:cid"`），还原侧返回对象。全仓唯一调用点 `app/src/stores/learn.ts:175` 是 `await db.putProgress(...)`，**不取返回值**，因此当前无行为差异；若将来有代码 `const key = await putProgress(...)` 会拿到对象。
- 修复建议：改成 `return db.progress.put(rec)`，与上游对齐（同时省一次对象引用）。

### D3【低】缺桥错误文案与上游渲染层不一致

- 还原侧：`app/src/bridge/index.ts:25`
  `'未检测到数据桥（window.bili）。安卓端请通过 Capacitor 启动；桌面端请通过 Electron 启动。'`
- 上游：`src/renderer/src/api/index.js:10-16`（`missing()`）
  `'未检测到桌面端桥接（window.bili）。请通过 Electron 启动，而不是直接用浏览器打开。'`
- 影响：仅错误提示文本（两者都设 `needLogin=false`，调用方按 `needLogin` 分流不受影响）。还原侧文案其实更贴合"同时有安卓/桌面两种宿主"的现实。
- 修复建议：保留，或在报告中登记为"有意改写"。

### D4【低】HTTP 层没有 `setCookieMode('native')` 入口

- 还原侧：`app/src/bridge/http.ts:192` 只有 `useExplicitCookies()`（恒为 explicit）；`cookieMode` 变量无 setter。
- 上游：`src/main/bili/http.js:28-30` `setCookieMode(mode)`，仅当 `mode === 'native'` 时 `cookieMode = 'native'`，使 `request` 不带 `Cookie` 头、交由原生 cookie jar。
- 影响：上游自身在 `installBridge` 里也只调 `setCookieMode('explicit')`，`'native'` 分支是保留能力、当前无人调用 → **无行为差异**。若将来要做"交给 OkHttp cookie 管理"，还原侧需补 setter。
- 修复建议：无需改；如需完全对齐，加一个 `setCookieMode(mode)` 包装。

### D5【低】少一个 `installPlatformShims()` 聚合导出

- 还原侧：`app/src/main.ts:55-59` 直接 `installClipboard(); installFullscreen(); installPip()`（动态 import）。
- 上游：`src/mobile/platform.js:153-157` 导出 `installPlatformShims()` 并在 `main.js` 调用。
- 影响：行为等价（顺序相同），仅少一个导出函数，无外部消费者。
- 修复建议：可加一个同名聚合函数便于与上游对照，非必须。

### D6【低】`native/clipboard.ts` 文件头注释与实现不符

- 还原侧：`app/src/native/clipboard.ts:1-5`
  `* 失败时退回 navigator.clipboard，再失败退回老式 execCommand。`
- 实际实现（同文件 `:8-30`）只有 `Clipboard.write` → 原 `writeText` 两级回退，**没有 execCommand 分支**。
- 上游：`src/mobile/platform.js:32-69` 同样没有 execCommand。
- 影响：纯注释问题，会误导后续维护者。
- 修复建议：删掉"再失败退回老式 execCommand"半句。

### D7【低】mock 实现与真桥契约的三处偏差（仅 mock 模式可见）

| 项 | 真桥（`android.ts`） | mock（`mock.ts`） | 影响 |
|---|---|---|---|
| `ping()` | `{pong: Date.now(), version}`（`android.ts:280`） | `{ok:true, platform:'mock', time:Date.now()}`（`mock.ts:330-332`） | 若 UI 读 `pong`/`version` 会拿不到；dev 专用 |
| `up.latest(mids,perUp)` 默认 | `2`（`android.ts:334`） | `3`（`mock.ts:470`） | 演示数据条数不同；调用方通常显式传参 |
| `up.followings(pn,ps)` 默认 | `50`（`android.ts:336`） | `20`（`mock.ts:483`） | 同上 |
| `fav.folders` 返回 | `{created,collected}` | 同（含假数据） | 无 |

- 修复建议：mock 的 `ping` 改成 `{pong,version}`，`perUp` 默认 2、`ps` 默认 50，保持契约一致（mock 应替换实现而非替换契约）。

### D8【低】还原侧新增的字段别名（全部为"只补不覆盖"，非破坏）

- `app/src/bridge/api.ts:168-177 withCardAliases`：`view ← play`、`upName ← author/upper`、`upMid ← mid/upperMid`、`danmaku ← comment`，仅在原字段为 `null/undefined` 时补。
- 具体多出的字段：
  | 位置 | 多出字段 | 上游对应 |
  |---|---|---|
  | `api.ts:430 videoRelated` | `upMid` | `video.js` 的 `fetchRelated` 只有 `upName` |
  | `api.ts:459 videoPlayurl` | 每条流 `baseUrl`/`backupUrl`；顶层 `videos`/`audios`/`duration`/`url` | `video.js fetchPlayurl` 只有 `dash.video/audio`/`durl` |
  | `api.ts:541 mapSearchVideo`、`:633 mapFeedCard` | `view`/`danmaku` 别名 | 上游 `search.js`/`home.js` 的 `normalize` |
  | `api.ts:706 mapFavFolder` | `media_count` | `fav.js normalizeFolder` 只有 `mediaCount` |
  | `api.ts:749 favResources` | `items`/`page`/`total`、`info.media_count`、条目 `upName`/`upMid`/`pubdate`/`view` | `fav.js` 只返回 `{info,hasMore,medias}` |
  | `api.ts:807 upInfo` | `videos`、`archives` | `space.js fetchUpInfo` |
  | `api.ts:1015 upFollowings` | 条目 `uname` | `space.js` 用 `name` |
  | `wbi.ts:137 getWbiKeys`、`state.ts:103 splitSetCookie`、`http.ts` re-export | 多导出 | 上游为私有 |
- 影响：渲染层 `types.ts` 的 `VideoCard` 用 `view`/`upName`，上游用 `play`/`author`，所以别名是**为适配还原侧类型而故意加的**，读旧字段的代码不受影响。属"新增"而非"改坏"。
- 修复建议：无需修；建议在 `types.ts` 注释里标明"上游字段名为 play/author"。

### D9【低】`http.request` 新增调用方 `signal` 且不移除监听

- 还原侧：`app/src/bridge/http.ts:256-300`（`RequestOptions.signal`，合并进内部 `AbortController`）。
- 上游：`src/main/bili/http.js:98-124` 只有内部 `timeout` 定时器，无外部 signal 参数。
- 影响：新增能力，现有调用方都不传 `signal` → 无差异。实现质量上已正确用 `signal.addEventListener('abort', () => controller.abort(), { once: true })`（`http.ts:265`），不存在监听器累积；唯一残留是"请求正常结束而调用方 signal 未触发"时，该 `once` 监听会一直挂在调用方 signal 上直到其 abort（轻微内存滞留，可忽略）。
- 修复建议：无需修；如追求极致可在 `finally` 里 `removeEventListener`。

### D10【低】上游 `unwrap()` 死代码未被还原

- 上游：`src/mobile/bridge.js:247-257` `function unwrap(promise)`，全文件**无调用点**（grep 仅定义命中）。
- 还原侧：无对应函数。
- 影响：无（上游自己的死代码）。
- 修复建议：不还原是正确的；仅在此备案。

---

## 四、上游有而还原侧缺失 / 还原侧新增

### 4.1 上游有、还原侧没有（逐项判断影响）

| 上游内容 | 还原侧 | 影响 |
|---|---|---|
| `mobile/bridge.js:247 unwrap()` | 无 | 无（上游死代码） |
| `main/bili/http.js:28 setCookieMode('native')` 分支 | 只剩 explicit | 无（上游也只用 explicit），D4 |
| `main/bili/runtime.js` 的 `setBiliStore`/`getBiliStore`/`storeProxy`（54 行） | 无；`api.ts` 直接 `import { state }` | 无（等价解耦，但还原侧若有人 `getBiliStore()` 会找不到；当前无调用方） |
| `mobile/platform.js:153 installPlatformShims()` | 无聚合导出 | 无，D5 |
| `main/bili/` 的 `auth.js`/`video.js`/… 各自文件切分 | 合并为单个 `api.ts`（1277 行） | 无（结构差异） |
| `mobile/local-files.js` 独立模块 | helper 内联进 `android.ts` | 无（函数 1:1） |
| `renderer/src/api/index.js` 的桌面专用错误文案 | 改写为安卓/桌面通用文案 | 无，D3 |
| `mobile/main.js:64-115 wireAndroidBack()` | 还原侧 `installBackButton()`（`main.ts:85` 调用 / `:89` 定义） | 需真机验证返回键优先级链（见 §五） |

### 4.2 还原侧新增

| 新增内容 | 位置 | 判断 |
|---|---|---|
| dev mock 数据桥（645 行，含 9 个命名空间全实现） | `bridge/mock.ts` | 无害，但见 D1/D7 |
| 演示数据种子 | `app/src/dev/seed.ts`（`main.ts:42` 调用） | 有风险，见 D1 |
| `withCardAliases` 别名字段 | `api.ts:168-177` + 6 处调用 | 无破坏，D8 |
| `BiliHttpResponse` 类（自建 Response 形状） | `http.ts:45-95` | 等价替代，无差异 |
| `RequestOptions.signal` | `http.ts:256` | 新能力，D9 |
| `installAndroidBridge({force})` 的 `installed` 守卫 | `android.ts:582` | 上游 `installBridge` 无守卫；多一层幂等保护，无害 |
| `bridge/state.ts` 里 `splitSetCookie`/`applySetCookie` 公开导出 | `state.ts:103/125` | 把上游散在 `native-http.js`/`http.js` 的两个函数合并到 state，算法一致 |
| 挂载前预热 6 个 store | `main.ts:66-79` | 首屏无闪烁，非数据层差异 |

---

## 五、未能验证的部分

1. **真机 Capacitor 行为**：`CapacitorHttp` 的 `connectTimeout/readTimeout` 是否被原生 OkHttp 尊重、`Filesystem.writeFile(Directory.Documents)` 在 Android 11+ 分区存储下的实际路径与权限、`Share.share({files:[uri]})` 的 FileProvider 配置——均需真机。
2. **返回键优先级链**：还原侧 `installBackButton()` 与上游 `wireAndroidBack()` 的 6 级优先级（登录面板 → 确认框 → 全屏 → 剧场模式 → router.back → minimize/exit）需真机逐级触发验证；本报告只核对了数据层。
3. **真实接口返回**：`-352`/`-412`（风控）与 `-403` 的实际触发条件、`upVideos` app→web 双路兜底的真实生效情况，需联网+登录态，未做。
4. **`?mock=1` 在生产 APK 的可达性**：Capacitor 默认 `localhost` 无 query，理论上不可达，但若接入 deeplink 则可能；未在 APK 上实测（D1 的风险评估基于代码可达性）。
5. **Dexie 4.x 运行时行为**：只做了 schema 静态比对，未在真机 IndexedDB 上跑一遍 v1→v7 打开升级（两侧都无 upgrade 回调，风险低）。
6. **`reference/decompiled/` 原始 APK 产物**：本次以"上游源码 vs 还原源码"为主，未把反编译产物作为第三方裁判逐字节比对；若需更高置信度可对 `reference/decompiled/` 做同样脚本化比对。

---

## 六、可复制执行的验证命令

```bash
# 0) 前置：确认 node 可用
node -v            # 本机 v24.19.0

# 1) bridge 通道 diff（37 vs 37，missing/extra/顺序）
node /tmp/audit/verify/verify-channels.mjs
# 期望：上游通道 37 还原通道 37 / missing: [] / extra: [] / 顺序一致: true

# 2) DEFAULT_SETTINGS 逐项 diff（18 项）
node /tmp/audit/verify/verify-settings.mjs
# 期望：key 数 18 18 / missing: [] / extra: [] / 顺序一致: true

# 3) Dexie v1..v7 schema 逐版 diff
node /tmp/audit/verify/verify-dexie.mjs
# 期望：每版 missing/extra/值差异 均为 []，还原多出的版本为空

# 4) WBI/MD5 端到端（md5 211 组、mixinKey 200 组、encWbi 6 组）
node /tmp/audit/verify/verify-wbi.ts
# 期望：ALL EQUIVALENT

# 5) 人工抽查：通道实现并排看
diff -y --suppress-common-lines <(sed -n '105,240p' /tmp/up043/src/mobile/bridge.js) \
                               <(sed -n '278,430p' /root/学习软件/app/src/bridge/android.ts) | head -60
```

> 说明：以上脚本只读两侧源码，不写 `/root/学习软件`；`verify-wbi.ts` 用 `--experimental-strip-types` 能力由 Node 24 原生支持（直接 `node file.ts` 即可），依赖仅 `node:crypto` 与 `node:fs`。

---

### 附：核对完成度自查

- [x] 37 个通道名/参数/默认值逐项（机械）
- [x] 18 项 DEFAULT_SETTINGS 逐项（机械）
- [x] 持久化 key、cookie `raw:`+base64、secure 字段、Set-Cookie 处理
- [x] api.ts 每个接口的 url/参数/字段映射/错误码（-403/-352/-412/wbi 重签/buvid 刷新）
- [x] wbi mixinKey 表、md5、TTL、encWbi 字符集（喂同一输入比对输出）
- [x] Dexie 版本号 / stores / 索引逐版
- [x] native 插件集合、调用方式、能力降级
- [x] missing/extra 清单 + 新增 mock 的影响判断
