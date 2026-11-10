/**
 * 软件内更新状态（0.4.66）
 *
 * 流程：启动 8 秒后静默检查一次 → 有新版显示底部更新条 → 下载（进度）→ 校验 sha256 → 拉起系统安装器。
 * 频控：每 24h 最多自动检查一次；「稍后」24h 内不再弹；「忽略此版本」该版本不再弹。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { updateNative, type UpdateInfo } from '@/plugins/update'

const SOURCE_KEY = 'study-bili-update-source'
const LAST_KEY = 'study-bili-update-last'
const SKIP_KEY = 'study-bili-update-skip'
const AUTO_KEY = 'study-bili-update-auto'

/** 默认更新源：本机 dsh web 的 /dl 路由（出包就在这台设备上） */
export const DEFAULT_UPDATE_SOURCE = 'http://127.0.0.1:3080/dl/update.json'
const DAY = 24 * 60 * 60 * 1000

export const useUpdateStore = defineStore('update', () => {
  const current = ref('')
  const currentCode = ref(0)
  const latest = ref<UpdateInfo | null>(null)
  const checking = ref(false)
  const downloading = ref(false)
  const progress = ref({ received: 0, total: 0 })
  const error = ref('')
  const visible = ref(false)
  const source = ref(localStorage.getItem(SOURCE_KEY) || DEFAULT_UPDATE_SOURCE)
  const auto = ref(localStorage.getItem(AUTO_KEY) !== '0')
  let started = false

  function saveSource(v: string) {
    source.value = v.trim() || DEFAULT_UPDATE_SOURCE
    localStorage.setItem(SOURCE_KEY, source.value)
  }

  function setAuto(v: boolean) {
    auto.value = v
    localStorage.setItem(AUTO_KEY, v ? '1' : '0')
  }

  async function loadCurrent() {
    const nat = updateNative()
    if (!nat) return
    try {
      const info = await nat.current()
      current.value = info.versionName
      currentCode.value = info.versionCode
    } catch {}
  }

  /** 手动/自动检查；返回是否有新版本 */
  async function check(force = false): Promise<boolean> {
    const nat = updateNative()
    if (!nat) return false
    if (!currentCode.value) await loadCurrent()
    if (checking.value) return !!latest.value
    if (!force) {
      const last = Number(localStorage.getItem(LAST_KEY) || 0)
      if (Date.now() - last < DAY) return false
    }
    checking.value = true
    error.value = ''
    try {
      const info = (await nat.check({ url: source.value })) as UpdateInfo
      localStorage.setItem(LAST_KEY, String(Date.now()))
      if (!info || !info.versionCode) return false
      const skip = Number(localStorage.getItem(SKIP_KEY) || 0)
      if (info.versionCode <= currentCode.value || info.versionCode === skip) {
        latest.value = null
        visible.value = false
        return false
      }
      latest.value = info
      visible.value = true
      return true
    } catch (e: any) {
      error.value = String((e && e.message) || e)
      return false
    } finally {
      checking.value = false
    }
  }

  async function downloadAndInstall() {
    const nat = updateNative()
    if (!nat || !latest.value || downloading.value) return
    downloading.value = true
    error.value = ''
    progress.value = { received: 0, total: latest.value.size || 0 }
    let remove: any = null
    try {
      remove = await nat.addListener('updateProgress', (p) => {
        progress.value = { received: p.received || 0, total: p.total || progress.value.total }
      })
      const apk = await nat.download({
        url: latest.value.apk,
        sha256: latest.value.sha256,
        name: `BiliLite-${latest.value.versionName}.apk`,
      })
      const r = await nat.install({ path: apk.path })
      if (r && r.needPermission) {
        error.value = '请在系统设置里允许「安装未知应用」，再点一次更新'
      } else {
        visible.value = false
      }
    } catch (e: any) {
      error.value = String((e && e.message) || e)
    } finally {
      try {
        remove && remove.remove && remove.remove()
      } catch {}
      downloading.value = false
    }
  }

  function later() {
    visible.value = false
  }

  function skip() {
    if (latest.value) localStorage.setItem(SKIP_KEY, String(latest.value.versionCode))
    visible.value = false
  }

  /** App 挂载后调用：8 秒后自动检查（不抢开屏/首屏时间），之后交给 24h 频控 */
  function init() {
    if (started) return
    started = true
    loadCurrent().catch(() => {})
    if (!auto.value) return
    window.setTimeout(() => {
      check(false).catch(() => {})
    }, 8000)
  }

  return {
    current,
    currentCode,
    latest,
    checking,
    downloading,
    progress,
    error,
    visible,
    source,
    auto,
    init,
    check,
    loadCurrent,
    downloadAndInstall,
    later,
    skip,
    saveSource,
    setAuto,
  }
})
