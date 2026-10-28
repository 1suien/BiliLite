# 28 本机工具：把 WPS 云盘里的视频弄到平板上播

> 这是**本机辅助脚本**，不随 APK 分发，也不改 App 代码。
>
> 起因：用户问「能不能播放 WPS 网盘里的视频」。结论是**不能直接播**——WPS 云盘的文件没有公开直链，网页端也要登录态；App 里没有（也不该有）你的 WPS 账号。所以做了个本机工具：在电脑上扫码登录 WPS，把云盘里的视频下载到本机，再通过已有的 `/dl/…` 下载路由给平板，最后用 App 的「本地 → 本地导入」播放。

## 1. 为什么不能「直接在 App 里看云盘」

| 方案 | 结果 |
|---|---|
| 把云盘文件当在线地址播放 | ❌ 云盘只给分享链接（网页、要登录、会过期），没有直链 |
| App 内直连 WPS 云盘 API | ❌ 需要你的账号登录态；WPS 开放平台要开发者账号 + 服务商资质 + 应用审核，APPKEY 还得放服务端 |
| 本机工具 + 扫码登录 + 下载 | ✅ 本文这套（只读你的云盘列表/下载，不动文件） |
| 平板 WPS 里「下载」到本地再 App 里「本地导入」 | ✅ 最稳的备用（不需要电脑，但要手动逐个下载） |

## 2. 工作流程

```
电脑（本机）                      平板
┌──────────────────────┐        ┌──────────────────────┐
│ tools/wps/login.mjs  │        │ 浏览器打开 /dl/…      │
│  ↓ 手机微信扫码       │        │  ↓ 下载 mp4          │
│ tools/wps/list.mjs   │        │ BiliLite「本地 →      │
│  ↓ 列出云盘视频       │        │  本地导入」→ 播放     │
│ tools/wps/download.mjs│  ───▶  │                      │
│  ↓ 存到 .work/wps-dl │  局域网 │                      │
│ 静态路由 /dl/ 提供     │        │                      │
└──────────────────────┘        └──────────────────────┘
```

## 3. 用法

### 3.1 登录（一次，之后复用）

```bash
node tools/wps/login.mjs          # 默认等 20 分钟
node tools/wps/login.mjs 360      # 也可以等 6 小时，慢慢扫
```

脚本会在仓库根不断刷新 `wps-login-qr.jpg`（用手机微信「扫一扫」扫它 → 金山办公小程序里点允许）。
登录成功后把浏览器登录态写进 `tools/wps/state.json`（**已在 .gitignore，不会入库**）。

### 3.2 列云盘里的视频

```bash
node tools/wps/list.mjs
```

输出：
- `.work/wps-videos.json`：全部视频/音频条目（id、名字、路径、大小、时间）
- `wps-videos.html`：按目录分组的清单页，平板上打开 `http://127.0.0.1:3080/dl/wps-videos.html`

### 3.3 下载到本机

```bash
node tools/wps/download.mjs --match 新概念          # 名字/路径里含关键字的
node tools/wps/download.mjs --dir 新概念/英语语法   # 按目录前缀
node tools/wps/download.mjs --ids 574502907669     # 按文件 id（清单 json 里）#
node tools/wps/download.mjs --limit 3 --match 新概念 # 只下前 3 个
```

- 存到 `.work/wps-dl/<云盘目录>/<文件名>`（同名同大小会跳过，断点用 `.part` 续传）
- 下完打印 `/dl/.work/wps-dl/…` 链接，平板浏览器打开即可下载
- 同时会刷新 `wps-videos.html`，已下载的行会多一个「下载到平板」按钮

### 3.4 平板播放

1. 平板浏览器打开取件链接（或 `/dl/wps-videos.html` 点按钮）→ 下载 mp4
2. App →「本地」→「本地导入」→ 选刚下载的文件（App 会复制进私有目录，之后刷新/重启都还在）
3. 播放

## 4. 关键接口（实现说明，便于以后维护）

| 用途 | 请求 |
|---|---|
| 列目录 | `GET https://drive.kdocs.cn/api/v5/groups/2194913070/files?parentid=<id>&offset=0&count=500`，需 `referer: https://www.kdocs.cn/` |
| 取下载直链 | `GET https://drive.kdocs.cn/api/v5/groups/2194913070/files/<fileid>/download?support_checksums=md5` → `{url}`（签名 URL，约十几分钟过期） |
| 下载 | 对签名 URL 发 GET（支持 Range，可续传） |

- `2194913070` 是「我的云文档」个人空间 groupid，根目录 `parentid=0`
- **必须先访问一次 `https://drive.wps.cn/`**（触发 SSO 刷新 cookie），否则直接调 API 会 `403 userNotLogin`
- 登录判定看 cookie `wps_sid`（不能用 `csrf`，未登录时也有）

## 5. 已知限制

- **签名 URL 约十几分钟过期**：下载脚本是「先取直链再立刻下」，长时间暂停后恢复要重新取直链（脚本每次都会重新取，所以没问题）
- 大文件占本机磁盘（云盘里视频合计可能上百 GB），建议按课程/目录分批下载
- 只读：工具只调用「列表 / 下载」两个接口，不会删除或修改云盘文件
- 登录态会过期（几天到几周），过期后重跑 `login.mjs`
- 部分文件是 WPS 专有格式（如 `.kdocs` 文档），不是视频，不在清单里
- WPS 有风控，脚本已按「低频请求 + 复用登录态」实现，不要高频轮询
- 浏览器端清单页含你的文件名，所以 `.gitignore` 里排除了 `wps-videos.html`
