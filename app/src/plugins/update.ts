/**
 * 软件内更新（0.4.66）：原生插件封装。
 * 浏览器 / mock 环境下没有这个插件，所有调用都会静默跳过。
 */
import { Capacitor, registerPlugin } from '@capacitor/core'

export interface UpdateInfo {
  versionCode: number
  versionName: string
  apk: string
  sha256: string
  size: number
  publishedAt: string
  notes: string[]
}

interface UpdatePluginApi {
  current(): Promise<{ versionCode: number; versionName: string }>
  check(options: { url: string }): Promise<UpdateInfo>
  download(options: { url: string; sha256?: string; name?: string }): Promise<{ path: string; size: number }>
  install(options: { path: string }): Promise<{ needPermission: boolean }>
  addListener(event: 'updateProgress', cb: (p: { received: number; total: number }) => void): Promise<any>
}

const Update = registerPlugin<UpdatePluginApi>('Update')

export function updateNative(): UpdatePluginApi | null {
  return Capacitor.isNativePlatform() ? Update : null
}
