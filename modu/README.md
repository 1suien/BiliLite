# 墨读 · Android 电子阅读器

一个完全离线的安卓阅读器：书架 + TXT / EPUB / PDF 三种阅读器 + 阅读设置 + 进度记忆。
数据全部存在本机（IndexedDB），不上传、不联网、不需要账号。

![书架](docs/screenshots/shelf.png)

| 排版阅读（TXT/EPUB） | 夜间模式 | 目录 |
| --- | --- | --- |
| ![阅读](docs/screenshots/txt-reading.png) | ![夜间](docs/screenshots/night.png) | ![目录](docs/screenshots/toc.png) |

| 阅读设置 | EPUB 图文 | PDF |
| --- | --- | --- |
| ![设置](docs/screenshots/settings.png) | ![EPUB](docs/screenshots/epub-image.png) | ![PDF](docs/screenshots/pdf.png) |

## 功能

- **书架**：导入本地书（多选）、封面、格式角标、阅读进度条、最近阅读排序；长按可「从头开始读 / 删除」。
- **TXT**：自动识别 UTF-8 / GB18030（含 BOM），按「第 N 章 / Chapter N / 序章 / 楔子…」自动分章，章节标题识别失败时按长度切节。
- **EPUB**：解析 `container.xml → OPF`，读取 spine / 目录（nav.xhtml 或 ncx），正文经过清洗（去掉脚本、表单、内联事件、外链跳转），图片从压缩包里解出转 blob 显示；封面自动提取并缩成小图。
- **PDF**：pdf.js 连续滚动，页面懒渲染（离开视野就释放画布），双指/按钮缩放 0.6×–2.4×，A−/A+/适宽，页码与进度。
- **排版**：CSS 多列分页（无滚动条的整页翻页），四套主题（纸白 / 米黄 / 松绿 / 夜间）、字号 14–30、行距三档、宋体/黑体、页边距三档、滑动/淡入翻页动画。
- **进度**：按「章 + 页 + 百分比」记录，退出/切后台都会落盘；改字号、转屏时保持相对位置。
- **交互**：左右点按翻页、中间点按呼出工具栏、横滑翻页、键盘 ←/→/空格/PageUp/PageDown、滚轮翻页；工具栏 3.4 秒自动隐藏；系统返回键从阅读器回到书架。
- 内置 3 本示例书（TXT / EPUB / PDF，含图文与目录），装好就能试。

## 技术栈

Capacitor 6（Android WebView 壳） + Vue 3 + TypeScript + Vite 5 + vue-router（hash） + Dexie（IndexedDB） + JSZip（EPUB 解包） + pdf.js 3.11。

## 目录结构

```
app/
  src/
    views/        ShelfView（书架）、ReaderView（阅读器装配）
    readers/      ReflowReader（TXT/EPUB 分页排版）、PdfReader（PDF 滚动渲染）
    components/   SettingsSheet（阅读设置）、TocSheet（目录）
    lib/          encoding（编码/分章）、epub（解包/清洗）、pdf（pdf.js 封装）、
                  import（导入入库）、cover（生成封面）、sample（示例书）、util
    db/           Dexie 表结构与读写（books / files / covers / settings）
    dev/          ?seed=1 时灌入示例书
  android/        Capacitor Android 工程（图标、启动图、返回键都在这里）
tools/
  browser/check.cjs   无头浏览器端到端验收脚本（书架→TXT→设置→EPUB→PDF）
  browser/probe.cjs   单点探针（IndexedDB / 排版尺寸调试）
  gen-assets.cjs      用无头 Chromium 生成各密度图标与启动图
docs/screenshots/     验收截图
```

## 本地开发

```bash
cd app
npm install          # 会自动把 pdf.js 的 cmaps/standard_fonts 拷进 public/pdfjs
npm run dev          # http://localhost:5173，加 ?seed=1 灌示例书便于调试
npm run typecheck    # vue-tsc
npm run build        # 产物 dist/
```

## 打 APK

Android 壳是 Capacitor 生成的标准工程（包名 `com.readawre.app`，minSdk 22 / targetSdk 34）。

```bash
cd app
npm run build && npx vue-tsc --noEmit
NODE_OPTIONS="--require /tmp/patch-userinfo.cjs" npx cap sync android   # 见下方说明
cd android
printf 'sdk.dir=/opt/android-sdk\n' > local.properties
JAVA_HOME=/opt/toolchain/jdk17 PATH=/opt/toolchain/jdk17/bin:$PATH \
GRADLE_USER_HOME=/tmp/gradle-home ./gradlew --no-daemon --max-workers=2 --offline \
  -Pandroid.aapt2FromMavenOverride=/opt/toolchain/aapt2-bin/aapt2 \
  -Dorg.gradle.jvmargs="-Xmx900m -XX:MaxMetaspaceSize=320m -Dfile.encoding=UTF-8" \
  clean assembleDebug
```

产物：`app/android/app/build/outputs/apk/debug/app-debug.apk`。

> 这台机器特有的两处适配：`/tmp/patch-userinfo.cjs` 用来绕开 Node 在 proot 里 `os.userInfo()` 的 ENOENT；
> `/opt/toolchain/aapt2-bin/aapt2` 是 qemu 代理脚本（宿主是 arm64，SDK 里的 aapt2 是 x86_64）。
> 在普通 x86_64 Linux / macOS 上打安卓包时这两处都可以去掉。

## 端到端验收

`tools/browser/check.cjs` 会用无头 Chromium 以 390×844 移动视口跑完：
书架 3 本 → 打开 TXT 翻页 → 中间点击出工具栏 → 目录跳章 → 设置改字号/主题并验证持久化 →
对 4 章长文本做分页压力测试（每章 ≥2 页、连点 6 次页码递增且能跨章）→
打开 EPUB 验证图片加载 → 打开 PDF 验证 canvas 渲染、缩放、滚动翻页。

```bash
# 先在另一个终端跑 npm run dev，然后：
NODE_PATH=/root/学习软件/tools/browser/node_modules node tools/browser/check.cjs
```

## 已知限制

- TXT 只认 UTF-8 / GB18030；其它编码（如 Big5）会按乱码显示。
- EPUB 支持 EPUB2/3 常见结构，复杂的固定版式（fixed-layout）或加密（DRM）书籍不支持。
- 扫描版 PDF 没有文字层，只能看页面图像；PDF 目录只在书里有 outline 时出现。
- 图书馆数据存在 WebView 的 IndexedDB 里：卸载 App 或清除应用数据会丢书（重新导入即可）；没有做云同步。
- 未做「导入时选文件夹批量扫描」：一次选择的文件多了会慢，建议分批导入。
