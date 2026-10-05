<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import BiliImage from '../components/BiliImage.vue'
import EmptyBlock from '../components/EmptyBlock.vue'
import Icon from '../components/Icon.vue'
import { useAuthStore } from '../stores/auth'
import { useUiStore } from '../stores/ui'

const router = useRouter()
const auth = useAuthStore()
const ui = useUiStore()

const loading = ref(false)
const created = ref([])
const collected = ref([])
const errorMsg = ref('')

const total = computed(() => created.value.length + collected.value.length)

async function load() {
  if (!auth.loggedIn) return
  loading.value = true
  errorMsg.value = ''
  try {
    const data = await api.fav.folders()
    created.value = data.created
    collected.value = data.collected
  } catch (err) {
    errorMsg.value = err.message || '收藏夹加载失败'
    if (err.needLogin) ui.askLogin()
  } finally {
    loading.value = false
  }
}

function open(f) {
  router.push({ name: 'fav-folder', params: { mediaId: String(f.id) } })
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-head">
      <h1>收藏夹</h1>
      <p v-if="auth.loggedIn">共 {{ total }} 个收藏夹 · {{ auth.user.uname }}</p>
      <p v-else>需要登录后读取 B 站收藏夹</p>
      <span class="grow" />
      <button v-if="auth.loggedIn" class="btn sm" :disabled="loading" @click="load">
        <Icon name="refresh" :size="14" /> 刷新
      </button>
      <button v-else class="btn sm primary" @click="ui.loginOpen = true"><Icon name="user" :size="14" /> 扫码登录</button>
    </div>

    <EmptyBlock
      v-if="!auth.loggedIn"
      icon="star"
      title="登录后可以读收藏夹"
      desc="收藏夹接口必须带账号凭证。登录凭证只保存在本机，用于读取你自己的收藏内容。"
    >
      <button class="btn primary" @click="ui.loginOpen = true">扫码登录</button>
    </EmptyBlock>

    <div v-else-if="errorMsg" class="panel" style="color: var(--danger)">{{ errorMsg }}</div>

    <div v-else-if="loading && !total" class="panel row" style="gap: 10px">
      <span class="spinner" /><span class="dim">正在读取收藏夹…</span>
    </div>

    <EmptyBlock v-else-if="!total" icon="star" title="还没有收藏夹" desc="在 B 站网页端建立收藏夹后，这里会同步显示。" />

    <template v-else>
      <h2 style="font-size: 14px; margin: 6px 0 12px">我创建的（{{ created.length }}）</h2>
      <div class="grid">
        <div v-for="f in created" :key="f.id" class="vcard" @click="open(f)">
          <div class="thumb">
            <BiliImage :src="f.cover" :alt="f.title" />
          </div>
          <div class="meta">
            <div class="title clamp-1">{{ f.title }}</div>
            <div class="sub"><span class="muted">{{ f.mediaCount }} 个内容</span></div>
          </div>
        </div>
      </div>

      <template v-if="collected.length">
        <h2 style="font-size: 14px; margin: 22px 0 12px">我收藏的（{{ collected.length }}）</h2>
        <div class="grid">
          <div v-for="f in collected" :key="f.id" class="vcard" @click="open(f)">
            <div class="thumb">
              <BiliImage :src="f.cover" :alt="f.title" />
            </div>
            <div class="meta">
              <div class="title clamp-1">{{ f.title }}</div>
              <div class="sub"><span class="muted">{{ f.mediaCount }} 个内容 · 来自 UP {{ f.mid }}</span></div>
            </div>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>
