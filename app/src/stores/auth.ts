/**
 * 登录态：二维码登录、登录态恢复、退出
 * 还原自 auth-xc-Bm95F.js
 */
import { defineStore } from 'pinia'
import { bili } from '@/bridge'
import type { User } from '@/types'

export interface QrState {
  url: string
  key: string
  status: 'idle' | 'loading' | 'waiting' | 'scanned' | 'expired' | 'success' | 'error'
  message: string
}

const EMPTY_QR: QrState = { url: '', key: '', status: 'idle', message: '' }

export const useAuthStore = defineStore('auth', {
  state: () => ({
    ready: false,
    user: null as User | null,
    qr: { ...EMPTY_QR } as QrState,
    polling: false,
  }),
  getters: {
    loggedIn: (s) => !!(s.user && s.user.mid),
    avatar: (s) => (s.user && s.user.face) || '',
  },
  actions: {
    async restore() {
      try {
        const res = await bili.auth.restore()
        this.user = res.user || null
      } catch {
        this.user = null
      }
      this.ready = true
      return this.user
    },
    async logout() {
      try {
        await bili.auth.logout()
      } catch {}
      this.user = null
      this.qr = { ...EMPTY_QR }
    },
    async startQr() {
      this.qr = { url: '', key: '', status: 'loading', message: '正在生成二维码…' }
      try {
        const res = await bili.auth.qrGenerate()
        this.qr = { url: res.url, key: res.qrcodeKey, status: 'waiting', message: '请用 B 站 App 扫码' }
        this.poll()
      } catch (e: any) {
        this.qr = { url: '', key: '', status: 'error', message: e.message || '二维码生成失败' }
      }
    },
    stopPoll() {
      this.polling = false
    },
    async poll() {
      if (this.polling) return
      this.polling = true
      const key = this.qr.key
      // 每 2.2s 轮询一次；二维码被替换/关闭时自动退出
      while (
        this.polling &&
        this.qr.key === key &&
        this.qr.status !== 'success' &&
        (await new Promise((r) => setTimeout(r, 2200)), !(!this.polling || this.qr.key !== key))
      ) {
        try {
          const res = await bili.auth.qrPoll(key)
          this.qr.status = res.status
          if (res.status === 'scanned') this.qr.message = '已扫码，请在手机上确认'
          if (res.status === 'expired') {
            this.qr.message = '二维码已过期，请刷新'
            break
          }
          if (res.status === 'success') {
            this.user = res.user || null
            this.qr.message = '登录成功'
            if (!this.user) {
              try {
                await this.restore()
              } catch {}
            }
            break
          }
        } catch (e: any) {
          this.qr.status = 'error'
          this.qr.message = e.message || '轮询失败'
          break
        }
      }
      this.polling = false
    },
  },
})
