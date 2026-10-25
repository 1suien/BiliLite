# 05 · 数据桥 API 清单（`window.bili`）

渲染层唯一的数据来源是全局对象 `window.bili`。它的类型定义在 `app/src/bridge/types.ts`（`WbiBridge`），安卓实现在 `app/src/bridge/android.ts`，桌面端由 Electron 注入，本工程的浏览器 mock 实现在 `app/src/bridge/mock.ts`。

```ts
// 任何视图里
import { bili } from '@/bridge'
const detail = await bili.video.view('BV1xx411c7mD')
```

`bridge/index.ts` 是个**延迟代理**：模块加载时不碰 `window.bili`，第一次访问方法时才取；没有桥时抛出可读错误：

> 未检测到桌面端桥接（window.bili）。请通过 Electron 启动，而不是直接用浏览器打开。

## 调用协议

所有方法最终都走安卓桥的 `invoke(channel, args)`：

```ts
// 成功
{ ok: true, data: ... }
// 失败
{ ok: false, message: string, code?: number, needLogin?: boolean }
```

`android.ts` 里的 `call()` 会取 `data`，失败时按 `needLogin`/`biliCode` 抛 `Error`（`message` 就是原文案），所以视图里 `try/catch` + `err.message` 就能显示「需要先扫码登录」之类的提示。

**37 个通道**（与原产物 `hr` handler map 一一对应，missing/extra 都为空）：

| 通道 | `window.bili` 方法 | 上游接口 | 说明 |
|---|---|---|---|
| `app:ping` | `ping()` | — | 返回 `{platform, version}`；version 来自 `@capacitor/app` 的 `getInfo()`，失败回落 `'0.4.1'` |
| `auth:restore` | `auth.restore()` | `/x/web-interface/nav` | 读 Preferences 里的 Cookie 验证登录；失败重试一次（600ms），仍失败标 `stale`；游客则 `clearAuth` |
| `auth:qrGenerate` | `auth.qrGenerate()` | `passport…/qrcode/generate` | 返回 `{url, qrcodeKey}` |
| `auth:qrPoll` | `auth.qrPoll(key)` | `passport…/qrcode/poll` | `waiting/scanned/expired/success`；success 从返回 URL 的 query 提 Cookie |
| `auth:logout` | `auth.logout()` | `passport…/login/exit/v2` | 清 Cookie + 用户 + 持久化 |
| `home:feed` | `home.feed(page?)` | `/x/web-interface/wbi/index/top/feed/rcmd` | 推荐流（**0.4.3 没有视图调用**，通道保留） |
| `home:popular` | `home.popular(page?)` | `/x/web-interface/popular`（失败降级 `/x/web-interface/ranking/v2`） | 同上 |
| `search:videos` | `search.videos(kw, page?, order?)` | `/x/web-interface/wbi/search/type?search_type=video` | WBI 签名 |
| `search:ups` | `search.ups(kw, page?)` | 同上 `search_type=bili_user` | |
| `video:view` | `video.view(bvid)` | `/x/web-interface/view` | 详情 + 分P + UP + 简介 |
| `video:pages` | `video.pages(bvid)` | `/x/player/pagelist` | 分P 列表 |
| `video:playurl` | `video.playurl(bvid, cid, qn)` | `/x/player/wbi/playurl`（`fnval=4048`） | 返回 DASH（`videos/audios/durl`）或 durl；清晰度不足时降级 |
| `video:related` | `video.related(bvid)` | `/x/web-interface/archive/related` | 相关推荐 |
| `video:danmaku` | `video.danmaku(cid, segment?)` | `/x/v1/dm/list.so?oid=&type=1&segment_index=`，失败再试 `comment.bilibili.com/{cid}.xml` | 解析 XML、过滤、按时间排序；抛最后一个 URL 的错误 |
| `video:sendDanmaku` | `video.sendDanmaku(payload)` | `/x/v2/dm/post`（表单 POST） | 未登录/-101/-400 → `needLogin`；文案「发送弹幕需要先登录」「弹幕最多 100 个字」 |
| `video:online` | `video.online(bvid, cid)` | `/x/player/online/total` | 在线人数 |
| `video:subtitle` | `video.subtitle(bvid, cid)` | `/x/player/wbi/v2` + `/x/player/v2` | 字幕轨道列表（最多 5 条，静默跳过坏轨道） |
| `up:info` | `up.info(mid)` | `/x/web-interface/card` | UP 资料（含 `videos/archives` 别名） |
| `up:videos` | `up.videos(mid, pn?, keyword?)` | `/x/space/wbi/arc/search`（失败降级 `app.bilibili.com/x/v2/space/archive`） | WBI 签名，失败重试 |
| `up:resolve` | `up.resolve(query)` | card / space 搜索 | 支持 UID、空间链接、昵称；文案「请输入 UP 主的 UID、空间主页链接或昵称」「没有找到这个 UP 主，换个 UID 或昵称试试」 |
| `up:latest` | `up.latest(mids, perUp=1)` | 逐个 `space/wbi/arc/search` | 去重后 `slice(60)`、`perUp` clamp 1…12、并发 4、按 pubdate 降序、5 分钟缓存、`errors[]` 收集失败项 |
| `up:followings` | `up.followings(pn?, ps?)` | `/x/relation/followings` | 导入关注（最多 6 页×50）；未登录文案「需要先扫码登录才能导入 B 站关注列表」 |
| `fav:folders` | `fav.folders()` | `/x/v3/fav/folder/created/list-all` + `collected/list` | 返回 `{created, collected}`；未登录文案「请先扫码登录后再使用收藏功能」 |
| `fav:resources` | `fav.resources(mediaId, pn?)` | `/x/v3/fav/resource/list` | 返回 `{info, medias, hasMore, items, page, total}` |
| `settings:get` | `settings.get()` | — | 返回持久化设置（Preferences） |
| `settings:patch` | `settings.patch(patch)` | — | 浅合并 + 持久化，返回新设置 |
| `sys:openExternal` | `sys.openExternal(url)` | — | `App.openUrl` / 系统浏览器 |
| `sys:pickFile` | `sys.pickFile()` | — | `<input type=file>` 包装，返回 `{entries,canceled}` |
| `sys:pickSubtitle` | `sys.pickSubtitle()` | — | 选字幕文件（`.srt/.ass/.vtt/.json`），返回路径数组 |
| `sys:readSubtitle` | `sys.readSubtitle(path)` | — | 读字幕文本（UTF-8 → GBK 兜底），返回 `{path,name,size,bytes}`；失效文案「字幕文件已失效，请重新选择」 |
| `sys:revealPath` | `sys.revealPath(path)` | — | 安卓无「资源管理器定位」，改为再次弹分享面板 |
| `sys:pathForFile` | `sys.pathForFile(file?)` | — | 永远返回 `''`（原实现如此） |
| `backup:write` | `backup.write(dir, name, text)` | — | Documents 失败降级 Cache，再分享；「还没有导出过备份；先点『写入 JSON 备份』」 |
| `local:pickFiles` | `local.pickFiles()` | — | 选视频文件，扩展名过滤 + 中文排序 |
| `local:pickFolder` | `local.pickFolder()` | — | 选目录（`webkitdirectory`） |
| `local:register` | `local.register(paths)` | — | 伪路径 → blob URL；返回 `{entries, missing}` |
| `local:remove` | `local.remove(id)` | — | 从内存/本地表移除 |
| `local:reveal` | `local.reveal(path)` | — | 永远抛错（「安卓上没有『在资源管理器里定位』，去系统『文件』应用里找这个文件」） |

## WBI 签名（`bridge/wbi.ts`）

B 站 2023 年后对多数 web 接口要求 `w_rid` + `wts` 签名：

1. `GET /x/web-interface/nav` 取 `data.wbi_img.img_url/sub_url` → 截出 `imgKey`/`subKey`；
2. 用固定的 64 位重排表（原产物里的数组 `ln`）拼出 `mixinKey`；
3. 参数按 key 字典序排序 → 拼接 → 去掉 `!'()*` → 追加 `wts` → `md5(query + mixinKey)` = `w_rid`；
4. 结果缓存 **30 分钟**；接口返回 `-403` 时 `clearWbiCache()` 后重签重试；
5. 所有实现（手写 MD5、字符编码）都与 Node `crypto` 对照过 9 组用例，结果全等。

## HTTP 层（`bridge/http.ts`）

- 用 **CapacitorHttp**（原生 OkHttp）而不是 webview 的 `fetch`：绕开 CORS，能带自定义 Cookie、能设超时；
- `BiliHttpResponse` 模拟 `Response`（`status/ok/url/headers.get/has/getSetCookie/text()/json()`）；
- `createNativeFetch()` 造 fetch 兼容函数；`request(url, init)` 默认 **15 秒**超时，支持 `AbortSignal`（弹幕批量取消用）；
- `getData(res)`：校验 `code === 0` 返回 `data`，否则抛 `biliError`（带 `code`）；
- 请求头带移动端 UA 与 `Referer: https://app.bilibili.com/`。

## Cookie 与登录态（`bridge/state.ts`）

- Cookie 存 Preferences 的 `bililite.state.v1`，值用 `"raw:"+btoa()` 编码；
- `splitSetCookie()` / `applySetCookie()` 处理 `Set-Cookie` 多值与属性（Path/Domain/Expires/Max-Age/Secure/HttpOnly）；
- 二维码登录成功时从 poll 返回的 `url` 查询串里提取 `DedeUserID`、`DedeUserID__ckMd5`、`SESSDATA`、`bili_jct`，写入 cookies 后 `setUser()`；
- 发弹幕等写操作需要 `bili_jct`（CSRF token）。

## 字段双写约定

原产物的桥和渲染层对同一字段有**两套命名**（历史遗留）。为了兼容两种读法，`api.ts` 同时输出两套（各 1–2 行赋值）：

| 原 chunk 字段 | types.ts 字段 | 出现在 |
|---|---|---|
| `view` | `play` | 视频卡/收藏条目 |
| `uname` | `name` | UP 资料 |
| `videos` | `archives` | UP 卡片 |
| `media_count` | `mediaCount` | 收藏夹 |
| `url` | `baseUrl` | DASH 音/视频轨 |
| `upper/upperMid` | `upName/upMid` | 收藏条目 |
| `pubtime` | `pubdate` | 收藏条目 |

## mock 桥（`bridge/mock.ts`，645 行）覆盖了什么

为了让页面在浏览器里能渲染，mock 实现了**同样的全部方法**，但数据全在内存：

- 首页/搜索/UP/收藏夹都有固定的假视频与假 UP（`BV1mock0001…`）；
- 视频详情/分P/playurl/相关推荐/在线人数/字幕轨道都有假数据（`playurl` 返回 `mock://video/1080p` 假地址）；
- 登录二维码用定时器模拟 `waiting → scanned → success`；
- 设置读写走内存 + localStorage，备份返回假路径；
- 文件选择返回 `/mock/课程视频/*.mp4`；
- 图片用 `cover(text, hue)` 现场生成 SVG data URL（不依赖外网）。

新增一个通道的步骤：`types.ts` 加方法 → `android.ts` 在 handler map 里加 `'domain:action'` → `api.ts` 实现请求 → `mock.ts` 补假实现（可选，为了能在浏览器里看效果）。

## CSP 提醒

`app/index.html` 保留原 APK 的 CSP，其中有 `connect-src 'self' http: https: ws: wss:`、`media-src 'self' blob: https:`。所以 mock 的 `mock://` 协议媒体会被拦——这是预期行为，不是 bug；真实运行时桥返回的是 `https:` 的 B 站 CDN 地址。
