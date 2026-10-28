/**
 * 系统通知（本机定制 0.4.13）
 *
 * 应用内已经有右下角提醒卡片（components/ReminderCards.vue），但卡片只在应用前台时能看到。
 * 这里再用 `@capacitor/local-notifications` 把「专注目标 / 习惯 / 课表」的每日提醒交给系统：
 * 到点由 Android 的 AlarmManager 唤醒并弹通知（应用在后台/切走时也能看到，带提示音），
 * 点通知直接跳到对应页面。
 *
 * - 只在原生平台（安卓壳）里生效；浏览器里全部是 no-op，返回 'unsupported'。
 * - 通知 id 固定占用 47000~47039 这一段，同步前先取消这一段里的旧通知，避免重复。
 * - 通道 importance=4（HIGH）才会在屏幕上方弹出横幅；声音用 res/raw/bililite_reminder.wav。
 */
import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'

export interface NativeReminderItem {
  /** 稳定 key，用来算通知 id（同一类提醒每天只有一条，id 固定不漂移） */
  key: string
  hour: number
  minute: number
  title: string
  body: string
  /** 点通知后要跳的 hash 路由，如 `/learn`、`/habit?h=3`、`/video/BVxxx` */
  path?: string
  /** 一次性提醒（课表用）：给了日期就只在那一时刻响一次；不给就是每天重复 */
  date?: { year: number; month: number; day: number }
}

const CHANNEL_ID = 'bililite-reminders'
const SOUND = 'bililite_reminder.wav'
const ID_BASE = 47000
const MAX_ITEMS = 40

export const nativeNotifySupported = () => Capacitor.isNativePlatform()

function idFor(index: number) {
  return ID_BASE + index
}

/** 申请通知权限 + 建带声音的高优先级通道；返回 'ok' / 'denied' / 'unsupported' / 'error:…' */
export async function ensureNativeNotify(): Promise<string> {
  if (!nativeNotifySupported()) return 'unsupported'
  try {
    let display = (await LocalNotifications.checkPermissions()).display
    if (display !== 'granted') {
      display = (await LocalNotifications.requestPermissions()).display
    }
    if (display !== 'granted') return 'denied'
    try {
      await LocalNotifications.createChannel({
        id: CHANNEL_ID,
        name: '到点提醒',
        description: '专注目标 / 习惯打卡 / 课表的到点提醒（带提示音）',
        importance: 4,
        visibility: 1,
        vibration: true,
        lights: true,
        lightColor: '#FF4D88',
        sound: SOUND,
      })
    } catch {
      // 通道已存在时 Android 不允许改设置，忽略即可
    }
    return 'ok'
  } catch (e: any) {
    return 'error:' + (e?.message || String(e))
  }
}

/** 把「每日到点提醒」整表同步给系统（先取消自己那一段旧通知，再重新排） */
export async function syncNativeReminders(
  items: NativeReminderItem[],
): Promise<{ ok: boolean; scheduled: number; error?: string }> {
  if (!nativeNotifySupported()) return { ok: false, scheduled: 0, error: 'unsupported' }
  const perm = await ensureNativeNotify()
  if (perm !== 'ok') return { ok: false, scheduled: 0, error: perm }
  try {
    const pending = await LocalNotifications.getPending()
    const ours = pending.notifications
      .filter((n) => n.id >= ID_BASE && n.id < ID_BASE + MAX_ITEMS)
      .map((n) => ({ id: n.id }))
    if (ours.length) await LocalNotifications.cancel({ notifications: ours })

    const list = items
      .slice(0, MAX_ITEMS)
      .map((it, index) => {
        const hour = Math.max(0, Math.min(23, it.hour))
        const minute = Math.max(0, Math.min(59, it.minute))
        const on: any = it.date
          ? { year: it.date.year, month: it.date.month, day: it.date.day, hour, minute, second: 0 }
          : { hour, minute, second: 0 }
        return {
          id: idFor(index),
          title: it.title,
          body: it.body,
          channelId: CHANNEL_ID,
          sound: SOUND,
          schedule: it.date
            ? { at: undefined, on, allowWhileIdle: true }
            : { on, repeats: true, allowWhileIdle: true },
          extra: { path: it.path || '/learn', key: it.key },
        }
      })
    if (!list.length) return { ok: true, scheduled: 0 }
    await LocalNotifications.schedule({ notifications: list })
    return { ok: true, scheduled: list.length }
  } catch (e: any) {
    return { ok: false, scheduled: 0, error: e?.message || String(e) }
  }
}

/** 取消本应用排的全部到点提醒 */
export async function clearNativeReminders(): Promise<boolean> {
  if (!nativeNotifySupported()) return false
  try {
    const pending = await LocalNotifications.getPending()
    const ours = pending.notifications
      .filter((n) => n.id >= ID_BASE && n.id < ID_BASE + MAX_ITEMS)
      .map((n) => ({ id: n.id }))
    if (ours.length) await LocalNotifications.cancel({ notifications: ours })
    return true
  } catch {
    return false
  }
}

/** 当前系统里排了多少条本应用的到点提醒（调试/测试用） */
export async function nativePendingCount(): Promise<number> {
  if (!nativeNotifySupported()) return 0
  try {
    const pending = await LocalNotifications.getPending()
    return pending.notifications.filter((n) => n.id >= ID_BASE && n.id < ID_BASE + MAX_ITEMS).length
  } catch {
    return 0
  }
}
