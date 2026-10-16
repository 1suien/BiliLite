/**
 * B 站接口层（`src/main/bili/*`）的平台运行时注入点。
 *
 * 为什么要这一层：这一层代码本身是纯 `fetch` 逻辑，桌面端和安卓端都想直接复用；
 * 但它需要「读 cookie / 存 user / 落盘」这三件事，而桌面端用的是 Electron 版 store
 * （`src/main/store.js`，DPAPI 加密 + userData 下的 JSON），安卓端跑在 WebView 里，
 * 没有 `node:fs` 也没有 `safeStorage`，只能换成另一套实现。
 *
 * 所以这里只暴露一个注入点：
 *   - 桌面端：`src/main/index.js` 启动时 `setBiliStore(store)`
 *   - 安卓端：`src/mobile/store.js` 在 App 启动时 `setBiliStore(store)`
 * 两边的 store 只要满足同一套接口即可（state / persist / patchSettings / setUser /
 * clearAuth / isLoggedIn），接口层的其余代码一行都不用改。
 *
 * 注意：这里刻意不在模块顶层 import 任何一个 store，否则打包安卓端时会把 electron 拖进来。
 */

let current = null

export function setBiliStore(store) {
  current = store
}

export function getBiliStore() {
  if (!current) {
    throw new Error('B 站接口层还没拿到 store：请先在启动时调用 setBiliStore(store)')
  }
  return current
}

/**
 * 给 `src/main/bili/*` 用的稳定代理。
 * 接口层里到处是 `store.state.cookies[...] = x` 这种写法，代理能把属性读写和
 * 方法调用都转到「当前注入的那个 store」上，于是各文件的改动只有一行 import。
 */
export function storeProxy() {
  return new Proxy(
    {},
    {
      get(_target, key) {
        const s = getBiliStore()
        const value = s[key]
        return typeof value === 'function' ? value.bind(s) : value
      },
      set(_target, key, value) {
        getBiliStore()[key] = value
        return true
      },
      has(_target, key) {
        return key in getBiliStore()
      }
    }
  )
}
