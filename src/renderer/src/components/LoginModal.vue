<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'
import QRCode from 'qrcode'
import { useAuthStore } from '../stores/auth'
import { useUiStore } from '../stores/ui'
import Icon from './Icon.vue'

const auth = useAuthStore()
const ui = useUiStore()
const canvas = ref(null)
const busy = ref(false)

async function draw(url) {
  if (!canvas.value || !url) return
  try {
    await QRCode.toCanvas(canvas.value, url, {
      width: 176,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' }
    })
  } catch {
    /* 渲染失败时下方文案仍会给出提示 */
  }
}

watch(
  () => auth.qr.url,
  (url) => draw(url)
)

watch(
  () => auth.qr.status,
  (s) => {
    if (s === 'success') {
      busy.value = false
      ui.ok(`已登录：${auth.user ? auth.user.uname : ''}`)
      setTimeout(() => close(), 700)
    }
  }
)

function open() {
  ui.loginOpen = true
  if (auth.qr.status === 'idle' || auth.qr.status === 'error' || auth.qr.status === 'expired') {
    start()
  } else if (auth.qr.url) {
    draw(auth.qr.url)
  }
}

async function start() {
  busy.value = true
  await auth.startQr()
  busy.value = false
  await draw(auth.qr.url)
}

function close() {
  auth.stopPoll()
  ui.loginOpen = false
}

onBeforeUnmount(() => auth.stopPoll())
</script>

<template>
  <div v-if="ui.loginOpen" class="overlay" @click.self="close">
    <div class="modal">
      <div class="row">
        <h3 class="grow">扫码登录</h3>
        <button class="btn ghost sm" title="关闭" @click="close"><Icon name="x" :size="15" /></button>
      </div>

      <div class="qr-wrap">
        <canvas v-show="auth.qr.url" ref="canvas" width="176" height="176" />
        <div
          v-if="!auth.qr.url"
          style="width: 176px; height: 176px; display: grid; place-items: center; color: #666"
        >
          <div v-if="busy" class="spinner" style="border-color: #ddd; border-top-color: #222" />
          <span v-else style="font-size: 12px">二维码不可用</span>
        </div>
      </div>

      <div class="qr-state">{{ auth.qr.message || '请用 B 站 App 扫描二维码' }}</div>

      <div class="row">
        <button class="btn sm" :disabled="busy || auth.qr.status === 'success'" @click="start">
          <Icon name="refresh" :size="14" /> 刷新二维码
        </button>
        <span class="grow" />
        <button class="btn ghost sm" @click="close">取消</button>
      </div>

      <p class="muted" style="margin: 0; font-size: 11.5px; line-height: 1.6">
        登录即代表同意仅用于个人学习用途；登录凭证只加密保存在本机，不会上传到任何第三方服务器。
        未登录也可以搜索、看推荐与 360P 播放。
      </p>
    </div>
  </div>
</template>
