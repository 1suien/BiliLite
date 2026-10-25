/**
 * 全局 UI 状态：toast、登录弹窗、确认弹窗、全局刷新信号
 * 还原自 ui-62PUwwoT.js
 */
import { defineStore } from 'pinia'

export type ToastType = 'info' | 'ok' | 'err'

export interface ToastItem {
  id: number
  message: string
  type: ToastType
}

export interface ConfirmState {
  open: boolean
  title: string
  sub: string
  okText: string
}

let seq = 0

export const useUiStore = defineStore('ui', {
  state: () => ({
    toasts: [] as ToastItem[],
    loginOpen: false,
    /** 自增序号：页面 watch 它来触发「全局刷新」 */
    refreshSeq: 0,
    confirmState: { open: false, title: '', sub: '', okText: '确定' } as ConfirmState,
    _confirmResolve: null as null | ((v: boolean) => void),
  }),
  actions: {
    refresh() {
      this.refreshSeq += 1
    },
    toast(message: any, type: ToastType = 'info', timeout = 2600) {
      const id = ++seq
      this.toasts.push({ id, message: String(message), type })
      setTimeout(() => this.dismiss(id), timeout)
      return id
    },
    ok(message: any) {
      return this.toast(message, 'ok')
    },
    err(message: any) {
      return this.toast(message, 'err', 4200)
    },
    dismiss(id: number) {
      const i = this.toasts.findIndex((t) => t.id === id)
      if (i >= 0) this.toasts.splice(i, 1)
    },
    askLogin() {
      this.loginOpen = true
    },
    confirm(title: any, sub = '', okText = '确定') {
      return new Promise<boolean>((resolve) => {
        this.confirmState = { open: true, title: String(title), sub: String(sub), okText }
        this._confirmResolve = resolve
      })
    },
    answerConfirm(value: boolean) {
      const resolve = this._confirmResolve
      this._confirmResolve = null
      this.confirmState = { open: false, title: '', sub: '', okText: '确定' }
      resolve && resolve(!!value)
    },
  },
})
