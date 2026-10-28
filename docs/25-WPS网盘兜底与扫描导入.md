# 25 本机构建 0.4.18 —— WPS 网盘分享不了时的兜底：扫描本机视频再导入

> 这是**本仓库自己的定制改动**，上游（官方 BiliLite）没有。改动后重新出了 APK：`BiliLite-0.4.18-debug.apk`（versionCode 22 / versionName 0.4.18）。

## 1. 用户报告

- 「你能读取云盘内容吗」→ 我不能：没有你平板/云盘账号的登录态，WPS 开放平台又需要开发者账号 + 服务商资质 + 服务端保存 APPKEY，个人做不了。
- 「**无法 WPS 网盘分享**」→ WPS 网盘里的**云文件**在多数版本里只能「分享链接」，没有「分享文件 / 用其他应用打开」，所以 0.4.15 做的「分享到 BiliLite 直接播放」这条路对 WPS 云文件用不上。

结论：**WPS 网盘没有公开直链，分享出来的是网页链接，播放器读不了**。能走通的只有两步：

1. 在 WPS 里把视频**下载到平板**（WPS 打开该视频 → 右上「…」→「下载」/「保存到本地」）；
2. 回到 BiliLite，把这些视频导入进来播放。

这次就是把第 2 步做到「不用文件选择器也能进」——新增「扫描本机视频」，扫完勾选即可。

## 2. 改动

### 2.1 原生侧（`app/android/app/src/main/java/com/bililite/app/LocalMediaPlugin.java`）

| 改动 | 说明 |
|---|---|
| 权限声明 | `@CapacitorPlugin(name="LocalMedia", permissions={@Permission(alias="videos", strings={READ_MEDIA_VIDEO}), @Permission(alias="storage", strings={READ_EXTERNAL_STORAGE})})`，Android 13+ 用 `videos`，更早的用 `storage` |
| `scanVideos` | 先检查/申请读媒体权限（`requestPermissionForAlias` + `@PermissionCallback scanPermissionResult`），再查 `MediaStore.Video`：`_ID / DISPLAY_NAME / SIZE / DATE_MODIFIED / DURATION / MIME_TYPE` + `RELATIVE_PATH`（Android 10+）或 `DATA`，按修改时间倒序，默认最多 200 条（JS 传 300） |
| `importSelected` | 接 `uris: string[]`（`content://media/...`），复用原来的 `copyToMedia` 复制进 `files/local-media/`，返回条目 |
| 分享过滤 | `sharedPending` 只接收音视频（按 mime 或扩展名 `MEDIA_EXTS`），其他进 `skipped` 列表，不再整批失败 |
| 条目字段 | `{id, path, name, dir, ext, size, mtime, duration?, mime, url: https://localhost/_capacitor_file_…, native:true}` |

### 2.2 分享入口放宽（`app/android/app/src/main/AndroidManifest.xml`）

- 新增权限：`READ_MEDIA_VIDEO`、`READ_EXTERNAL_STORAGE`（`maxSdkVersion="32"`）；
- `ACTION_SEND` / `ACTION_SEND_MULTIPLE` 的 mime 增加 `application/octet-stream`——有的 App（含 WPS 部分版本）分享文件时给的是通用类型，不加这一条 BiliLite 不会出现在分享列表里。

### 2.3 JS 侧

| 文件 | 改动 |
|---|---|
| `app/src/bridge/android.ts` | 新增 handler `'local:scanVideos'`、`'local:importSelected'`；`bili.local.scanVideos(limit?)`、`bili.local.importSelected(uris)` |
| `app/src/bridge/types.ts` | `scanVideos?(limit?): Promise<{items, count}>`、`importSelected?(uris): Promise<LocalPickResult & {skipped?}>` |
| `app/src/bridge/mock.ts` | 浏览器预览返回 4 条假视频，`importSelected` 返回等量条目 |
| `app/src/bridge/index.ts` | 代理透传（无原生实现时返回空列表 / 回退 `pickFiles`） |
| `app/src/views/LocalView.vue` | 页头与空态新增「扫描本机视频」；弹层 `.scan-mask > .scan-box`：标题「扫描到 N 个本机视频」+ 全选 + 每项 name/大小/时长/目录 + 「导入选中 N 个」；导入后整表刷新并提示；非音视频提示「有 N 个文件不是视频/音频，已跳过」；扫描失败（没给权限等）只弹提示不崩 |

## 3. 使用步骤

1. 在 WPS 里打开网盘视频 → 右上「…」→「下载」（下载到平板的 `Download/` 或 `Movies/`，具体看 WPS 版本）；
2. 打开 BiliLite →「本地」→ 右上「**扫描本机视频**」；
3. 在列表里勾选（可全选）→「导入选中 N 个」；
4. 导入的文件会**复制进 App 私有目录**（`files/local-media/`），之后刷新、重启都在，播放走 Capacitor 本地服务（支持 Range，边下边播，不吃内存）；
5. 想删掉：列表里点垃圾桶，会同时删掉 App 私有目录里的那份文件。

> 如果 WPS 里下载完在扫描列表里找不到：多半是 WPS 存进了自己的私有目录（其它 App 读不到）。这时去 WPS 里「另存到 / 导出到本地文件」到 `Download`，或者直接用「打开文件」从系统选择器里选。

## 4. 验证

新增 `tools/browser/check-local18.mjs`（端口 4224、`CHECK_LOCAL18_OUT`）：**9/9 通过**

```
PASS  本地页有「扫描本机视频」入口
PASS  弹层列出扫描到的视频 — 4 条 · 扫描到 4 个本机视频 …
PASS  「全选」后显示已选 4 个
PASS  导入选中后写入 4 条本地视频 — 行数=4
PASS  导入后弹层关闭
PASS  页面提示已加入 4 个
PASS  非音视频文件提示「已跳过」
PASS  扫描失败时只提示错误、页面不崩
PASS  无真实 console error / pageerror
```

旧验收脚本全部回归通过：`check-mini` 17/17、`check-notes` 9/9、`check-backup` 10/10、`check-automini` 18/18、`check-nohome` 10/10、`check-focusdefaults` 11/11、`check-resume` 9/9、`check-schedule` 29/29、`check-reminder13` 16/16、`check-habitnote` 19/19、`check-local15` 8/8、`check-local16` 5/5、`check-local17` 9/9。

截图：`reference/screenshots/本地-扫描本机视频.png`、`reference/screenshots/本地-扫描导入完成.png`。

## 5. 产物

| 项目 | 值 |
|---|---|
| 文件 | `BiliLite-0.4.18-debug.apk` |
| 大小 | 4,158,190 B |
| SHA-256 | `7128c340290656cf53894fe470be7c9d9676dcb3e18624c88f38630822370f0a` |
| versionCode / versionName | `22` / `0.4.18` |
| minSdk / targetSdk / compileSdk | 22 / 34 / 34 |
| 签名 | debug，v1 + v2 通过（v3 false） |
| 构建 | `clean assembleDebug` 33s；再跑一次 clean 27s，两次 sha256 完全相同（可复现） |
| 下载 | `http://127.0.0.1:3080/dl/BiliLite-0.4.18-debug.apk`（固定名 `…/dl/BiliLite-latest.apk`） |
| 包内容校验 | badging versionCode 22 / 0.4.18 / 22 / 34；`zipalign -c -p 4` 通过；权限含 `READ_MEDIA_VIDEO`、`READ_EXTERNAL_STORAGE(maxSdk=32)`、`POST_NOTIFICATIONS` 等；dex 里有 `scanVideos/importSelected`；`LocalView-*.js` 含「扫描本机视频」（2 处） |

## 6. 升级 / 兼容

- 与 0.4.4–0.4.17 同为 debug 签名，**可直接覆盖升级**；装过官方版需先卸载（签名不同）。
- 旧的本地记录（伪路径 `android://…`）仍保留，但那些文件在打开 App 后可能已失效（会显示「文件不在了」）；重新用「扫描本机视频」或「打开文件」导入一次即可，播放进度按文件名/大小复用。

## 7. 限制 / 未验证

- 扫描依赖系统 `MediaStore`：**只列已经下载到本机、且被媒体库收录的视频**；WPS 还没下载的云文件不会出现，WPS 存进私有目录的也扫不到（需另存到 `Download`）。
- 读媒体权限被拒时扫描直接报错，需要去系统设置里给 BiliLite 开「照片和视频/文件」权限。
- 分享入口放宽后，别的 App 分享 `application/octet-stream` 文件时 BiliLite 也会出现在列表里；非音视频会被跳过并提示。
- 复制会占平板空间（一份副本）；卸载 App 会一起删掉。
- **真机未实测**：MediaStore 权限弹窗、WPS 下载后的实际目录、大文件（1GB+）复制耗时、`content://` 复制进度提示（目前是同步复制，界面会转圈到完成）。

## 8. 如果还想「直接在 App 里浏览网盘」

WPS 网盘没有 WebDAV / 公开 API（开放平台要服务商资质），所以做不到。可行替代：**支持 WebDAV 的网盘**（坚果云、群晖/NAS、Nextcloud 等）——如果你有这类盘，下一版可以在 App 里加一个「网络盘」页：填服务器地址 + 账号（只存本机），列目录、点视频边下边播、记住进度。需要的话告诉我用的是哪种盘。
