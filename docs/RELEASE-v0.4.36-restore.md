本机构建 BiliLite 0.4.36（debug 签名，可直接覆盖安装，数据保留）。

- 产物：`BiliLite-0.4.36-debug.apk`（4,171,055 B，sha256 `b08fff5ee3ceb708291a7f2287a3c97759329c30a867f1dd8b2d87fe7dbb8161`）
- 源码：分支 `restore/android-0.4.3`，提交见本页顶部
- 主要改动：播放页新增「评论」tab（只读）——热门/最新排序、每页 20 条加载更多、楼中楼展开、UP 主标、相对时间与点赞数；未登录可用（WBI 签名）。详见 [docs/43](https://github.com/1suien/BiliLite/blob/restore/android-0.4.3/docs/43-评论区.md)
- 顺带保留：0.4.35 的跳转定位修复（`segment_base` 精确续流）、0.4.34 的横滑调进度/跳转防抖、0.4.33 的线路自动重试、0.4.32 的起播优化

安装：下载 APK → 允许「安装未知应用」→ 点开安装。
