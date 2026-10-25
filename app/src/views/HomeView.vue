<script setup lang="ts">
/**
 * 首页：继续学习 + 关注 UP 的更新
 * 还原自 HomeView-Dqy-o8Mz.js
 *
 * 说明：本构建的首页**没有**推荐流（bili.home.feed / popular 只在桥里存在，没有视图调用）。
 */
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import Icon from '@/components/Icon.vue'
import EmptyBlock from '@/components/EmptyBlock.vue'
import SkeletonGrid from '@/components/SkeletonGrid.vue'
import VideoCard from '@/components/VideoCard.vue'
import { useAuthStore } from '@/stores/auth'
import { useLearnStore } from '@/stores/learn'
import { useUpsStore } from '@/stores/ups'
import { useUiStore } from '@/stores/ui'
import { relativeTime, toHours } from '@/utils/format'

const learn = useLearnStore()
const ups = useUpsStore()
const auth = useAuthStore()
const ui = useUiStore()

/** 关注更新流的 UP 过滤（'all' = 全部） */
const active = ref('all')
const importing = ref(false)

/** 继续学习：本机进度里取最近 6 个没看完的（看了 5 秒以上） */
const continueList = computed(() =>
  learn.listByVideo
    .filter((t) => (t.seconds || 0) > 5 && !t.completed)
    .slice(0, 6)
    .map((t) => {
      const progress = t.duration ? Math.min(1, (t.seconds || 0) / t.duration) : 0
      // 原实现这里还算了 reason（未看完原因），但模板只把 5 个字段传给卡片，故省略
      return { ...t, progress }
    }),
)

/** 最新投稿按 bvid 去重 */
const deduped = computed(() => {
  const seen = new Set<string>()
  const out: typeof ups.latest = []
  for (const v of ups.latest) {
    if (!v.bvid || seen.has(v.bvid)) continue
    seen.add(v.bvid)
    out.push(v)
  }
  return out
})

/** 带上「N 小时前」并做 UP 过滤 */
const filteredUpdates = computed(() => {
  const list = deduped.value.map((v) => ({
    ...v,
    reason: v.pubdate ? relativeTime(v.pubdate) : '',
  }))
  return active.value === 'all'
    ? list
    : list.filter((v) => String(v.upMid) === active.value)
})

/** UP 过滤 chips：全部 + 名单里出现的每个 UP */
const chips = computed(() => {
  const map = new Map<string, string>()
  for (const v of deduped.value) {
    const mid = String(v.upMid)
    if (!map.has(mid)) map.set(mid, v.upName || `UP ${mid}`)
  }
  const list: { mid: string; name: string; n: number }[] = [
    { mid: 'all', name: '全部', n: deduped.value.length },
  ]
  for (const [mid, name] of map) {
    list.push({ mid, name, n: deduped.value.filter((v) => String(v.upMid) === mid).length })
  }
  return list
})

/** 某个视频的观看进度（0~1），用于卡片底部进度条 */
function progressOf(video: { bvid?: string }) {
  const hit = Object.values(learn.progressMap).find((p) => p.bvid === video.bvid)
  if (!hit || !hit.duration) return 0
  return Math.min(1, (hit.seconds || 0) / hit.duration)
}

/** 手动刷新关注 UP 的更新 */
async function refresh() {
  try {
    await ups.loadLatest(true)
    ui.ok('已刷新关注 UP 的更新')
  } catch (e: any) {
    ui.err((e && e.message) || '刷新失败')
  }
}

/** 一键导入 B 站关注 */
async function importFollowings() {
  if (!auth.loggedIn) {
    ui.askLogin()
    return
  }
  importing.value = true
  try {
    const res = await ups.importFollowings()
    ui.ok(`已导入 ${res.imported} 个关注`)
    await ups.loadLatest(true)
  } catch (e: any) {
    ui.err((e && e.message) || '导入失败')
  } finally {
    importing.value = false
  }
}

onMounted(async () => {
  await ups.init(true)
  if (ups.items.length) {
    try {
      await ups.loadLatest(false)
    } catch (e: any) {
      console.warn('[home] 关注 UP 更新拉取失败：', e && e.message)
    }
  }
})
</script>

<template>
  <div>
    <!-- 继续学习：本机进度，不依赖登录 -->
    <section v-if="continueList.length" style="margin-bottom: 22px">
      <div class="page-head">
        <h1>继续学习</h1>
        <p>接着上次的进度继续，今天已学 {{ toHours(learn.todaySeconds) }} 小时</p>
        <span class="grow"></span>
        <RouterLink to="/learn" class="chip">
          <Icon name="chart" :size="13" /> 学习统计
        </RouterLink>
      </div>
      <div class="grid">
        <VideoCard
          v-for="it in continueList"
          :key="it.key"
          :item="{
            bvid: it.bvid,
            title: it.title,
            cover: it.cover,
            upName: it.upName,
            upMid: it.upMid,
          }"
          :progress="it.progress"
        />
      </div>
    </section>

    <!-- 关注 UP 的更新 -->
    <div class="page-head">
      <h1>关注的 UP 更新</h1>
      <p>
        {{ ups.count }} 个 UP 的最新投稿
        <template v-if="ups.latestError"> · {{ ups.latestError }}</template>
      </p>
      <span class="grow"></span>
      <RouterLink to="/ups" class="chip">
        <Icon name="users" :size="13" /> 管理名单
      </RouterLink>
      <button class="btn sm" :disabled="ups.loadingLatest" @click="refresh">
        <span v-if="ups.loadingLatest" class="spinner"></span>
        <Icon v-else name="refresh" :size="14" /> 刷新
      </button>
    </div>

    <!-- UP 过滤 -->
    <div v-if="ups.count > 1" class="row" style="flex-wrap: wrap; margin-bottom: 14px">
      <span
        v-for="c in chips"
        :key="c.mid"
        :class="['chip', { on: active === c.mid }]"
        @click="active = c.mid"
      >
        {{ c.name }} {{ c.n }}
      </span>
    </div>

    <!-- 加载中（首次、还没有任何内容时） -->
    <SkeletonGrid v-if="ups.loadingLatest && !filteredUpdates.length" />

    <template v-else-if="ups.count">
      <div v-if="filteredUpdates.length" class="grid">
        <VideoCard
          v-for="v in filteredUpdates"
          :key="v.bvid"
          :item="v"
          :progress="progressOf(v)"
        />
      </div>
      <EmptyBlock
        v-else
        icon="film"
        title="这些 UP 最近没有更新"
        desc="换个 UP 看看，或者点「刷新」重新拉取。"
      />
    </template>

    <EmptyBlock
      v-else
      icon="users"
      title="还没有添加 UP 主"
      desc="首页只显示你自己名单里 UP 的最新投稿。先添加几个想专心学习的 UP 主，登录后还能一键导入 B 站关注。"
    >
      <RouterLink to="/ups" class="btn primary">
        <Icon name="plus" :size="15" /> 去添加 UP
      </RouterLink>
      <button class="btn" :disabled="importing" @click="importFollowings">
        <span v-if="importing" class="spinner"></span>
        <Icon v-else name="download" :size="15" /> 导入 B 站关注
      </button>
    </EmptyBlock>
  </div>
</template>
