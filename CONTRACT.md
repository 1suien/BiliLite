# 重建工程约定（所有参与者必读）

## 背景

`reference/` 里是从 APK 里解出来的**生产构建产物**（Vite + Vue 3.5.43 打包、esbuild 压缩过，
变量名被压短，但结构、字符串、CSS 类名、注释里的中文提示都完整保留）。
`app/` 是我们要还原出来的**可继续开发的源码工程**。

目标不是 1:1 字节还原，而是：**行为一致、结构可读、删掉压缩后的怪异写法**。
每个被压缩的 chunk 与源文件的对应关系见 `docs/03-还原映射.md`，
拿不准的地方以 `reference/decompiled/js/xxx.js` 为准，并写注释说明。

## 工程结构

```
app/src/
  main.ts              启动入口（已写好，不要改）
  App.vue              应用外壳（任务：App 壳）
  router/index.ts      路由表（已写好）
  types.ts             全局类型（已写好）
  bridge/              window.bili 数据桥（安卓实现 = 任务：桥接层）
  components/          Icon/BiliImage/EmptyBlock/Pager（已写好）+ 各任务新增组件
  views/               12 个页面（各任务）
  player/              DASH/MSE 播放器（任务：播放器+VideoView）
  stores/              pinia：ui/auth/settings/learn/habits/ups/collect/mini（已写好）
  db/index.ts          Dexie 本地库（已写好）
  utils/format.ts      格式化工具（已写好）
  styles/global.css    全局样式（已写好，与 APK 逐字节等价，不要改）
  styles/recovered/    按 data-v 作用域拆出来的**各组件原始 CSS**（照抄进 SFC 的 <style scoped>）
```

## 已就绪的公共 API（import 时直接用，勿重复实现）

### 组件
```ts
import Icon from '@/components/Icon.vue'        // props: name(52 个内置图标), size=18, stroke=1.7
import BiliImage from '@/components/BiliImage.vue' // props: src, alt
import EmptyBlock from '@/components/EmptyBlock.vue' // props: icon='search', title, desc；默认插槽
import Pager from '@/components/Pager.vue'      // props: page, pages；@change="(p)=>..."
```

### 工具
```ts
import { formatCount, formatClock, formatDuration, parseSec, formatDateTime,
         relativeTime, todayStr, toHours, hhmm, parseDay, addDays, pad2 } from '@/utils/format'
```
- `formatCount(12345)` → `1.2 万`；`formatClock(754)` → `12:34`；`formatDuration(3900)` → `1h 5m`
- `parseSec('12:34')` → 754；`toHours(3600)` → `'1.00'`；`todayStr()` → `2026-10-25`

### 数据桥（网络/文件/系统能力，唯一数据来源）
```ts
import { bili } from '@/bridge'
await bili.home.feed(page)            // -> { items: VideoCard[], hasMore? }
await bili.home.popular(page)
await bili.search.videos(keyword, page, order)   // order: totalrank|click|pubdate|dm|stow
await bili.search.ups(keyword, page)
await bili.video.view(bvid)           // -> VideoDetail
await bili.video.pages(bvid)          // -> VideoPage[]
await bili.video.playurl(bvid, cid, qn)  // -> PlayUrl（dash: videos[]/audios[]）
await bili.video.related(bvid)        // -> VideoCard[]
await bili.video.danmaku(cid, segment) // -> { items: DanmakuItem[], count }
await bili.video.online(bvid, cid)    // -> { total, count }
await bili.video.subtitle(bvid, cid)  // -> { list: SubtitleTrack[] }
await bili.video.sendDanmaku(payload)
await bili.up.info(mid)               // -> UpCardInfo
await bili.up.videos(mid, pn, keyword)
await bili.up.resolve(query)          // "xxx" 或 "https://space.bilibili.com/123" -> { mid }
await bili.up.latest(mids, perUp)     // -> { items: VideoCard[], errors: [] }
await bili.up.followings(pn, ps)
await bili.fav.folders()              // -> { created: FavFolder[], collected: FavFolder[] }
await bili.fav.resources(mediaId, pn) // -> { items: FavResource[] }
await bili.settings.get() / bili.settings.patch(patch)
await bili.sys.openExternal(url) / pickFile() / revealPath(p) / pickSubtitle() / readSubtitle(p)
await bili.backup.write(dir, name, text)
await bili.local.pickFiles() / pickFolder() / register(paths) / remove(id) / reveal(p)
```
类型定义在 `src/bridge/types.ts`，实体在 `src/types.ts`。**失败时抛 Error**（`e.needLogin === true` 表示需要登录）。

### stores（`<script setup>` 里 const s = useXxxStore()）
- `useUiStore()`：`toasts/loginOpen/refreshSeq`；`toast(msg,type?,ms?)/ok/err/askLogin/confirm(title,sub,okText):Promise<boolean>/answerConfirm/refresh()`
- `useAuthStore()`：`ready/user/qr`；getters `loggedIn/avatar`；`restore/logout/startQr/stopPoll/poll`
- `useSettingsStore()`：`settings/loaded`；`applyTheme/init/patch(p)/setFocusTargets(list)`；常量 `ACCENTS/FOCUS_COLORS/FOCUS_COLOR_KEYS/DEFAULT_FOCUS_TASKS`，函数 `accentColor(key,theme)/makeFocusTarget(name,idx)/pickAccentFg/pickBrandFg/withAlpha`
- `useLearnStore()`：`progressMap/daily/shelf/checkins/upTime/sessionSeconds`；getters `list/listByVideo/totalSeconds/totalVideos/completedCount/inProgressCount/todaySeconds/streak/maxDailySeconds/checkinStreak/recentDays/upDistribution`；`init(force?) get(bvid,cid) isChecked(d?) checkin(d?) save(p) addSeconds(sec,up?) flushSeconds() shelfToggle(v) inShelf(bvid) clearAll()`
- `useHabitsStore()`：`habits/logs/tab/selectedId/viewMonth/lastReminder`；getters `dayMap/daysOf(id)/isDone(id,d?)/activeHabits/archivedHabits/list/selected/todayList/todayDone/selectedStats/statsOf(id)/calendar(ym)/logGroups/logCount`；`init(force?) reload() setTab select(id) setMonth monthMove(d) focusMonthOf create(p) update(id,p) toggle(id,d?) setDay(id,d,done) archive(id,on?) remove(id) clearAll() firedFor markFired dueReminders runReminders startReminders stopReminders checkReminders`；常量 `WEEKDAYS`，`buildCalendar(days,ym)`
- `useUpsStore()`：`items/groups/latest/latestAt/loadingLatest/latestError/activeGroup`；getters `count/mids/groupChips/filtered/latestByUp`；`init(force?) withNames(list) loadLatest(force?) addUp(up,group?) removeUp(mid) setGroup addGroup removeGroup importFollowings()`；常量 `UNGROUPED`
- `useCollectStore()`：`folders/items/activeFolder`；getters `count/folderList/filtered`；`init(force?) inCollect(bvid) add(video,folder?) removeItem(id) removeByBvid(bvid) moveItem(id,folder) createFolder removeFolder`；常量 `DEFAULT_FOLDER`
- `useMiniStore()`：小窗播放器状态；`size/clock/pct/videoTarget` getters；`play(v)/close()/toggleMinimize()/cycleSize()/moveTo(x,y)/persist()/setProgress(t,d)/setState(s)/setError(msg)`

### 本地库 `@/db`
`db`（Dexie 实例，表：progress/daily/marks/notes/shelf/ups/upgroups/collect/collectfolders/checkins/upTime/books/bookmarks/highlights/focus/subs/locals/habits/habitLogs）
以及函数 `getProgress/getAllProgress/putProgress/addDailySeconds/bumpDailyVideo/getDailyRange/getCheckins/putCheckin/addUpSeconds/getUpTime/addFocusSession/listFocusSessions/allFocusSessions/clearFocusSessions/listLocalSubs/putLocalSub/removeLocalSub/listLocals/getLocal/putLocal/removeLocal/listHabits/getHabit/putHabit/removeHabit/listHabitLogs/setHabitLog/clearHabits`

## 还原方法（重要）

1. **模板**：压缩后的 `setup()` 返回 `(e,_) => ...` 的渲染函数。`createElementVNode("div",{class:"x"},[...])` = `<div class="x">`；
   `createElementBlock`/`createBlock` = 带 v-if/v-for 的块；`renderList` = `v-for`；三元/`&&` = `v-if`；
   `createTextVNode(toDisplayString(x))` = `{{ x }}`；`_component_xxx`/import 的组件名 = `<Xxx>`；
   `withDirectives(...,[[vShow,...]])` = `v-show`；`Fragment` = `<template>`/多根。
2. **script**：把 `setup()` 里的 `ref/computed/watch/onMounted/function` 原样搬进 `<script setup>`，
   变量名按语义重命名（`e.t`、`a.value` 这类压短名要改成人话，如 `props.title`、`list.value`），
   并在难以判断的地方保留一句中文注释。
3. **样式**：`app/src/styles/recovered/<组件名>.css` 就是该组件原始 scoped CSS（已去掉 `[data-v-xxx]`），
   直接粘进 `<style scoped>`；`[data-v]` 内联在 keyframes 名里的后缀也已清理。
   样式里引用的变量（`--card`/`--t2`/`--brand`…）都在 `styles/global.css`，不要重定义。
4. **不要**改 `main.ts`、`router/index.ts`、`styles/global.css`、`stores/*`、`db/index.ts`、`utils/format.ts`、
   `bridge/index.ts`、`components/{Icon,BiliImage,EmptyBlock,Pager}.vue`。
   需要新的公共工具时，写在自己的文件里。
5. 代码风格：`<script setup lang="ts">`、2 空格缩进、属性用双引号、注释用中文。
   不要求类型严谨（不会被 vue-tsc 卡住），但避免 `any` 满天飞；props/emit 要声明。

## 输出要求

- 只写分配给你的文件，**不要碰别人的文件**。
- 完成后回报：写了哪些文件、每个文件的还原度（哪些逻辑是逐行等价的、哪些是推测的）、
  发现但没解决的问题（如某段压缩代码含义不明）。
- 如果实现某个交互所需的数据桥能力不存在，用 `bili` 里最近的能力，或在注释里标 `TODO(桥接)`，不要自己写网络请求。
