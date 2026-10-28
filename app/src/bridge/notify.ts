/**
 * 系统通知（本机定制 0.4.13，0.4.14 换默认提示音）
 *
 * 应用内已经有右下角提醒卡片（components/ReminderCards.vue），但卡片只在应用前台时能看到。
 * 这里再用 `@capacitor/local-notifications` 把「专注目标 / 习惯 / 课表」的每日提醒交给系统：
 * 到点由 Android 的 AlarmManager 唤醒并弹通知（应用在后台/切走时也能看到，带提示音），
 * 点通知直接跳到对应页面。
 *
 * 0.4.14 的变化：自定义 WAV 提示音在部分 ROM 上会被静音，于是改由原生插件
 * ReminderChannelPlugin 建一个**系统默认提示音**的高优先级通道（bililite-reminders-v2）。
 * 换通道 id 是因为 Android 8+ 通道创建后声音不可改。设置页还有「测试通知 / 通知设置」两个按钮
 * 帮用户当场验证 + 跳到系统通道设置。
 *
 * - 只在原生平台（安卓壳）里生效；浏览器里全部是 no-op，返回 'unsupported'。
 * - 通知 id 固定占用 47000~47039 这一段，同步前先取消这一段里的旧通知，避免重复。
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
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

/** 通道 id 必须和 android/.../ReminderChannelPlugin.java 里的 CHANNEL_ID 一致 */
const CHANNEL_ID = 'bililite-reminders-v2'
const ID_BASE = 47000
const MAX_ITEMS = 40

export const nativeNotifySupported = () => Capacitor.isNativePlatform()

/** 原生插件（app/android/.../ReminderChannelPlugin.java）：建通道 / 测试通知 / 打开通道设置 */
interface ReminderChannelPlugin {
  ensureChannel(): Promise<{ ok: boolean; channelId: string }>
  testNotification(options: { title?: string; body?: string }): Promise<{ ok: boolean }>
  openChannelSettings(): Promise<{ ok: boolean }>
}
const ReminderChannel = registerPlugin<ReminderChannelPlugin>('ReminderChannel')

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
      // 首选：原生插件建「系统默认提示音」的通道（最不容易哑）
      const res = await ReminderChannel.ensureChannel()
      if (!res || !res.ok) throw new Error('ensureChannel failed')
    } catch {
      // 降级：local-notifications 自建通道（没有自定义音效，至少能保证通知能弹）
      try {
        await LocalNotifications.createChannel({
          id: CHANNEL_ID,
          name: '到点提醒',
          description: '专注目标 / 习惯打卡 / 课表的到点提醒',
          importance: 4,
          visibility: 1,
          vibration: true,
          lights: true,
          lightColor: '#FF4D88',
        })
      } catch {
        // 通道已存在时 Android 不允许改设置，忽略即可
      }
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

/** 立刻发一条测试通知（原生插件；浏览器里没有） */
export async function testReminderNotification(title = '测试提醒', body = '能看到这条通知、并且响了一声，就说明提醒设置没问题。') {
  if (!nativeNotifySupported()) return { ok: false, error: 'unsupported' }
  const perm = await ensureNativeNotify()
  if (perm !== 'ok') return { ok: false, error: perm }
  try {
    const res = await ReminderChannel.testNotification({ title, body })
    return { ok: !!res?.ok, error: res?.ok ? '' : 'native-failed' }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/** 打开本 App 的「到点提醒」通道系统设置（Android 8+） */
export async function openReminderChannelSettings() {
  if (!nativeNotifySupported()) return { ok: false, error: 'unsupported' }
  try {
    const res = await ReminderChannel.openChannelSettings()
    return { ok: !!res?.ok, error: res?.ok ? '' : 'native-failed' }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/** 当前提醒通道 id（调试/测试用） */
export const reminderChannelId = () => CHANNEL_ID
