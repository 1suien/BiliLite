# BiliLite 0.4.9（本机构建）—— 还原工程 + 可安装 APK

> 由 [BiliLite 0.4.3 前端源码还原工程](https://github.com/1suien/BiliLite/tree/restore/android-0.4.3) 构建的 Android debug APK。
> 上游 0.4.4 的改动（剧场模式「退出剧场」竖白条修复）已同步；0.4.5–0.4.9 是本仓库自己的定制，上游没有。

## 这一版（0.4.9）改了什么

**删除「首页」**（按用户要求彻底删除）：

- 左侧导航的「首页」条目、`/` 路由、`views/HomeView.vue`（219 行）全部删除；
- 打开 App 直接进「学习」页；`#/`、旧地址 `#/home` 都会自动落到 `#/learn`；
- 连带文案：「回首页」→「回学习」、「去首页找视频」→「去搜索找视频」、UP 管理相关文案去掉「首页会显示…」；
- 首页原来的「继续学习 / 关注 UP 更新」入口随之消失（UP 名单仍保留、仍能管理，只是不再有页面消费它）。

无头 Chromium 端到端验收 `check-nohome.mjs` **10/10 通过**；`check-mini` 17/17、`check-notes` 9/9、`check-backup` 10/10、`check-automini` 18/18 回归全过。详见仓库 `docs/16-删除首页.md`。

## 之前版本的定制（都包含在这一版里）

| 版本 | 改动 | 文档 |
|---|---|---|
| 0.4.8 | 播放中离开播放页（点导航/返回等任何页面切换）→ 视频自动缩成右下角 112×112 圆形小窗并**暂停**；点小圆回播放页从暂停处**自动继续播** | `docs/15-离开播放页自动暂停小窗.md` |
| 0.4.7 | 笔记行去掉「▶ 跳转」、删除按钮挪到最右；「小窗播放」改圆形入口，播放中的视频是右下角圆形气泡（实时画面 + 进度环 + 时间，可拖动、跨页面常驻） | `docs/14-小窗圆形气泡与笔记行按钮.md` |
| 0.4.6 | 安卓上隐藏名不副实的「备份目录 → 打开」（实际弹的是系统「保存到…」），改「备份位置」说明；新增「恢复学习数据 → 打开 JSON 备份…」，与现有数据**合并**恢复 | `docs/13-备份打开与导入恢复.md` |
| 0.4.5 | 视频笔记**按分P独立**（`bvid + cid`）；笔记输入框改多行 textarea，**回车换行**、`Ctrl+Enter` 或「保存」写入 | `docs/12-笔记按分P独立.md` |
| 0.4.4 | 同步官方 0.4.4：安卓剧场模式「退出剧场」被拉成竖白条修复 + 3 处版本号 | `docs/11-0.4.4同步记录.md` |

## 资产

| 项目 | 值 |
|---|---|
| 文件 | `BiliLite-0.4.9-debug.apk` |
| 大小 | 4,105,445 B |
| SHA-256 | `37e15de561925ca4ab53c643d456f9a2017e4a4c27af21ed0dd07db93fec0c3f` |
| package | `com.bililite.app` |
| versionCode / versionName | `13` / `0.4.9` |
| minSdk / targetSdk / compileSdk | 22 / 34 / 34 |
| 签名 | debug（CN=Android Debug），v1 + v2 |
| 构建 | Vite 7.90s + `cap sync` 0.96s + Gradle 增量 `assembleDebug` 57s / `clean assembleDebug` 54s；`clean` 重建 sha256 完全相同 |

## 安装

- 与官方 APK **包名相同、签名不同**：手机上装过官方 0.4.3/0.4.4 的需要先卸载（会清掉该应用本地数据，先导出备份）。
- 装过本仓库 0.4.3–0.4.8 的产物可以直接覆盖升级（同 debug 签名，versionCode 13 > 12 > 11 > 10 > 9 > 8 > 7）。
- 允许「安装未知来源应用」后点击 APK 安装。

## 校验

```bash
sha256sum BiliLite-0.4.9-debug.apk   # 37e15de561925ca4ab53c643d456f9a2017e4a4c27af21ed0dd07db93fec0c3f
aapt2 dump badging BiliLite-0.4.9-debug.apk | head -1   # versionCode='13' versionName='0.4.9'
apksigner verify --verbose BiliLite-0.4.9-debug.apk     # v1 true / v2 true
zipalign -c -p 4 BiliLite-0.4.9-debug.apk               # 通过
```

包内 `assets/public` 与本仓库 `app/` 的 `dist` 逐字节一致（只多 `cordova.js` / `cordova_plugins.js`）；包内没有 HomeView chunk；版本串只有 0.4.9。

## 已知限制

- 真机未实测（构建机无 Android 设备）：路由/渲染/交互在无头 Chromium + mock 数据桥下验收；
- mock 模式下播放器拉的是假媒体地址，会被原 CSP 拦住，所以浏览器里的播放页是「错误态」——真机上换真实接口即可；
- 删掉首页后，「继续学习 / 关注 UP 更新」这两个入口没有了；想要回来可以从 git 历史恢复 `HomeView.vue` 与路由。

## 免责声明

个人学习用的逆向/还原产物，不含 B 站官方代码以外的商业逻辑，也不含任何账号凭据。B 站接口、图片、名称、图标版权归哔哩哔哩及原作者所有；请勿用于分发或商业用途。
