<script setup lang="ts">
/**
 * 收藏页：本机收藏夹（本地 IndexedDB）+ B 站账户收藏夹
 * 还原自 FavView-BOBbqTcq.js，样式来自 styles/recovered/FavView.css
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import BiliImage from '@/components/BiliImage.vue'
import EmptyBlock from '@/components/EmptyBlock.vue'
import { bili } from '@/bridge'
import { useAuthStore } from '@/stores/auth'
import { useCollectStore } from '@/stores/collect'
import { useUiStore } from '@/stores/ui'
import { formatClock, relativeTime } from '@/utils/format'
import type { CollectItem } from '@/types'

/** B 站收藏夹条目：桥接层实际给的是 {id,mid,title,cover,mediaCount,...}（不是 types 里的 media_count） */
interface BiliFolder {
  id: number
  mid: number
  title: string
  cover?: string
  mediaCount?: number
}

const router = useRouter()
const auth = useAuthStore()
const collect = useCollectStore()
const ui = useUiStore()

/** 当前 tab：local（本机）/ bili（账户） */
const tab = ref<'local' | 'bili'>('local')
const loadingBili = ref(false)
const created = ref<BiliFolder[]>([])
const collected = ref<BiliFolder[]>([])
const biliError = ref('')
const newFolder = ref('')

const biliCount = computed(() => created.value.length + collected.value.length)
const localList = computed(() => collect.filtered)

/** 读 B 站收藏夹（必须登录） */
async function loadBili() {
  if (!auth.loggedIn) return
  loadingBili.value = true
  biliError.value = ''
  try {
    const res = (await bili.fav.folders()) as unknown as {
      created: BiliFolder[]
      collected: BiliFolder[]
    }
    created.value = res.created
    collected.value = res.collected
  } catch (e: any) {
    biliError.value = (e && e.message) || '收藏夹加载失败'
    if (e && e.needLogin) ui.askLogin()
  } finally {
    loadingBili.value = false
  }
}

function openFolder(f: BiliFolder) {
  router.push({ name: 'fav-folder', params: { mediaId: String(f.id) } })
}

function openVideo(item: CollectItem) {
  router.push({ name: 'video', params: { bvid: item.bvid } })
}

/** 新建本机文件夹 */
async function createFolder() {
  const name = newFolder.value.trim()
  if (!name) return
  try {
    await collect.createFolder(name)
    newFolder.value = ''
    ui.ok(`已新建文件夹：${name}`)
  } catch (e: any) {
    ui.err(e && e.message)
  }
}

/** 删除本机文件夹（里面的视频会退回默认收藏夹） */
async function removeFolder(name: string) {
  const n = collect.items.filter((i) => i.folder === name).length
  const ok = await ui.confirm(
    '删除文件夹？',
    n ? `「${name}」里的 ${n} 个视频会移到「默认收藏夹」` : `「${name}」还是空的`,
    '删除',
  )
  if (!ok) return
  try {
    await collect.removeFolder(name)
    ui.ok('文件夹已删除')
  } catch (e: any) {
    ui.err(e && e.message)
  }
}

/** 把视频移出本机收藏 */
async function removeItem(item: CollectItem) {
  const ok = await ui.confirm('移出收藏？', item.title, '移出')
  if (!ok) return
  await collect.removeItem(item.id as number)
  ui.ok('已移出本机收藏')
}

function switchTab(t: 'local' | 'bili') {
  tab.value = t
  if (t === 'bili' && auth.loggedIn && !biliCount.value) loadBili()
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
        <span :class="['chip', { on: tab === 'local' }]" @click="switchTab('local')">
          <Icon name="star" :size="13" /> 本机收藏 {{ collect.count }}
        </span>
        <span :class="['chip', { on: tab === 'bili' }]" @click="switchTab('bili')">
          <Icon name="folder" :size="13" /> B站账户收藏 {{ biliCount }}
        </span>
      </div>
      <span class="grow"></span>
      <button v-if="tab === 'bili'" class="btn sm" :disabled="loadingBili" @click="loadBili">
        <Icon name="refresh" :size="14" /> 刷新
      </button>
    </div>

    <!-- 本机收藏 -->
    <div v-if="tab === 'local'" class="fav-layout">
      <aside class="folders">
        <div class="fd-head">文件夹</div>
        <div class="row">
          <input
            v-model="newFolder"
            class="input"
            placeholder="新建文件夹"
            @keyup.enter="createFolder"
          />
          <button class="btn fav-add" title="新建文件夹" aria-label="新建文件夹" @click="createFolder">
            <Icon name="plus" :size="15" />
          </button>
        </div>
        <div
          v-for="f in collect.folderList"
          :key="f.name"
          :class="['fold', { on: collect.activeFolder === f.name }]"
          @click="collect.activeFolder = f.name"
        >
          <Icon name="folder" :size="15" />
          <span class="grow clamp-1">{{ f.name }}</span>
          <span class="n mono">{{ f.n }}</span>
          <button
            v-if="f.deletable"
            class="icon-btn"
            title="删除文件夹"
            @click.stop="removeFolder(f.name)"
          >
            <Icon name="trash" :size="13" />
          </button>
        </div>
      </aside>

      <section style="min-width: 0">
        <div class="page-head" style="margin-bottom: 12px">
          <h2 style="font-size: 15px; margin: 0">
            {{ collect.activeFolder }}
            <span class="muted" style="font-size: 12.5px; font-weight: 400">
              {{ localList.length }} 个视频
            </span>
          </h2>
        </div>

        <template v-if="collect.count">
          <div v-if="localList.length" class="grid">
            <div v-for="item in localList" :key="item.id" class="vcard" @click="openVideo(item)">
              <div class="thumb">
                <BiliImage :src="item.cover" :alt="item.title" />
                <span v-if="item.duration" class="dur">{{ formatClock(item.duration) }}</span>
              </div>
              <div class="meta">
                <div class="title clamp-2">{{ item.title }}</div>
                <div class="sub">
                  <span class="muted">{{ relativeTime(item.at || 0) }}</span>
                  <span
                    v-if="item.upName"
                    class="up"
                    @click.stop="router.push({ name: 'up', params: { mid: String(item.upMid) } })"
                  >
                    {{ item.upName }}
                  </span>
                </div>
              </div>
              <button class="del" title="移出收藏" @click.stop="removeItem(item)">
                <Icon name="trash" :size="14" />
              </button>
            </div>
          </div>
          <EmptyBlock
            v-else
            icon="folder"
            title="这个文件夹是空的"
            desc="在播放页收藏时选择这个文件夹即可。"
          />
        </template>
        <EmptyBlock
          v-else
          icon="star"
          title="本机收藏还是空的"
          desc="在播放页点「收藏」，就能把视频存到本机的文件夹里，不依赖 B 站账号。"
        />
      </section>
    </div>

    <!-- B 站账户收藏 -->
    <template v-else>
      <EmptyBlock
        v-if="!auth.loggedIn"
        icon="star"
        title="登录后可以读 B 站收藏夹"
        desc="收藏夹接口必须带账号凭证。登录凭证只加密保存在本机，用于读取你自己的收藏内容。"
      >
        <button class="btn primary" @click="ui.loginOpen = true">扫码登录</button>
      </EmptyBlock>

      <template v-else>
        <div v-if="biliError" class="panel" style="color: var(--danger)">{{ biliError }}</div>

        <div v-else-if="loadingBili && !biliCount" class="panel row" style="gap: 10px">
          <span class="spinner"></span>
          <span class="dim">正在读取收藏夹…</span>
        </div>

        <template v-else-if="biliCount">
          <h2 style="font-size: 14px; margin: 6px 0 12px">我创建的（{{ created.length }}）</h2>
          <div class="grid">
            <div v-for="f in created" :key="f.id" class="vcard" @click="openFolder(f)">
              <div class="thumb">
                <BiliImage :src="f.cover" :alt="f.title" />
              </div>
              <div class="meta">
                <div class="title clamp-1">{{ f.title }}</div>
                <div class="sub">
                  <span class="muted">{{ f.mediaCount }} 个内容</span>
                </div>
              </div>
            </div>
          </div>

          <template v-if="collected.length">
            <h2 style="font-size: 14px; margin: 22px 0 12px">我收藏的（{{ collected.length }}）</h2>
            <div class="grid">
              <div v-for="f in collected" :key="f.id" class="vcard" @click="openFolder(f)">
                <div class="thumb">
                  <BiliImage :src="f.cover" :alt="f.title" />
                </div>
                <div class="meta">
                  <div class="title clamp-1">{{ f.title }}</div>
                  <div class="sub">
                    <span class="muted">{{ f.mediaCount }} 个内容 · 来自 UP {{ f.mid }}</span>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </template>

        <EmptyBlock
          v-else
          icon="star"
          title="还没有收藏夹"
          desc="在 B 站网页端建立收藏夹后，这里会同步显示。"
        />
      </template>
    </template>
  </div>
</template>

<style scoped>
/* 来源: styles/recovered/FavView.css（原 scope: data-v-9c334435） */
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
  transition:
    border-color 0.13s,
    background 0.13s,
    color 0.13s;
}
.fold:hover {
  background: var(--card-hover);
}
.fold.on {
  border-color: transparent;
  background: var(--brand-soft);
  color: var(--t1);
  font-weight: 600;
}
.fold.on:before {
  content: "";
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
  transition:
    opacity 0.13s,
    color 0.13s;
}
.vcard:hover .del {
  opacity: 1;
}
.del:hover {
  color: var(--danger);
  border-color: var(--danger);
}
</style>
