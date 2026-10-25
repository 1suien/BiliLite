<script setup lang="ts">
/**
 * 扫码登录弹窗
 * 还原自 main-CoY7YGNA.js 里的 LoginModal 组件（__name: "LoginModal"）
 *
 * 二维码由 auth.startQr() 生成（auth 里统一轮询 qrPoll，状态写在 auth.qr.status/message），
 * 这里只负责把 auth.qr.url 画到 canvas 上（用 npm 的 `qrcode`，原 APK 内联了同一套库）。
 */
import { onUnmounted, ref, watch } from 'vue'
import { toCanvas } from 'qrcode'
import Icon from '@/components/Icon.vue'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'

const auth = useAuthStore()
const ui = useUiStore()

const canvas = ref<HTMLCanvasElement | null>(null)
/** 正在生成/刷新二维码（按钮禁用 + 占位转圈） */
const busy = ref(false)

/** 把二维码画到 canvas；尺寸/留白/纠错级别与 APK 一致 */
async function render(url: string) {
  if (!canvas.value || !url) return
  try {
    await toCanvas(canvas.value, url, {
      width: 176,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    })
  } catch {
    // 画失败就当没画（url 无效时 qrcode 会抛），状态文案由 auth.qr.message 兜底
  }
}

watch(
  () => auth.qr.url,
  (url) => render(url),
)

// 登录成功：提示 + 700ms 后关闭
watch(
  () => auth.qr.status,
  (status) => {
    if (status !== 'success') return
    busy.value = false
    ui.ok(`已登录：${auth.user ? auth.user.uname : ''}`)
    setTimeout(() => close(), 700)
  },
)

/** 刷新二维码（过期后重扫） */
async function refresh() {
  busy.value = true
  await auth.startQr()
  busy.value = false
  await render(auth.qr.url)
}

/**
 * APK 里打开弹窗时并不自动生成二维码（只显示「二维码不可用」，要手动点「刷新二维码」）。
 * 这里在打开时自动生成一张新码，体验更顺；「刷新二维码」按钮仍然保留用于过期重扫。
 * 若要严格 1:1 复刻，删掉下面这个 watch 即可。
 */
watch(
  () => ui.loginOpen,
  (open) => {
    if (!open) return
    // 已经在生成/等扫码的不要重新生成；其余状态都换一张新码
    if (['loading', 'waiting', 'scanned'].includes(auth.qr.status)) return
    refresh()
  },
  { immediate: true },
)

/** 关闭：停轮询 + 收弹窗 */
function close() {
  auth.stopPoll()
  ui.loginOpen = false
}

onUnmounted(() => auth.stopPoll())
</script>

<template>
  <div v-if="ui.loginOpen" class="overlay" @click.self="close">
    <div class="modal">
      <div class="row">
        <h3 class="grow">扫码登录</h3>
        <button class="btn ghost sm" title="关闭" @click="close">
          <Icon name="x" :size="15" />
        </button>
      </div>
      <div class="qr-wrap">
        <canvas v-show="auth.qr.url" ref="canvas" width="176" height="176"></canvas>
        <div
          v-if="!auth.qr.url"
          style="width: 176px; height: 176px; display: grid; place-items: center; color: #666"
        >
          <div
            v-if="busy"
            class="spinner"
            style="border-color: #ddd; border-top-color: #222"
          ></div>
          <span v-else style="font-size: 12px">二维码不可用</span>
        </div>
      </div>
      <div class="qr-state">{{ auth.qr.message || '请用 B 站 App 扫描二维码' }}</div>
      <div class="row">
        <button
          class="btn sm"
          :disabled="busy || auth.qr.status === 'success'"
          @click="refresh"
        >
          <Icon name="refresh" :size="14" /> 刷新二维码
        </button>
        <span class="grow"></span>
        <button class="btn ghost sm" @click="close">取消</button>
      </div>
      <p class="muted" style="margin: 0; font-size: 11.5px; line-height: 1.6">
        登录即代表同意仅用于个人学习用途；登录凭证只加密保存在本机，不会上传到任何第三方服务器。
        未登录也可以搜索、看推荐与 360P 播放。
      </p>
    </div>
  </div>
</template>
