import { defineStore } from 'pinia'
import api from '../api'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    ready: false,
    user: null,
    qr: {
      url: '',
      key: '',
      status: 'idle', // idle | waiting | scanned | expired | success | error
      message: ''
    },
    polling: false
  }),
  getters: {
    loggedIn: (s) => Boolean(s.user && s.user.mid),
    avatar: (s) => (s.user && s.user.face) || ''
  },
  actions: {
    async restore() {
      try {
        const res = await api.auth.restore()
        this.user = res.user || null
      } catch {
        this.user = null
      }
      this.ready = true
      return this.user
    },
    async logout() {
      try {
        await api.auth.logout()
      } catch {
        /* 即使远端退出失败也清内存态 */
      }
      this.user = null
      this.qr = { url: '', key: '', status: 'idle', message: '' }
    },
    async startQr() {
      this.qr = { url: '', key: '', status: 'loading', message: '正在生成二维码…' }
      try {
        const data = await api.auth.qrGenerate()
        this.qr = { url: data.url, key: data.qrcodeKey, status: 'waiting', message: '请用 B 站 App 扫码' }
        this.poll()
      } catch (err) {
        this.qr = { url: '', key: '', status: 'error', message: err.message || '二维码生成失败' }
      }
    },
    stopPoll() {
      this.polling = false
    },
    async poll() {
      if (this.polling) return
      this.polling = true
      const key = this.qr.key
      while (this.polling && this.qr.key === key && this.qr.status !== 'success') {
        await new Promise((r) => setTimeout(r, 2200))
        if (!this.polling || this.qr.key !== key) break
        try {
          const res = await api.auth.qrPoll(key)
          this.qr.status = res.status
          if (res.status === 'scanned') this.qr.message = '已扫码，请在手机上确认'
          if (res.status === 'expired') {
            this.qr.message = '二维码已过期，请刷新'
            break
          }
          if (res.status === 'success') {
            this.user = res.user || null
            this.qr.message = '登录成功'
            break
          }
        } catch (err) {
          this.qr.status = 'error'
          this.qr.message = err.message || '轮询失败'
          break
        }
      }
      this.polling = false
    }
  }
})
