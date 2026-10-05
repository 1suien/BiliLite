import { defineStore } from 'pinia'

let seq = 0

export const useUiStore = defineStore('ui', {
  state: () => ({
    toasts: [],
    /** 登录弹层开关，放在全局，任何页面都能唤起 */
    loginOpen: false,
    confirmState: { open: false, title: '', sub: '', okText: '确定' },
    _confirmResolve: null
  }),
  actions: {
    toast(message, type = 'info', ms = 2600) {
      const id = ++seq
      this.toasts.push({ id, message: String(message), type })
      setTimeout(() => this.dismiss(id), ms)
      return id
    },
    ok(message) {
      return this.toast(message, 'ok')
    },
    err(message) {
      return this.toast(message, 'err', 4200)
    },
    dismiss(id) {
      const i = this.toasts.findIndex((t) => t.id === id)
      if (i >= 0) this.toasts.splice(i, 1)
    },
    askLogin() {
      this.loginOpen = true
    },
    /** 全局确认框：返回 Promise<boolean> */
    confirm(title, sub = '', okText = '确定') {
      return new Promise((resolve) => {
        this.confirmState = { open: true, title: String(title), sub: String(sub), okText }
        this._confirmResolve = resolve
      })
    },
    answerConfirm(value) {
      const fn = this._confirmResolve
      this._confirmResolve = null
      this.confirmState = { open: false, title: '', sub: '', okText: '确定' }
      if (fn) fn(Boolean(value))
    }
  }
})
