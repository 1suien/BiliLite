# BiliLite 还原工程审计：pinia stores + 应用外壳 + 通用组件 + 路由/入口

- 还原侧：`/root/学习软件/app/src`（TS，逐函数重写）
- 上游基准：`/tmp/up043/src/renderer/src`（v0.4.3，JS）＋ 安卓入口 `/tmp/up043/src/mobile/{main.js,platform.js}`
- 审计性质：只读；本文件是唯一产物。

## 结论

**一句话**：9 个 store（state/getters/actions 逐名一致、语义逐句对齐）、13 条路由、App.vue 外壳、10 个通用组件与上游高度等价，未发现结构性缺失；但 **habits store 的提醒时间参数类型写错（把 `HH:MM` 换成 `YYYY-MM-DD`），导致所有「到点提醒」在启动瞬间就全部误触发**，这是本范围内唯一的 P0 级行为缺陷；其次是 `main.ts` 把 6 个 store 预热了一遍（上游只在 `App.vue` 初始化一次），造成重复初始化和首屏白屏变长。

**还原度估计**：
| 范围 | 等价度 |
|---|---|
| stores（9 个） | **97%**（字段/文案 100%；行为 1 处 P0 + 1 处风格残留） |
| router | **100%**（13 条逐条一致） |
| App.vue | **98%**（逻辑一致，多一处 `onUnmounted` 清理） |
| main.ts / 入口 | **80%**（多一次预热 + mock/seed 新增；桥/返回键逻辑等价） |
| 通用组件（10 个） | **99%**（props/emits/slots 全一致；图标少 2 个死图标） |
| **整体** | **≈96%** 语义等价（无可感知的功能缺失，1 处明确 bug） |

---

## 1. 文件映射表

| 还原 | 上游 | 等价度 | 说明 |
|---|---|---|---|
| `app/src/stores/auth.ts` | `renderer/src/stores/auth.js` | 高 | 逐行等价；`poll()` 用了逗号表达式（风格残留） |
| `app/src/stores/collect.ts` | `stores/collect.js` | 高 | 等价 |
| `app/src/stores/habits.ts` | `stores/habits.js` | **中** | 提醒三函数的 `now` 参数类型错（P0）；其余等价 |
| `app/src/stores/learn.ts` | `stores/learn.js` | 高 | 等价（`keyOf` 用 `todayStr(d)` 实现） |
| `app/src/stores/mini.ts` | `stores/mini.js` | 高 | `readGeom`→`loadPosition` 改名 |
| `app/src/stores/pomodoro.ts` | `stores/pomodoro.js` | 高 | 逐行等价；`fmtDuration/fmtMin`→`formatClock/formatDuration` 输出相同 |
| `app/src/stores/settings.ts` | `stores/settings.js` | 高 | 22 个默认项逐名同序同值；颜色助手改名 |
| `app/src/stores/ui.ts` | `stores/ui.js` | 高 | 等价（toast 2600ms / err 4200ms 一致） |
| `app/src/stores/ups.ts` | `stores/ups.js` | 高 | `normalize`→`normalizeUp`、`DEFAULT_GROUP`→`UNGROUPED` |
| `app/src/App.vue` | `renderer/src/App.vue` | 高 | 模板结构一致（aside/main/header/RouterView 组件数逐个对齐）；多 `onUnmounted` |
| `app/src/router/index.ts` | `renderer/src/router.js` | 完全 | 13 条路由 + `afterEach` 标题 + 通配重定向全同 |
| `app/src/main.ts` | `renderer/src/main.js` + `mobile/main.js` | 中高 | 合并了移动端入口；多了 store 预热与 mock/seed |
| `app/src/styles/global.css` | `styles/tokens.css` + `styles/base.css` | 未审 | 不在本次范围 |
| `app/src/native/clipboard.ts` | `mobile/platform.js#installClipboard` | 高 | 等价（`navigator.clipboard` shim、`__bililite` 标记、prototype getter 兜底） |
| `app/src/native/pip.ts` | `mobile/platform.js#installFullscreen/installPip` | 高 | 等价（`data-fullscreen`/`data-pip`、`Immersive`/`StatusBar`/`ScreenOrientation.lock`、`Pip.setPlaying/setGeometry`） |
| `app/src/components/icons.ts` | `renderer/src/components/Icon.vue`（内联 ICONS 表） | 高 | 52/54 图标，缺 `flex`/`display`（两侧均无引用） |

---

## 2. store 字段级 diff（按 store）

方法：`/tmp/audit/keys5.py`、`/tmp/audit/keys6.py` 词法扫描 `defineStore` 选项对象的顶层 key，再人工逐条对读。**结论：9 个 store 的 state / getters / actions 字段名集合完全一致（无 missing、无 extra）。**

### auth — state 4 / getters 2 / actions 5 · 一致
| 项 | 上游 | 还原 |
|---|---|---|
| state | `ready,user,qr,polling` | 同（同默认） |
| getters | `loggedIn,avatar` | 同 |
| actions | `restore,logout,startQr,stopPoll,poll` | 同 |
| 持久化/副作用 | 桥 `login.get/set/clear`、`qrPoll` 轮询 2200ms | 同 |
| 差异 | — | `poll()` 写成 `while (a && b && (await sleep(2200), !(...)))`，语义等价但为反编译风格（CONTRACT 要求剔除） |

### collect — state 4 / getters 3 / actions 8 · 一致
`state: loaded,folders,items,activeFolder`；`getters: count,folderList,filtered`；`actions: init,inCollect,add,removeItem,removeByBvid,moveItem,createFolder,removeFolder`。`createFolder` 会把 `activeFolder` 切到新夹并返回记录，与上游一致；`add` 在默认分组时回填 `at: Date.now()` 后写库，一致。

### habits — state 8 / getters 14 / actions 21 · 字段一致，**提醒逻辑 1 处 P0**
- state：`loaded,habits,logs,tab,selectedId,viewMonth,timer,lastReminder`（8/8，`viewMonth` 默认 `todayStr().slice(0,7)`）。
- getters：`dayMap,daysOf,isDone,activeHabits,archivedHabits,list,selected,todayList,todayDone,selectedStats,statsOf,calendar,logGroups,logCount`（14/14）。
  - `calendar` 依赖 `buildCalendar`（上游 `buildMonth`）：周一起始、`(getDay()+6)%7` 前置空位、补齐到 42 格、`label = ${y}年${m}月` —— **逐句等价**。
- actions（21/21 同名）：`init,reload,setTab,select,setMonth,monthMove,focusMonthOf,create,update,toggle,setDay,archive,remove,clearAll,firedFor,markFired,dueReminders,runReminders,startReminders,stopReminders,checkReminders`。
  - `create/update/toggle/setDay/archive/remove/clearAll` 的 db 调用顺序、toast/confirm 文案**逐字相同**（仅内部变量名 `row→rec`、`st→stats`、`h→hit`）。
  - 常量：`LS_FIRED 'study-bili-habit-remind'`→`REMIND_KEY`（同值）、`TICK_MS 30000`→`REMIND_INTERVAL 30*1000`、`WEEK_HEAD`→`WEEKDAYS`（同值）。
  - 导出辅助函数改名：`shiftDay/elapsedDaysOf/buildMonth` → `utils/format.addDays` / `elapsedDaysInMonth` / `buildCalendar`；`WEEK_HEAD→WEEKDAYS`，调用点同步（上游 `views/HabitView.vue:3,22,291` ↔ 还原 `views/HabitView.vue:11,33,356`），无悬挂引用。
  - **P0**：`dueReminders/runReminders/checkReminders` 的 `now` 默认值应为 `HH:MM`，还原写成了日期（详见 §4 D1）。

### learn — state 8 / getters 12 / actions 10 · 一致
`state: loaded,cleanedJunk,progressMap,daily,shelf,checkins,upTime,sessionSeconds`；getters 12 个同名（`maxDailySeconds = Math.max(3600, ...)`、`recentDays` 30 天、`upDistribution` 均等价）；actions `init,cleanupJunk,checkin,save,addSeconds,up,flushSeconds,shelfToggle,inShelf,clearAll`。`save/addSeconds` 的 db 写入顺序一致（含 `else this.daily = await getDailyRange(30)` 分支）。

### mini — state 工厂 19 / getters 4 / actions 10 · 一致
LS key `study-bili-mini`、`x/y` 默认 `-1`、`sizeIndex` 默认 `1` 且 clamp 到三档；getters `size,clock,pct,videoTarget`；`videoTarget` 的「`page>1` 才带 `p`、`currentTime>3` 才带 `floor(t)`」规则一致。

### pomodoro — state 工厂 18 / getters 20 / actions 21 · 一致
LS key、默认 `focusMin 25 / breakMin 5`、`setDurations` clamp 1..180、`setMode` 顺序（`stopTick→accrue→running=false→mode→重置 focusedSeconds→remain=total`）、`start` 的 `endAt = now + remain*1e3`、`pause` 的 `remain = round((endAt-now)/1e3)`、`tick→finish(true)` 不 await、`finish` 的两条路径（<30s 不记录）全部对齐。持久化仅 `{day,focusMin,breakMin,lastTask}`。文案里的 `fmtDuration/fmtMin` 换成 `formatClock/formatDuration` —— 输出字符串相同（`m:ss` / `45m`）。

### settings — state 2（settings 22 键）/ getters 0 / actions 4 · 一致
`DEFAULT_SETTINGS` 22 个键与上游 `state.settings` **逐名同序同默认**（脚本 22/22）：`theme:'dark', accent:'mono', … navOrder:[], subFontSize:22, subBg:true, subBottom:8, focusTasks:['阅读','刷题','看课','整理笔记'], focusTargets:[]`。
`applyTheme` 逐句等价：`dataset.theme`；`ACCENTS`（上游 `ACCENT_PRESETS`）、`BRANDS`、`FOCUS_COLORS`；`--accent/-accent-fg/--brand/-soft/-line/-fg/--ring` 七个变量名与 alpha（亮 0.1/0.3/0.38、暗 0.16/0.38/0.45）一致；`pickAccentFg`（阈值 .6，缺省 `#0a0a0b`）、`pickBrandFg`（阈值 .45，缺省 `#06121f`）≡ `readableFg/brandFg`。
命名瑕疵：`accentColor(key,theme)` 实际只是查 `FOCUS_COLORS`（上游名 `targetHex`），名字误导但行为一致。

### ui — state 5 / getters 0 / actions 8 · 一致
`state: toasts,loginOpen,refreshSeq,confirmState,_confirmResolve`；`toast(message,type='info',ms=2600)`、`err` 4200ms、`confirm()` 返回 `Promise<boolean>` 由 `answerConfirm` 兑现 —— 与上游一致。

### ups — state 8 / getters 5 / actions 9 · 一致
`state: loaded,items,groups,latest,latestAt,loadingLatest,latestError,activeGroup`；getters `count,mids,groupChips,filtered,latestByUp`；`loadLatest` 缓存 key `study-bili:up-latest`、TTL 5min 同；`addGroup` 的「空→默认组→重名抛 `'这个分组已经存在'`→写库」顺序等价。

---

## 3. 通用组件 props / emits / slots

| 组件 | props（上游 ≡ 还原） | emits | slots | 行为核对 |
|---|---|---|---|---|
| `Icon.vue` | `name* , size=18, stroke=1.7` | — | — | `<svg viewBox="0 0 24 24">` + `v-html`，缺名渲染空串；`.icon{display:inline-block;vertical-align:-0.145em}` 一致；图标表外移到 `icons.ts` |
| `BiliImage.vue` | `src='', alt=''` | — | — | `referrerpolicy=no-referrer` + `loading=lazy` + `decoding=async`；`@error` 后切 `.ph` 占位显示 `alt[0]` 一致 |
| `VideoCard.vue` | `item*, progress=0, showUp=true` | — | — | 整卡 `router.push({name:'video'})`；`.mini` 按钮 `stopPropagation` 调 `mini.play({bvid,fromCard:true,page:1,title,upName,cover,duration})`；UP 名 `stopPropagation` 跳 `up`；`durationText !== '0:00'` 才显角标；`pct>0` 显进度条；`reason` 优先于 `播放` 数 |
| `Pager.vue` | `page=1, pages=1` | `change(page)` | — | `1…4 5 6…20` 省略算法、`go()` 的 clamp、`v-if="pages>1"`、首尾按钮 disabled 全部一致 |
| `SkeletonGrid.vue` | `count=12` | — | — | `v-for="n in count"` + 三层 `.sk` 占位一致 |
| `EmptyBlock.vue` | `icon='search', title='这里还是空的', desc=''` | — | `default` | `desc` 有值才渲染；`$slots.default` 有才渲染按钮行 |
| `Toasts.vue` | — | — | — | 读 `ui.toasts`，`TransitionGroup name="t"`，`.t-enter-from{translateY(8px)}` 一致 |
| `ConfirmModal.vue` | — | — | — | `ui.confirmState.open` 控制；遮罩点击/取消/Esc→`answerConfirm(false)`，Enter/确定→`true`；`okText` 来自 store |
| `LoginModal.vue` | — | — | — | `qrcode.toCanvas(canvas,url,{width:176,margin:1,errorCorrectionLevel:'M',color:{dark:'#000',light:'#fff'}})`；`qr.status==='success'` → `ui.ok('已登录：'+uname)` 后 700ms `close()`；`close()` = `stopPoll()+loginOpen=false`；卸载时 `stopPoll()`（上游 `onBeforeUnmount` ≡ 还原 `onUnmounted`） |
| `PageFloat.vue` | — | — | — | `.scroll` 绑定 + 捕获阶段 `document scroll` + 400ms 轮询兜底；`scrollTop>200` 显「顶部」；`refresh()` = `ui.refresh()` + 600ms 旋转；`toTop()` 的 400ms fallback 判断 `scrollTop>=before && >0` 一致 |

**Icon 名字集合**：上游 54 个，还原 52 个 → **missing = `flex`, `display`（2）**，**extra = 无**。这两个名字在上游与还原两侧都**没有任何引用**（`grep` 全仓 0 命中），属上游死代码，缺它们不改变渲染。其余 52 个名字的内容（SVG path 字符串）逐字相同，顺序略有调整（`icons.ts` 按主题重排，仅影响可读性）。

补充脚本核查：还原侧全部 `<Icon name="…">` / `icon:` / `icon="…"` 引用（含 `pomo.running ? 'pause' : 'play'` 这类动态表达式）都能在 `ICONS` 找到对应键，**无悬空图标引用**。

---

## 4. 差异清单（按严重度）

### D1 · P0 · habits 提醒时间参数类型错误（功能 bug）
- 还原 `/root/学习软件/app/src/stores/habits.ts:325`
  `dueReminders(now = dayKey(new Date()), day = dayKey(new Date()))`
  `/root/学习软件/app/src/stores/habits.ts:327`
  `const at = /^\d{2}:\d{2}$/.test(String(now)) ? String(now) : '23:59'`
  同类：`habits.ts:338 runReminders(now = dayKey(...))`、`habits.ts:370 checkReminders(now = dayKey(...))`
- 上游 `/tmp/up043/src/renderer/src/stores/habits.js:347`
  `dueReminders(hhmm = nowHHMM(), day = todayKey())`（`:349` 同样的正则兜底 `'23:59'`）
  同类：`habits.js:361 runReminders(hhmm = nowHHMM(), ...)`、`habits.js:394 checkReminders(hhmm = nowHHMM(), ...)`；`nowHHMM` 定义在 `habits.js:84-86`：`` `${pad(d.getHours())}:${pad(d.getMinutes())}` ``
- 影响：`dayKey()` 返回 `'2026-10-25'`，正则 `/^\d{2}:\d{2}$/` 不匹配 → `at` 恒为 `'23:59'` → `String(h.remindAt) <= '23:59'` 对一切合法 `HH:MM` 为真 → **任何开启提醒且未打卡的习惯，在 `startReminders()` 的首次巡检（App 启动瞬间）就被判定为「到点」**：立刻弹系统通知 + `toast(…,6000)`，并 `markFired(day, ids)` 记为已提醒 → 当天真正的提醒时刻不再触发。`lastReminder.at` / `checkReminders().at` 也从 `'09:30'` 退化成 `'2026-10-25'`。
- 建议：把三处默认值改回 `hhmm()`（还原侧 `src/utils/format.ts` 已有等价的 `hhmm`，只是没被使用）。

### D2 · P1 · main.ts 与 App.vue 重复初始化 6 个 store
- 还原 `/root/学习软件/app/src/main.ts:72-80` 在 `app.mount` **之前** `await Promise.allSettled([settings.init(), auth.restore(), learn.init(), habits.init(), ups.init(), collect.init()])`，随后 `main.ts:82 app.mount('#app')`。
- 还原 `/root/学习软件/app/src/App.vue:184-203` 的 `onMounted` 又按上游顺序再跑一遍 `settings.init() → auth.restore() → learn.init() → ups.init() → habits.init()+startReminders()`。
- 上游 `/tmp/up043/src/mobile/main.js:36-42` 只装桥 + shim，然后 `await import('../renderer/src/main.js')`；`/tmp/up043/src/renderer/src/main.js:1-11` 只做 `use(createPinia)/use(router)/mount`，**没有任何 store 预热**；初始化只发生在上游 `App.vue:167-186`（同一段 try/catch）。
- 影响：① 6 个 store 的 init/reload 各跑两遍（多一轮 IndexedDB 读，`collect.init` 首轮即预载，上游是进收藏页才载）；② `mount` 被拖到 6 个 store 全部就绪之后，首屏从「立刻挂载 + 骨架屏」变成「白屏等数据」，弱机/大库时 TTI 明显变差；③ `auth.ready = true`（`main.ts:84`）在上游没有对应语句，若 `restore()` 失败会把 `ready` 强行置真，掩盖未登录态初始化错误。
- 建议：删掉 `main.ts` 的预热块（保留 `auth.ready` 由 `restore()` 自己置位），初始化只留 `App.vue` 一处；若确实要「首屏无主题闪烁」，应只保留 `settings.init()` 一次并在 `App.vue` 里改为「已 loaded 就跳过」。

### D3 · P1 · LoginModal 打开即自动生成二维码（新增行为，已注释声明）
- 还原 `/root/学习软件/app/src/components/LoginModal.vue:66-80`：`watch(() => ui.loginOpen, open => { … refresh() }, { immediate: true })`，状态不在 `['loading','waiting','scanned']` 就换新码。
- 上游 `/tmp/up043/src/renderer/src/components/LoginModal.vue:37-46` 有 `open()`（`ui.loginOpen=true` 时按状态 `start()` 或重绘），但**全仓无调用点**，等价于「打开弹窗不自动取码，需手点『刷新二维码』」。
- 影响：打开弹窗会立刻发一次二维码请求（多一次网络 + 上游不存在的副作用）；对用户是体验改善，对「1:1 复刻」是偏差。还原侧已在注释里说明「若要严格 1:1 删掉这个 watch 即可」。
- 建议：保留，但在审计基线里登记为「有意的行为增强」；若验收要求严格等价，删除该 watch 并删除已死的 `open()` 替代品。

### D4 · P2 · 新增 mock / dev seed 通道
- 还原 `/root/学习软件/app/src/main.ts:33-41`：`mockMode = location.search.has('mock') || (import.meta.env.DEV && !window.bili)`，命中则 `installMockBridge()` + `await seedDemoData()`（`src/bridge/mock.ts`、`src/dev/seed.ts` 均为新增文件，上游无）。
- 影响：上游完全没有这条路径。生产包里 `import.meta.env.DEV` 为假，但 **`?mock=1` 在打包后仍然生效**（hash 路由下 query 位于 `index.html` 的 URL 上），任何人用一个带 `?mock=1` 的链接打开就会进入假数据模式并往 IndexedDB 种演示数据 —— 真机排障时会非常迷惑。
- 建议：给 `?mock` 分支加 `import.meta.env.DEV` 与或一个构建期常量门控；或在生产构建里 tree-shake 掉 `mock.ts`/`seed.ts`。

### D5 · P2 · Icon 缺 `flex` / `display`
- 还原 `/root/学习软件/app/src/components/icons.ts`（52 键）vs 上游 `/tmp/up043/src/renderer/src/components/Icon.vue` 内联 `ICONS`（54 键）。
- 影响：无 —— 两侧均无引用，属上游死图标；若有第三方代码按名字用 `flex/display` 会渲染成空 `<svg>`（上游能画出来）。
- 建议：补上这两个 path 以做到集合相等（成本极低）。

### D6 · P2 · auth `poll()` 逗号表达式（风格 / CONTRACT）
- 还原 `/root/学习软件/app/src/stores/auth.ts` 的 `poll()`：`while (this.polling && this.qr.key === key && this.qr.status !== 'success' && (await sleep(2200), !(!this.polling || this.qr.key !== key)))`。
- 上游 `stores/auth.js` 的 `poll()`：`while (…) { await sleep(2200); if (!this.polling || this.qr.key !== key) break; … }`。
- 影响：语义等价（每轮先 sleep 再校验），但逗号表达式是反编译产物特征，与「逐函数重写成可读 TS」的契约不符。
- 建议：改写成 `await sleep(2200); if (!this.polling || this.qr.key !== key) break`。

### D7 · P3 · App.vue 多出 `onUnmounted` 解绑（新增，行为中性）
- 还原 `/root/学习软件/app/src/App.vue:205-212`：`keyHandler` 具名 + `onUnmounted` 里 `removeEventListener`。
- 上游 `/tmp/up043/src/renderer/src/App.vue:187-205`：匿名监听器，**从不解绑**（单例外壳不会卸载）。
- 影响：生产等价；仅 HMR 时避免监听器叠加，属正确性改进。

### D8 · P3 · 命名/组织差异（不改变行为）
| 还原 | 上游 |
|---|---|
| `stores/mini.ts loadPosition` | `stores/mini.js readGeom` |
| `stores/pomodoro.ts loadPomodoroConfig` | `stores/pomodoro.js loadPrefs` |
| `stores/settings.ts pickAccentFg / pickBrandFg / withAlpha / accentColor` | `readableFg / brandFg / hexToRgba / targetHex` |
| `stores/settings.ts ACCENTS / BRANDS / FOCUS_COLORS / DEFAULT_FOCUS_TASKS` | `ACCENT_PRESETS / (brand 表) / (专注色表) / DEFAULT_FOCUS_TARGETS` |
| `stores/habits.ts WEEKDAYS / REMIND_KEY / REMIND_INTERVAL / buildCalendar / elapsedDaysInMonth` | `WEEK_HEAD / LS_FIRED / TICK_MS / buildMonth / elapsedDaysOf` |
| `stores/ups.ts UNGROUPED / normalizeUp` | `DEFAULT_GROUP / normalize` |
| `utils/format.ts formatClock / formatDuration / toHours` | `fmtDuration / fmtMin / fmtHours`（输出相同） |
| `main.ts installBackButton` | `mobile/main.js wireAndroidBack` |
| `native/clipboard.ts + native/pip.ts` | `mobile/platform.js installPlatformShims()` 一个入口拆成三个 install 函数（`main.ts:57-59` 依次调用，顺序与上游 `platform.js:153-157` 一致） |

### D9 · P3 · `checkReminders()` 返回的 `at` 语义
- 还原 `habits.ts:371` `{ day, at: now, … }`（`now` 实为日期串）↔ 上游 `habits.js:395` `{ day, at: hhmm, … }`。D1 修好后自动恢复，无需单独改。

### 逐项确认（未发现差异的高风险点）
1. **路由**：13 条（`/ /search /video/:bvid /fav /fav/:mediaId /learn /habit /local /local/:id /ups /up/:mid /settings` + `/:pathMatch(.*)*` redirect `'/'`）、`createWebHashHistory()`、全懒加载、`meta.title` 中文标题、`afterEach` 拼 `` `${title} · BiliLite` ``、**两侧都没有 `scrollBehavior`** —— 全部一致（`router/index.ts:23-40` ↔ `router.js:14-31`）。
2. **App.vue 导航**：7 项（`首页/UP 管理/收藏/学习/习惯/本地/设置`，路径与图标名逐个相同）；`MORE_PATHS = ['/fav','/ups','/settings']` ≡ 上游 `NAV_SECONDARY`；`mainNav/moreNav` 分组切割一致。
3. **navOrder**：读取时「只认还存在的路径，其余按默认顺序补在后面」；落盘时拼成「主区域顺序 + 更多区域顺序」（还原 `/root/学习软件/app/src/App.vue:131-135` ↔ 上游 `/tmp/up043/src/renderer/src/App.vue:137-142`）；跨组拖拽双向拒绝；`over` 阶段才 `preventDefault`；`dragstart` 写 `text/plain`、`drop` 回读兜底 —— 全部一致。
4. **剧场模式**：`ref(false)` 不落盘；`F/f` 切换并 `preventDefault`；`Esc` 退出；路由变化 `watch(route.fullPath)` 自动退出 + 内容区 `scrollTo({top:0,behavior:'instant'})`（`catch` 兜底 `scrollTop=0`）一致；模板里有 `v-if="theater"` 的退出按钮。
5. **键盘**：`/(INPUT|TEXTAREA)/` 或 `isContentEditable` 视为输入中；`/` 聚焦搜索框（`preventDefault`）；输入中或 `ctrlKey/metaKey/altKey` 直接 return —— 与上游逐条相同。
6. **RouterView**：`<component :is="Component" :key="`${route.fullPath}#${ui.refreshSeq}`" />` 逐字相同，无 `keep-alive`。
7. **初始化顺序与日志前缀**：`settings.init() → auth.restore()` 不包 try；`learn`/`ups`/`habit` 各自 try/catch，前缀 `'[learn] 本地学习库初始化失败：'`、`'[ups] 本机 UP 名单初始化失败：'`、`'[habit] 习惯数据初始化失败：'` 与上游**逐字相同**；`habits.init()` 后紧接 `habits.startReminders()`。
8. **入口顺序**：`data-platform='android'`（上游 `mobile/main.js:20` 同样硬编码）→ 桥安装（`hasDesktopBridge` 逃生口保留，`window.bili.platform !== 'android'` 判定一致）→ 剪贴板/全屏/PiP shim → 挂载 → 返回键接管；返回键优先级链「登录弹层 → 确认框 → 全屏 → 剧场（派发 `Escape`）→ `history.state.back` → `minimizeApp().catch(exitApp)`」与上游 `mobile/main.js:79-116` 逐条相同，日志 `'[mobile] @capacitor/app 不可用，跳过返回键接管：'`、`'[mobile] 检测到桌面桥，跳过安卓桥安装（仅用于桌面预览平板布局）'`、`'[mobile] 渲染层启动失败:'` 逐字相同；失败时把错误画进 `#app` 的 HTML 也一致。

---

## 5. 中文文案 missing / extra

做法：`/tmp/audit/cjk_scope.py` 抽 9 个 store + App.vue + 10 个组件的字符串字面量与模板文本节点，按文件对做集合差（脚本输出 `/tmp/audit/` 下）。

**结论：无用户可见文案缺失（missing = 0 条真实业务文案）。** 所有「缺失」项都是插值表达式里的变量改名或注释重写，渲染结果完全相同：

| 文件 | 脚本报的 missing | 真实情况 |
|---|---|---|
| `stores/habits.ts` | `已添加习惯「${row.name}」`、`已打卡 · 连续 ${st.streak} 天`、`删除习惯「${h ? h.name : ''}」？` | 还原为 `已添加习惯「${rec.name}」`、`已打卡 · 连续 ${stats.streak} 天`、`删除习惯「${hit ? hit.name : ''}」？` —— 变量名不同，**文案一字未变** |
| `stores/pomodoro.ts` | `已按「部分完成」记下 ${fmtDuration(seconds)} 专注`、`已专注 ${fmtDuration(secs)}，会按「部分完成」…`、`这一轮只走了 ${fmtDuration(secs)}，不到 30 秒…` | 还原为 `formatClock(focusSec)`/`formatClock(elapsed)`；`formatClock ≡ fmtDuration`（m:ss / h:mm:ss），**渲染文本相同** |
| `App.vue` | `${n.label}（按住拖动可调整顺序）`、`今日 {{ todayText }}h` 等 | `item.label`、`todayHours`（≡`fmtHours`）—— 变量改名 |
| `components/VideoCard.vue` | 无 | 还原侧多两行**注释**（含「原实现」字样），不影响渲染 |

**extra 文案（还原侧多出来的）**：无业务串；仅注释与上表的插值变量名。

**抽查逐字一致的高价值文案**：`'扫码登录'`、`'二维码不可用'`、`'请用 B 站 App 扫描二维码'`、`'刷新二维码'`、`'取消'`、`'登录即代表同意仅用于个人学习用途；…'`（LoginModal），`'这里还是空的'`（EmptyBlock 默认 title），`'上一页'/'下一页'`（Pager），`'换一换：重新加载当前页面'/'回到顶部'/'顶部'`（PageFloat），`'已退出登录'`、`'该打卡了 · …'`/`'该打卡了：${names.join('、')}'`、`'已归档，不再提醒'/'已恢复'`、`'清空所有习惯打卡？'`、`'这个分组已经存在'`、`'专注'`/`'休息'` 等 —— 两侧逐字相同。

图标缺失项（见 D5）：`flex`、`display`（无文案、无引用）。

---

## 6. 未能验证部分

1. **`app/src/bridge/android.ts#installAndroidBridge`** 是否等价于上游 `mobile/bridge.js#installBridge`（原生 Preferences 预读、等待真实设置/登录态后再挂载、`window.bili` 方法表完整性）—— 超出本次范围，仅确认调用点与顺序等价。
2. **`app/src/bridge/mock.ts`、`app/src/dev/seed.ts`** 的内容与副作用（种了哪些表、是否清理），上游无对应实现可 diff；只确认它们是新增且被 `main.ts:33-41` 触发。
3. **`db/`、`api/`、`views/`、其余组件**（MiniPlayer/FocusPanel/FocusRecords/FocusTargets/PartList/CollectModal/MiniPlayer/DanmakuLayer 等）不在本次清单内，其 store 调用点已抽查（`pomo.addManualSession`、`pomo.clearSessions`、`collect.init`、`WEEKDAYS`），未做逐行核对。
4. **样式等价性**：`tokens.css`+`base.css` → `global.css` 合并后是否有选择器遗漏，未核（不在范围）。
5. **运行期验证**：全部结论均来自静态对读与脚本抽取，**未启动应用**，故 D1/D2 的影响描述基于代码路径推导（D1 的触发路径 `startReminders→runReminders→dueReminders` 已完整读完，可确定）。
6. 脚本 `keys5.py/keys6.py` 对 `actions` 的键抽取会把方法体内关键字（`if/for/while`）误当 key，因此「actions 数量两侧一致」的结论结合了人工逐条对读（§2 各小节已列出全部真实 action 名）。

---

## 7. 复核用脚本（均在 /tmp/audit/）

| 脚本 | 作用 |
|---|---|
| `keys3.py` / `keys5.py` / `keys6.py` | 抽 `defineStore` 的 state/getters/actions 顶层 key，两侧做 missing/extra |
| `cjk_scope.py` | 按文件对抽中文字符串 + 模板文本节点，做 missing/extra 集合差 |
| `comp_api.py` | 抽 10 个组件的 props/emits/emit 调用/slot 名 |
| `icons_diff.py` | 上游 `Icon.vue` 内联表 vs 还原 `icons.ts` 的名字集合/顺序/重复项 |
| 输出 | `keys.txt`、`comp_api.txt`（其余直接打印） |
