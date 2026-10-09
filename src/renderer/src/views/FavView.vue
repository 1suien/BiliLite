<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import BiliImage from '../components/BiliImage.vue'
import EmptyBlock from '../components/EmptyBlock.vue'
import Icon from '../components/Icon.vue'
import { useAuthStore } from '../stores/auth'
import { useCollectStore } from '../stores/collect'
import { useUiStore } from '../stores/ui'
import { fmtDate, fmtDuration } from '../utils/format'

const router = useRouter()
const auth = useAuthStore()
const collect = useCollectStore()
const ui = useUiStore()

/** 'local' = BiliLite 本机收藏，'bili' = B 站账户收藏 */
const tab = ref('local')

const loading = ref(false)
const created = ref([])
const collected = ref([])
const errorMsg = ref('')
const newFolder = ref('')

const total = computed(() => created.value.length + collected.value.length)
const localItems = computed(() => collect.filtered)

async function loadBili() {
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

function openVideo(it) {
  router.push({ name: 'video', params: { bvid: it.bvid } })
}

async function createFolder() {
  const name = newFolder.value.trim()
  if (!name) return
  try {
    await collect.createFolder(name)
    newFolder.value = ''
    ui.ok(`已新建文件夹：${name}`)
  } catch (err) {
    ui.err(err.message)
  }
}

async function dropFolder(name) {
  const n = collect.items.filter((x) => x.folder === name).length
  const okToGo = await ui.confirm('删除文件夹？', n ? `「${name}」里的 ${n} 个视频会移到「默认收藏夹」` : `「${name}」还是空的`, '删除')
  if (!okToGo) return
  try {
    await collect.removeFolder(name)
    ui.ok('文件夹已删除')
  } catch (err) {
    ui.err(err.message)
  }
}

async function removeItem(it) {
  const okToGo = await ui.confirm('移出收藏？', it.title, '移出')
  if (!okToGo) return
  await collect.removeItem(it.id)
  ui.ok('已移出本机收藏')
}

function switchTab(next) {
  tab.value = next
  if (next === 'bili' && auth.loggedIn && !total.value) loadBili()
}

onMounted(async () => {
  await collect.init()
  if (auth.loggedIn) loadBili()
})
</script>

<template>
  <div>
    <div class="page-head">
      <h1>收藏</h1>
      <div class="row" style="margin-left: 4px">
        <span class="chip" :class="{ on: tab === 'local' }" @click="switchTab('local')">
          <Icon name="star" :size="13" /> 本机收藏 {{ collect.count }}
        </span>
        <span class="chip" :class="{ on: tab === 'bili' }" @click="switchTab('bili')">
          <Icon name="folder" :size="13" /> B站账户收藏 {{ total }}
        </span>
      </div>
      <span class="grow" />
      <button v-if="tab === 'bili'" class="btn sm" :disabled="loading" @click="loadBili">
        <Icon name="refresh" :size="14" /> 刷新
      </button>
    </div>

    <!-- ── 本机收藏 ─────────────────────────────── -->
    <div v-if="tab === 'local'" class="fav-layout">
      <aside class="folders">
        <div class="fd-head">文件夹</div>
        <div class="row">
          <input v-model="newFolder" class="input" placeholder="新建文件夹" @keyup.enter="createFolder" />
          <button class="btn fav-add" title="新建文件夹" aria-label="新建文件夹" @click="createFolder">
            <Icon name="plus" :size="15" />
          </button>
        </div>
        <div
          v-for="f in collect.folderList"
          :key="f.name"
          class="fold"
          :class="{ on: collect.activeFolder === f.name }"
          @click="collect.activeFolder = f.name"
        >
          <Icon name="folder" :size="15" />
          <span class="grow clamp-1">{{ f.name }}</span>
          <span class="n mono">{{ f.n }}</span>
          <button v-if="f.deletable" class="icon-btn" title="删除文件夹" @click.stop="dropFolder(f.name)">
            <Icon name="trash" :size="13" />
          </button>
        </div>
      </aside>

      <section style="min-width: 0">
        <div class="page-head" style="margin-bottom: 12px">
          <h2 style="font-size: 15px; margin: 0">
            {{ collect.activeFolder }}
            <span class="muted" style="font-size: 12.5px; font-weight: 400">{{ localItems.length }} 个视频</span>
          </h2>
        </div>
        <EmptyBlock
          v-if="!collect.count"
          icon="star"
          title="本机收藏还是空的"
          desc="在播放页点「收藏」，就能把视频存到本机的文件夹里，不依赖 B 站账号。"
        />
        <EmptyBlock v-else-if="!localItems.length" icon="folder" title="这个文件夹是空的" desc="在播放页收藏时选择这个文件夹即可。" />
        <div v-else class="grid">
          <div v-for="it in localItems" :key="it.id" class="vcard" @click="openVideo(it)">
            <div class="thumb">
              <BiliImage :src="it.cover" :alt="it.title" />
              <span v-if="it.duration" class="dur">{{ fmtDuration(it.duration) }}</span>
            </div>
            <div class="meta">
              <div class="title clamp-2">{{ it.title }}</div>
              <div class="sub">
                <span class="muted">{{ fmtDate(it.at) }}</span>
                <span v-if="it.upName" class="up" @click.stop="router.push({ name: 'up', params: { mid: String(it.upMid) } })">
                  {{ it.upName }}
                </span>
              </div>
            </div>
            <button class="del" title="移出收藏" @click.stop="removeItem(it)"><Icon name="trash" :size="14" /></button>
          </div>
        </div>
      </section>
    </div>

    <!-- ── B 站账户收藏 ─────────────────────────── -->
    <template v-else>
      <EmptyBlock
        v-if="!auth.loggedIn"
        icon="star"
        title="登录后可以读 B 站收藏夹"
        desc="收藏夹接口必须带账号凭证。登录凭证只加密保存在本机，用于读取你自己的收藏内容。"
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
    </template>
  </div>
</template>

<style scoped>
.fav-layout {
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
.folders {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.fd-head {
  font-size: 12.5px;
  color: var(--t3);
  padding: 0 2px 2px;
}
.fold {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13px;
  transition: border-color 0.13s, background 0.13s, color 0.13s;
}
.fold:hover {
  background: var(--card-hover);
}
/* 选中的文件夹：品牌底色 + 左侧色条 + 图标染色 —— 跟侧栏「当前页」用同一套语言。
   原来只有 border-color: var(--accent)（纯白）+ 一层更亮的深灰，白底/深底都看不出来。 */
.fold.on {
  border-color: transparent;
  background: var(--brand-soft);
  color: var(--t1);
  font-weight: 600;
}
.fold.on::before {
  content: '';
  position: absolute;
  left: 0;
  top: 7px;
  bottom: 7px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--brand);
}
.fold.on .icon {
  color: var(--brand);
}
.fold .n {
  font-size: 11.5px;
  color: var(--t3);
}
.fold.on .n {
  color: var(--brand);
}
.icon-btn {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--t3);
  cursor: pointer;
}
.icon-btn:hover {
  background: var(--soft-hover);
  color: var(--danger);
}
/* 「+」按钮和左边的输入框等高：用 .btn 的默认纵向内边距（8px），别用 .btn.sm 的 4px */
.fav-add {
  flex: none;
  padding: 8px 11px;
}
.vcard {
  position: relative;
}
.del {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--card);
  color: var(--t3);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.13s, color 0.13s;
}
.vcard:hover .del {
  opacity: 1;
}
.del:hover {
  color: var(--danger);
  border-color: var(--danger);
}
</style>
