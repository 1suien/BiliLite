<script setup lang="ts">
/**
 * 底部「发现新版本」更新条（0.4.66）
 * - 有新版本才出现；可「稍后」「忽略此版本」
 * - 点「立即更新」→ 原生下载（进度）+ sha256 校验 + 拉起系统安装器
 */
import { computed } from 'vue'
import { useUpdateStore } from '@/stores/update'

const st = useUpdateStore()

const percent = computed(() => {
  const { received, total } = st.progress
  if (!total) return 0
  return Math.min(100, Math.round((received / total) * 100))
})

function sizeText(n: number) {
  if (!n) return '0 MB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

const progressText = computed(() => {
  const { received, total } = st.progress
  return `下载中 ${percent.value}% · ${sizeText(received)}/${sizeText(total || st.latest?.size || 0)}`
})
</script>

<template>
  <div v-if="st.visible && st.latest" class="update-bar">
    <div class="ub-ico">⬇</div>
    <div class="ub-main">
      <div class="ub-title">
        发现新版本 <b>{{ st.latest.versionName }}</b>
        <span class="ub-cur">当前 {{ st.current || '—' }}</span>
      </div>
      <div class="ub-notes">
        <span v-for="(n, i) in (st.latest.notes || []).slice(0, 3)" :key="i" class="ub-note">{{ n }}</span>
      </div>
      <div v-if="st.error" class="ub-err">{{ st.error }}</div>
    </div>
    <div v-if="st.downloading" class="ub-prog">
      <div class="ub-prog-bar"><i :style="{ width: percent + '%' }" /></div>
      <span class="ub-prog-text">{{ progressText }}</span>
    </div>
    <template v-else>
      <button class="btn sm primary" @click="st.downloadAndInstall()">立即更新</button>
      <button class="btn sm ghost" @click="st.later()">稍后</button>
      <button class="btn sm ghost" title="这个版本不再提示" @click="st.skip()">忽略此版本</button>
    </template>
  </div>
</template>
