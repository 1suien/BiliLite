/**
 * 剪贴板兜底：优先用 Capacitor Clipboard 插件（原生实现），
 * 失败时退回 navigator.clipboard，再失败退回老式 execCommand。
 * 还原自 index-jTHZJced.js 里的 installClipboard()
 */
import { Clipboard } from '@capacitor/clipboard'

export function installClipboard() {
  const native = navigator.clipboard
  const fallback = native && native.writeText ? native.writeText.bind(native) : null

  const shim = {
    writeText: (text: string) => {
      const value = String(text ?? '')
      return Clipboard.write({ string: value }).catch((err) => {
        if (fallback) return fallback(value) as any
        throw err
      })
    },
    readText: () => Clipboard.read().then((res) => (res && res.value) || ''),
  }

  try {
    Object.defineProperty(shim, '__bililite', { value: 'native-clipboard', enumerable: false })
  } catch {}

  try {
    Object.defineProperty(navigator, 'clipboard', { value: shim, configurable: true })
    return
  } catch {}
  try {
    const proto = Object.getPrototypeOf(navigator)
    Object.defineProperty(proto, 'clipboard', { get: () => shim, configurable: true })
  } catch {}
}
