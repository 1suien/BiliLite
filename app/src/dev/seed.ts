/**
 * 开发者用的演示数据
 *
 * 只有启用 mock 桥时才会调用（见 src/main.ts）：往本地 Dexie 库里种一批假数据，
 * 这样「学习 / 习惯 / 本地 / 收藏」这些依赖本地库的页面在浏览器里也有内容可看。
 *
 * 只在库为空时写入，不会覆盖真实数据。原始应用没有这个文件，属于还原过程中新增的开发者工具。
 */
import { db } from '@/db'
import type { CollectItem, DailyRecord, FocusSession, Habit, HabitLog, LocalVideo, ProgressRecord, UpTimeRecord } from '@/types'
import { cover as demoCover } from '@/bridge/mock'

/** 最近 n 天（含今天）的日期字符串，老 → 新 */
function recentDays(n: number): string[] {
  const out: string[] = []
  const d = new Date()
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d.getTime() - i * 86400000)
    out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`)
  }
  return out
}

const DEMO_VIDEOS = [
  { bvid: 'BV1mock0001', title: '现代操作系统到底是怎么调度进程的', upName: '极客湾Geekerwan', upMid: 14871346, duration: 1832, page: 1 },
  { bvid: 'BV1mock0002', title: '一个视频讲清楚线性代数的本质', upName: '硬核的半佛仙人', upMid: 37663924, duration: 2460, page: 1 },
  { bvid: 'BV1mock0003', title: '如何用费曼学习法记住任何知识', upName: '何同学', upMid: 10822885, duration: 965, page: 2 },
  { bvid: 'BV1mock0004', title: '从零实现一个数据库：索引篇', upName: '极客湾Geekerwan', upMid: 14871346, duration: 3120, page: 1 },
  { bvid: 'BV1mock0005', title: '数学之美：傅里叶变换可视化', upName: '影视飓风', upMid: 946974, duration: 728, page: 1 },
  { bvid: 'BV1mock0006', title: '用 100 天学会一门新语言，我做对了什么', upName: '罗翔说刑法', upMid: 517327498, duration: 1544, page: 1 },
]

export async function seedDemoData(): Promise<void> {
  const existing = await db.progress.count()
  if (existing > 0) {
    console.info('[mock] 本地库已有数据，跳过演示数据种入')
    return
  }
  console.info('[mock] 正在种入演示数据（学习进度 / 每日时长 / 习惯 / 专注 / 本地视频 …）')

  const days = recentDays(30)
  const now = Date.now()

  // ---- 学习进度
  const progress: ProgressRecord[] = DEMO_VIDEOS.map((v, i) => {
    const done = i < 3
    const seconds = done ? v.duration : Math.floor(v.duration * (0.15 + i * 0.12))
    return {
      key: `${v.bvid}:${i + 1}`,
      bvid: v.bvid,
      cid: i + 1,
      title: v.title,
      cover: demoCover(v.title, (i * 61) % 360),
      upName: v.upName,
      upMid: v.upMid,
      page: v.page,
      seconds,
      duration: v.duration,
      completed: done,
      updatedAt: now - i * 6 * 3600000,
    }
  })
  await db.progress.bulkPut(progress)

  // ---- 每日学习时长（最近 30 天，有起伏）
  const daily: DailyRecord[] = days.map((date, i) => {
    const base = i > 24 ? 0 : [0, 600, 1200, 1800, 2400, 3600, 4200, 5400][i % 8]
    const seconds = Math.max(0, base + ((i * 137) % 900) - 450)
    return { date, seconds, videos: seconds > 0 ? Math.max(1, Math.round(seconds / 1500)) : 0 }
  })
  // 让「今天/昨天/本周」有像样的数字（学习页的今日时长、连续签到都依赖它）
  daily[daily.length - 1] = { date: days[days.length - 1], seconds: 2460, videos: 2 }
  if (daily.length > 1) daily[daily.length - 2] = { date: days[days.length - 2], seconds: 3300, videos: 3 }
  if (daily.length > 2) daily[daily.length - 3] = { date: days[days.length - 3], seconds: 1800, videos: 2 }
  await db.daily.bulkPut(daily)

  // ---- 打卡记录
  await db.checkins.bulkPut(days.slice(-12).map(d => ({ date: d, at: now })))

  // ---- 按 UP 的时长分布
  const upTime: UpTimeRecord[] = [
    { key: 'mid:14871346', mid: 14871346, name: '极客湾Geekerwan', seconds: 12400 },
    { key: 'mid:517327498', mid: 517327498, name: '罗翔说刑法', seconds: 8600 },
    { key: 'mid:10822885', mid: 10822885, name: '何同学', seconds: 5200 },
    { key: 'mid:37663924', mid: 37663924, name: '硬核的半佛仙人', seconds: 3100 },
  ]
  await db.upTime.bulkPut(upTime)

  // ---- 稍后再看（书架）
  await db.shelf.bulkPut(
    DEMO_VIDEOS.slice(3).map((v, i) => ({
      bvid: v.bvid,
      title: v.title,
      cover: demoCover(v.title, (i * 97) % 360),
      upName: v.upName,
      upMid: v.upMid,
      duration: v.duration,
      at: now - i * 3600000,
    })),
  )

  // ---- UP 管理
  await db.upgroups.bulkPut([
    { name: '学习', at: now },
    { name: '科技', at: now },
  ])
  await db.ups.bulkPut([
    { mid: 14871346, name: '极客湾Geekerwan', face: demoCover('极', 190, 120, 120), sign: '硬核数码评测', fans: 6543210, group: '科技', addedAt: now },
    { mid: 517327498, name: '罗翔说刑法', face: demoCover('罗', 205, 120, 120), sign: '用良知驾驭我们之所学', fans: 9876543, group: '学习', addedAt: now },
    { mid: 10822885, name: '何同学', face: demoCover('何', 12, 120, 120), sign: '我是何同学', fans: 12034567, group: '科技', addedAt: now },
    { mid: 37663924, name: '硬核的半佛仙人', face: demoCover('半', 150, 120, 120), sign: '致力于讲清每一个商业故事', fans: 7654321, group: '学习', addedAt: now },
  ])

  // ---- 本地收藏
  await db.collectfolders.bulkPut([{ name: '学习资料', at: now }])
  const collect: CollectItem[] = DEMO_VIDEOS.slice(0, 4).map((v, i) => ({
    bvid: v.bvid,
    title: v.title,
    cover: demoCover(v.title, (i * 43) % 360),
    upName: v.upName,
    upMid: v.upMid,
    duration: v.duration,
    page: 1,
    folder: i < 2 ? '默认收藏夹' : '学习资料',
    at: now - i * 86400000,
  }))
  await db.collect.bulkPut(collect)

  // ---- 习惯（3 个进行中 + 1 个已归档）
  const habits: Habit[] = [
    { name: '每天阅读 30 分钟', targetDays: 66, remindAt: '21:30', remindOn: true, note: '用微信读书，非虚构类为主', archived: 0, createdAt: now - 40 * 86400000 },
    { name: '刷 LeetCode', targetDays: 100, remindAt: '20:00', remindOn: true, note: '每天至少一道，简单/中等交替', archived: 0, createdAt: now - 26 * 86400000 },
    { name: '背单词', targetDays: 30, remindAt: '07:30', remindOn: false, note: '通勤时间用 Anki', archived: 0, createdAt: now - 18 * 86400000 },
    { name: '晨跑（已归档）', targetDays: 21, remindAt: '06:30', remindOn: false, note: '天气转冷暂停', archived: 1, createdAt: now - 90 * 86400000 },
  ]
  const habitIds: number[] = []
  for (const h of habits) habitIds.push(((await db.habits.add(h)) as number))
  const logs: HabitLog[] = []
  for (let dayIdx = 0; dayIdx < 14; dayIdx++) {
    const date = days[days.length - 1 - dayIdx]
    habitIds.slice(0, 3).forEach((id, i) => {
      // 每个习惯漏打卡几天，形成不同的连续天数
      if (dayIdx === (i + 2)) return
      logs.push({ key: `${id}:${date}`, habitId: id, date, at: now - dayIdx * 86400000, note: '' })
    })
  }
  await db.habitLogs.bulkPut(logs)

  // ---- 专注记录
  const focus: FocusSession[] = []
  for (let i = 0; i < 12; i++) {
    const dayIdx = i % 7
    const date = days[days.length - 1 - dayIdx]
    const startedAt = now - dayIdx * 86400000 - i * 3600000
    focus.push({
      day: date,
      startedAt,
      at: startedAt + 25 * 60000,
      seconds: [1500, 1500, 3000, 2700, 1800][i % 5],
      completed: i % 4 !== 0,
      task: ['阅读', '刷题', '看课', '整理笔记'][i % 4],
      bvid: i % 3 === 0 ? DEMO_VIDEOS[i % DEMO_VIDEOS.length].bvid : null,
      cover: i % 3 === 0 ? demoCover(DEMO_VIDEOS[i % DEMO_VIDEOS.length].title, (i * 71) % 360) : undefined,
      mode: 'countdown',
      focusMin: 25,
    })
  }
  await db.focus.bulkPut(focus)

  // ---- 本地视频
  const locals: LocalVideo[] = ['操作系统导论 第 1 讲.mp4', '线性代数 第 3 讲.mkv', '计算机网络 实验课.mov'].map((name, i) => ({
    id: 'demo-local-' + i,
    path: `/mock/课程视频/${name}`,
    name,
    dir: '/mock/课程视频',
    ext: name.split('.').pop() || 'mp4',
    size: 45 * 1024 * 1024 + i * 12 * 1024 * 1024,
    mtime: now - i * 86400000,
    mime: 'video/mp4',
    url: 'mock://local/' + i,
    addedAt: now - i * 3600000,
    playedAt: i < 2 ? now - i * 7200000 : undefined,
    seconds: i === 0 ? 320 : 0,
    duration: 1500 + i * 600,
  }))
  await db.locals.bulkPut(locals)

  console.info('[mock] 演示数据种入完成：进度 %d / 天数 %d / 习惯 %d / 专注 %d / 本地 %d', progress.length, days.length, habits.length, focus.length, locals.length)
}
