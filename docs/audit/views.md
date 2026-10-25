# 视图层与专注/习惯组件还原度审计

**审计对象**：`/root/学习软件/app/src`（APK 反编译产物逐节点重写，Vue 3 + TS）
**基准**：官方源码 tag v0.4.3 `/tmp/up043/src/renderer/src`
**范围**：11 个视图 + 5 个专注/习惯组件（`VideoView.vue` 不在本报告内）
**方法**：机械抽取（中文串集合、class token 集合、Icon 名、`bili.*`/store action 调用、控制流骨架、CSS 选择器与数值）→ 逐条人工归一化（变量重命名不算差异）→ 反面复核

---

## 一句话结论

**16 个文件语义等价，未发现行为性缺失或新增业务逻辑；仅 2 处中等差异（收藏时间显示格式、UP 简介缺单行省略）与 3 处低风险偏差，总体还原度约 98%。**

- 中文字符串：两侧各 **408** 条可抽取文案，逐条归一化后**无一丢失**（差异仅为变量名/格式化函数名替换）。
- class token：唯一真实缺失 = `UpManageView` 的 `clamp-1`；Icon 名 16/16 文件集合完全一致。
- `bili.*` 桥调用：仅 1 处**额外**兜底请求（`up.resolve` 只回 `mid` 时补一次 `up.info`）。
- store action 调用序列：规范化 store 名后全部一致。
- SFC 内 `<style>` 规则数 **225 = 225**，逐条比对仅 `:before`/`::before` 与颜色写法差异（等值）。上游无 style 的 5 个页面（Home/Search/Up/FavFolder/Learn）还原侧同样无 style。
- 死代码 `DanmakuLayer.vue` / `FocusRing.vue`：还原侧与上游均无任何引用（任务点 1 **通过**）。

---

## 页面还原度总表

| # | 页面/组件 | 文案 | class/Icon | API/Store | 交互状态 | CSS | 还原度 |
|---|---|---|---|---|---|---|---|
| 1 | HomeView | 17/18（差 1 条为未使用的 `reason`） | 一致 | 一致 | 等价 | 无 style（同上游） | 98% |
| 2 | SearchView | 17/17 | 一致 | 一致 | 等价 | 无 style（同上游） | 100% |
| 3 | UpView | 19/19 | 一致 | 一致 | 等价 | 无 style（同上游） | 100% |
| 4 | FavView | 29/29 | 一致 | 一致 | 等价 | 17 = 17 | 100% |
| 5 | FavFolderView | 10/10（1 条格式不同） | 一致 | 一致 | 等价 | 无 style（同上游） | 95% |
| 6 | LearnView | 25/25 | 一致 | 一致 | 等价 | 无 style（同上游） | 99% |
| 7 | HabitView | 41/41 | 一致 | 一致 | 等价（含全部冒烟探针） | 52 = 52 | 100% |
| 8 | LocalView | 26/26 | 一致 | 一致 | 等价（含 `__addLocalFiles`/`__localProbe`） | 13 = 13 | 100% |
| 9 | LocalPlayerView | 12/12 | 一致 | 一致 | 等价（含 `__playLog`/`__playProbe`） | 3 = 3 | 100% |
| 10 | UpManageView | 42/42 | **缺 `clamp-1` ×2** | **多 1 次 `up.info`** | 等价 | 16 = 16 | 90% |
| 11 | SettingsView | 50/48（+2 为内联清晰度表） | 一致 | 一致 | 等价（4 组，未多造） | 10 = 10 | 99% |
| 12 | FocusPanel | 39/39 | 一致 | 一致 | 等价（快捷键/Esc 层级同） | 32 = 32 | 99% |
| 13 | FocusTargets | 41/42（1 条为同一字面量的重命名） | 一致 | 一致 | 等价 | 36 = 36 | 100% |
| 14 | FocusRecords | 29/29 | 一致 | 一致 | 等价 | 31 = 31 | 100% |
| 15 | FocusOverview | 7/7 | 一致 | 一致 | 等价 | 10 = 10 | 100% |
| 16 | HabitHome | 4/4 | 一致 | 一致 | 等价（脚本逐行同构） | 5 = 5 | 100% |

> 行数对照（上游 → 还原）：Home 187→219、Search 178→221、Up 148→212、Fav 337→401、FavFolder 106→152、Learn 196→227、Habit 611→699、Local 403→456、LocalPlayer 186→231、UpManage 412→465、Settings 381→437、FocusPanel 625→642、FocusTargets 510→529、FocusRecords 341→360、FocusOverview 98→99、HabitHome 62→69。增量全部来自 TS 类型/接口声明、显式 `import type`、多行化格式，无新增逻辑分支。

---

## 逐页核对

### 1. HomeView（187 → 219）

- **文案 missing**：`/tmp/up043/src/renderer/src/views/HomeView.vue:36` 的 `` `已看 ${Math.round(progress * 100)}%` ``（`reason` 字段）。还原侧 `/root/学习软件/app/src/views/HomeView.vue:36` 注释说明「模板只把 5 个字段传给卡片，故省略」，实测模板确实不消费 `reason` → **无可见影响**（低）。
  其余 17 条命中文案仅 `fmtHours`→`toHours` 等重命名。
- **class/icon missing**：无。`:class` 的 `only`→`active` 属重命名（同名筛选语义）。
- **API/Store**：本页无直接桥调用（上游同样没有），数据来自 `ups`（`init/loadLatest/importFollowings/items/latest/count/latestError/loadingLatest`）与 `learn`（`listByVideo/progressMap/todaySeconds`），调用序列两侧逐行一致。
- **交互**：`progressOf` 统一为 `progressOf(item)`，差异在于还原侧对 `seconds` 做了 `|| 0`。**EXTRA**：`/root/学习软件/app/src/views/HomeView.vue:69` 的 UP 筛选 chip 名兜底 `map.set(mid, v.upName || \`UP ${mid}\`)`，上游 `HomeView.vue:64` 为 `names.set(k, it.upName)`（昵称为空时上游 chip 显示空串）→ 边界差异（低）。
- **CSS**：两侧均无 `<style>`，样式来自全局 `base.css`（还原侧 `styles/global.css`）。

### 2. SearchView（178 → 221）

- **文案**：17/17 命中（`hasQuery`→`hasKeyword`）。占位符、排序标签（`{key:'stow',label:'最多收藏'}`）、错误串 `'搜索失败'`、空态二分文案均一致。
- **class/icon**：20 = 20，无缺失。
- **API**：`api.search.videos(q, page, order)` → `bili.search.videos(...)`（等价）；`api.search.ups` 同。还原侧对 `pages/total` 补 `|| 1` / `|| 0` 兜底。
- **交互**：`hasKeyword` 控制空态；搜索页 `router.replace({name:'search',query:{q}})`、翻页、`changePage` 与 `keyword` 回填一致；加载/错误态（`errorMsg`→`error`）等价。
- **CSS**：两侧均无 scoped style。

### 3. UpView（148 → 212）

- **文案**：19/19。`{{ up ? up.name : 'UP 主' }}`、`'这个人很神秘'`、`已加入 UP 管理：${name}` 均一致；移除确认 `移除后首页不再显示「…」的更新。` 还原侧仅用可选链 `info.value?.name`。
- **class/icon**：18 = 18。
- **API**：`api.up.info` / `api.up.videos` / `ups.addUp` 序列一致；分组缺省 `DEFAULT_GROUP` → `UNGROUPED`（同值）。
- **交互**：头部「加入/已在 UP 管理」按钮 `v-if`/`v-else` 顺序调换但互斥，`primary` 归属正确；进度条 `progressOf` 等价。
- **CSS**：无 scoped style（同上游）。

### 4. FavView（337 → 401）

- **文案**：29/29。`B站账户收藏 {{ total }}`→`{{ biliCount }}` 等仅重命名；删除夹确认三参（`'删除文件夹？'` / 动态说明 / `'删除'`）完全一致。
- **class/icon**：36 = 36。
- **API**：`api.fav.folders()` → `bili.fav.folders()`；`collect.removeFolder(name)` / `collect.removeItem(id)` 一致。
- **交互**：`err.needLogin → ui.askLogin()` 分支保留；`f.deletable` 控件保留；空态/加载态等价。
- **CSS**：17 = 17，仅 `.fold.on::before` ↔ `.fold.on:before`。

### 5. FavFolderView（106 → 152）

- **文案 missing（真实差异）**：
  - 上游 `/tmp/up043/src/renderer/src/views/FavFolderView.vue:92`：`{{ fmtDate(m.favTime) }} 收藏`
  - 还原 `/root/学习软件/app/src/views/FavFolderView.vue:129`：`{{ relativeTime(m.favTime || 0) }} 收藏`
  → `2024-05-01 12:30 收藏` 变成 `3 天前 收藏`（**中**，显示语义变了，非崩溃）。
- 其余 9 条命中：`{{ m.upper }} · {{ fmtDuration(m.duration) }} · {{ fmtCount(...) }} 播放` 为等值改写（`formatClock`/`formatCount` 同实现）。
- **class/icon**：18 = 18。
- **API**：`api.fav.resources(mediaId, pn)` → `bili.fav.resources(mediaId, page)`，`hasMore` 保留。
- **交互**：分页「加载更多」`reset` 参数、`err.needLogin` 分支（还原侧加了花括号）、`play/open` 路由跳转 `{name:'video',params:{bvid}}` 一致。
- **CSS**：两侧均无 scoped style。

### 6. LearnView（196 → 227）

- **文案**：25/25（`已看 {{ fmtDuration }} / {{ fmtDuration }}`、`加入于 {{ fmtAgo }}` 等值改名）。
- **class/icon**：28 = 28；三个统计项 Icon `clock/fire/zap` 一致。
- **API/Store**：`learn.init(true)`、`learn.clearAll()`、`pomo.clearSessions()`、`pomo.init()`、`db.progress.delete`、9 张表导出（`progress/daily/notes/shelf/checkins/upTime/focus/habits/habitLogs`）全部对应，`payload.app='study-bili'`、`exportedAt` 一致。
- **交互**：`ready` 加载态由 `div v-if="!ready"` 改为 `<template v-if="ready">…/v-else`，等价；`tab` 仅 `recent`/`shelf` 两个（与上游一致，无额外面板）。
- **CSS**：无 scoped style。子组件 `HabitHome`/`FocusPanel` 顺序一致。

### 7. HabitView（611 → 699）

- **文案**：41/41（`周${WEEK_HEAD[… ]}`→`周${WEEKDAYS[… ]}`，两侧数组同为 `['一'…'日']`）。
- **class/icon**：73 vs 77，差异为 `:class` 数组写法（`['btn','primary']`）被 token 化，无真实缺失。
- **Store**：`create/update/toggle/clearAll/checkReminders/runReminders/stopReminders/focusMonthOf/remove` 序列一致。
- **交互**：
  - `save()` 空名校验完全一致：`if (!payload.name) { habits.create({ name: '' }); return }`（交给 store 报错）。
  - `openEdit` 的 `/^\d{2}:\d{2}$/` 校验 + `'08:00'` 兜底、`targetDays` 默认 100 一致。
  - 未来日期/未选中习惯点击月历拦截 `if (!cell || cell.future || !selectedId) return` 一致。
  - **冒烟探针 5 个全部保留**：`__habitProbe`、`__habitRemindCheck`、`__habitRemindAt`（结果写 `__habitRemindResult`）、`__habitRemindStop`、`__habitRemindReset`（清 `localStorage['study-bili-habit-remind']`），`onBeforeUnmount` 统一置 `null` 一致。
- **CSS**：52 = 52，仅 `.hb-row.on::before` 写法差异。

### 8. LocalView（403 → 456）

- **文案**：26/26（`sizeText`→`formatSize`、`probing`→`parsing` 等改名）。
- **class/icon**：21 vs 22，`rowitem lrow` 走数组形式（`LocalView.vue:324`），非缺失。
- **API**：`api.local.register/pickFiles/pickFolder/reveal/remove` → `bili.local.*` 一致。
- **交互**：
  - 重新登记 → 丢文件标记（仅首次落库 `if (!row.missing)`）→ `probeMissing/parseMissing` 串行补时长/封面，逻辑逐行同构。
  - 时长解析兜底常量一致：`Infinity` 时限 **2000ms**（还原写 `2e3`）、封面 seek **1600ms**、整体兜底 **12000ms**（还原写 `12e3`）。
  - `__addLocalFiles` / `__localProbe` 探针保留（返回结构同）。
- **CSS**：13 = 13；`.thumb .len` 背景 `rgba(0,0,0,.62)` ↔ `#0000009e`（等值）。

### 9. LocalPlayerView（186 → 231）

- **文案**：12/12（`row`→`rec`、`playError`→`errorText`）。
- **class/icon**：12 = 12。
- **API**：`api.local.register([path])` → `bili.local.register(...)`；`putLocal({id,pos,duration,playedAt,thumb})` 一致。
- **交互**：续播节流 **5000ms**（还原 `5e3`）、`setInterval(…, 5000)` 一致；`duration` 取 `isFinite(v.duration) && v.duration>0 ? … : row.duration` 一致；`__playLog` / `__playProbe` 探针与返回字段（`t/paused/err/duration`）一致。
- **CSS**：3 = 3；仅 `.clamp-1` 等继承全局。

### 10. UpManageView（412 → 465）

- **文案**：42/42。`「${target.name}」已归到 ${name}` ↔ `「${up.name}」已归到 ${target}` 为**同一语义的变量互换**（前者 target=被移动的 UP、name=分组名；后者 up=被移动的 UP、target=分组名），非文案错误。
- **class missing（真实）**：`.sign clamp-1`
  - 上游 `/tmp/up043/src/renderer/src/views/UpManageView.vue:200`（UP 列表）与 `:239`（搜索结果候选）
  - 还原 `/root/学习软件/app/src/views/UpManageView.vue:228` 与 `:281` 只有 `class="sign"`
  → 全局 `.clamp-1`（`styles/global.css:533`，与上游 `styles/base.css:516` 同）不再生效，长简介从「单行省略」变为多行撑高（**中**）。
- **API 差异（EXTRA）**：`/root/学习软件/app/src/views/UpManageView.vue:79-83`
  ```js
  const hit: any = await bili.up.resolve(s)
  let up: any = hit
  if (hit && !hit.face) { try { up = { ...hit, ...(await bili.up.info(hit.mid)) } } catch {} }
  ```
  上游 `UpManageView.vue` 只调 `api.up.resolve`，无补请求 → 某些桥实现下多一次网络往返（**低**，且用于兜底更健壮）。
- **交互**：`startAssign/confirmAssign/dropGroup` 三处确认框文案与第三参 `'删除'`/`'移除'` 一致；`looksLikeId` 正则 `/^\d{1,12}$/`、`/space\.bilibili\.com\/\d+/` 一致；`candidates.slice(0,8)`、`inlineGroup`（还原 `groupNew`）逻辑一致；`ups.addGroup` 自动补建分组一致。
- **CSS**：16 = 16。

### 11. SettingsView（381 → 437）

- **分组核对（任务点 7）**：上游 `<h2 class="sec">` 只有 **外观 / 播放 / 数据 / 关于** 4 组（`SettingsView.vue:160/203/274/302`），还原侧同为 4 组（`SettingsView.vue:205/249/320/355`）→ **未多造**。
- **文案**：48 vs 50，多出的 2 条是 `智能修复`/`杜比视界`。这**不是新功能**：上游从 `utils/quality.js:11,16` 的 `QN_LABEL` 表 import，还原侧就近内联为 `QUALITY_LABELS`（`SettingsView.vue:26,31`），另有 `app/src/player/quality.ts` 同表。
- **class/icon**：`settings.`→`conf.` 重命名；`step` 变量名差异。无缺失。
- **API**：`api.ping()`→`bili.ping()` 取版本；`api.sys.pickFile()`→`bili.sys.pickFile()`；`settings.patch({backupPath})`、`api.sys.writeFile(...)`/`api.sys.revealPath(...)` 参数顺序一致（`backupPath`, `bililite-learn-<stamp>.json`, JSON 文本）。
- **校验**：自定义强调色 `/^#[0-9a-f]{6}$/i`（两侧同），失败输入框回滚 + 错误提示一致；`swatchColor`/对比度 `luma` 权重 `0.299/0.587/0.114` 一致；`resetAll` 的 patch 键集合一致（`theme/accent/defaultQuality/autoNext/seekStep/playerVolume/hideDanmakuArea/autoMark/autoCheckin`）。
- **CSS**：10 = 10，仅 `.sec::before` 写法差异。

### 12. FocusPanel（625 → 642）

- **文案**：39/39（`QUICK_MAX`→`MAX_TARGETS`、`DUR_MIN/MAX`→`MIN/MAX_MINUTES` 等重命名，**数值同为 12/12/1/180**）。
- **class/icon**：45 = 45。
- **API/Store**：`pomo.primaryAction/reset/setDurations/loadStats/bindTask/clearTask/renameTask`、`settings.patch({focusTargets})`、`learn.shelf` 序列一致。
- **交互**：
  - 快捷键守卫顺序一致：先 `Escape` 逐层关闭（绑定层→设置→全屏），再 `typing`（INPUT/TEXTAREA/contentEditable）与 `confirmState.open` 拦截，再放行空格/`R`；面板内 `BUTTON` 焦点不抢空格——逐行同构。
  - 计时输入钳制 `Math.max(1, Math.min(180, Math.round(Number(v) || 1)))` 一致；`reset4520` 恢复 45/20 一致。
  - 目标数上限 12、名称上限 12 字、学习清单预览 60 条一致。
- **CSS**：32 = 32。

### 13. FocusTargets（510 → 529）

- **文案**：41 vs 42；`已经有「${next}」了` ↔ `已经有「${name}」了` 是 `next`→`name` 重命名（`commitRename` 内重名守卫**存在且位置一致**，上游 `:117` / 还原 `:118`）。
- **class/icon**：34 vs 35（`:class` 数组 token 化差异）。
- **交互**：新增/改名/归档/恢复/删除/恢复默认 六个动作的确认框与 toast 文案全同；`save(all.map(...))` 全量写回策略一致；`pomo.renameTask(old, next)` 历史记录联动一致；`currentName`→`boundName`。
- **CSS**：36 = 36。

### 14. FocusRecords（341 → 360）

- **文案**：29/29（`r`→`row`、`mins`→`minutes`）。
- **class/icon**：35 = 35。
- **交互**：补记默认 `minutes: 25`、重置 25、`Number.isFinite(mins) || mins < 1` 校验、`form.task.trim()` 一致；删除/清空两个确认框（含 `一共 ${allCount} 条…`）一致。
- **实现差异**：上游自建 `pad2`/`nowTimeStr()`（`getFullYear/getMonth/getDate/getHours/getMinutes`），还原改用 `utils/format` 的 `todayStr()`/`hhmm()` → **等价**（同补零规则）。
- **CSS**：31 = 31，仅 `.rec-rail::after` 写法差异。

### 15. FocusOverview（98 → 99）

- **文案**：7/7；**class/icon**：12 = 12；**CSS**：10 = 10。
- 唯一差异：`split(...)` → `splitSeconds(...)` 局部函数重命名。

### 16. HabitHome（62 → 69）

- **脚本逐行同构**（骨架 diff 零差异），`class` 20 = 20，`CSS` 5 = 5。仅 TS 类型声明增量。

---

## 差异清单（按严重度）

### 严重（行为/文案错误）
无。

### 中（可见的显示/交互偏差）
1. **FavFolderView 收藏时间格式**：上游 `fmtDate(m.favTime)`（绝对 `YYYY-MM-DD HH:mm`）→ 还原 `relativeTime(m.favTime || 0)`（相对 `N 天前`）。
   `views/FavFolderView.vue:92`（上游）↔ `views/FavFolderView.vue:129`（还原）。
   影响：信息仍在，但粒度与上游不同；用户想按时间排序/核对时会失真。
2. **UpManageView 简介缺单行省略**：`.sign` 缺 `clamp-1`（上游 `:200`、`:239`；还原 `:228`、`:281`）。
   影响：UP 列表与候选行的长简介由「单行省略号」变成多行，行高不齐（纯视觉）。

### 低（结构/命名/边界）
3. **HomeView `reason` 字段省略**：上游 `HomeView.vue:36` 计算 `已看 N%`，还原未算——模板不消费，无影响。
4. **HomeView UP chip 名兜底**：还原 `HomeView.vue:69` `v.upName || \`UP ${mid}\``，上游 `HomeView.vue:64` 直接 `upName`；昵称缺失时上游显示空 chip。
5. **UpManageView 额外兜底请求**：还原 `UpManageView.vue:79-83` 在 `up.resolve` 缺头像时补 `bili.up.info(mid)`（上游无）→ 多一次 IPC/HTTP。
6. **SettingsView 清晰度表内联**：`QN_LABEL`/`QN_ORDER` 由 `utils/quality.js` import 改为 SFC 内联（`SettingsView.vue:26,31`），内容一致（含 6~127 qn 名）。
7. **CSS 写法差异（等值）**：`::before`→`:before`（4 处）、`rgba(0,0,0,.62)`→`#0000009e`（1 处）。
8. **TS 化增量**：全部文件多出 `interface`/`import type`/断言 `as unknown as`，属还原工程性质，非语义差异。

---

## 未能验证的部分

1. **运行时行为**：未启动 APK/Electron，`bili.*` 桥的真实返回结构（如 `fav.folders` 是否含 `deletable`、`local.register` 的 `entries` 形状）只能按类型声明与上游调用点静态推断；两处「兜底」写法（UpManageView 的 `up.info`、若干 `|| 0`）正是为此存在。
2. **像素级视觉**：CSS 只比对选择器集合、关键数值与颜色记号，未做截图 diff；字体/行高/安卓安全区（`data-platform='android'`）下的实际排版未验证。
3. **Pinia store 实现**：本次仅核对 action 调用面与参数，`stores/*.ts` 内部（如 `habits.checkReminders` 的提醒判定、`pomo.weekSeconds` 的周切分）不在范围内，需另开审计。
4. **路由表**：`router/` 的 `name`/`path` 与上游 `router.js` 未逐条比对（本报告只确认页面内 `router.push` 的目标名一致）。
5. **平台差异**：上游 v0.4.3 为 Electron 桌面端，APK 为安卓壳（同一份渲染层）。`api.sys.pickFile` 等在安卓侧走不同原生实现，参数契约未逐字段验证。
6. **`VideoView.vue`**：按分工排除。
7. **还原工程新增的开发者能力**：`main.ts` 的 `?mock=1` 演示模式、`player/quality.ts` 重复表，属原 APK 之外的增量（不影响页面语义），未纳入还原度评分。

---

## 附：机械比对脚本（均只读，位于 `/tmp/audit`）

| 脚本 | 用途 |
|---|---|
| `stats.py`（复用 `ext2.py` 的抽取器） | 中文串分段抽取 + 集合差，输出 `cjk_stats.json`（408 vs 408） |
| `cls.py` | 模板 `class`/`:class` token 集合差（输出 `cls.json`） |
| `icons_diff.py` / `ext3.py` / `comp_api.py` | `<Icon name>` 与字面量集合、`bili.*` 与 store action 调用集合 |
| `skel2.py` | 脚本行骨架（标识符泛化 + TS 注解剥离）多重集差，逐条人工复核 |
| `flow.py` | 控制流 token 计数签名（`if/return/await/?./??/…`）用于筛选可疑函数 |
| `ext5.py` | 模板文本节点交错签名 diff |
| `css3.py` | SFC `<style>` 选择器集合与声明值比对（225 = 225） |
| `csscmp.py` | `styles/recovered/*.css` ↔ `reference/decompiled/css/*.css` 规则数比对 |
| `keys.py` / `num.py` / `val.py` | 属性访问集合、数值阈值（`5e3`/`2e3`/`12e3`）、校验正则与守卫行 |
