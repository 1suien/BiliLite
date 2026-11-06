本机构建 BiliLite 0.4.38（debug 签名，可直接覆盖安装，数据保留）。

- 产物：`BiliLite-0.4.38-debug.apk`（4,172,466 B，sha256 `258c216b39cca8c4baf9d0f14f0b4072b966be98f5079687fd023fd2a783d8a4`）
- 源码：分支 `restore/android-0.4.3`
- 主要改动：评论区支持**回复与发表**——评论 tab 顶部输入框（Ctrl+Enter 发表、1000 字上限），主评论与楼中楼每条都能「回复」（自动带 `回复 @某人 :` 前缀），未登录会提示扫码登录，发表成功自动切到「最新」刷新
- 接口：`POST /x/v2/reply/add`（csrf = cookie `bili_jct`；回复带 `root`/`parent`）
- 同版本包含：0.4.36 评论区（只读）+ 0.4.37 头像修复

安装：下载 APK → 允许「安装未知应用」→ 点开安装。
