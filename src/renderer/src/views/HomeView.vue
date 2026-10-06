<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import VideoCard from '../components/VideoCard.vue'
import SkeletonGrid from '../components/SkeletonGrid.vue'
import EmptyBlock from '../components/EmptyBlock.vue'
import Icon from '../components/Icon.vue'
import { useLearnStore } from '../stores/learn'
import { useUpsStore } from '../stores/ups'
import { useAuthStore } from '../stores/auth'
import { useUiStore } from '../stores/ui'
import { fmtHours, fmtAgo } from '../utils/format'

const router = useRouter()
const learn = useLearnStore()
const ups = useUpsStore()
const auth = useAuthStore()
const ui = useUiStore()

/** 当前筛选的 UP：'all' 或 mid 字符串 */
const only = ref('all')
const imported = ref(false)

/** 继续学习：按视频展示（同一视频的多个分P只留最近一条），学习记录里存的是「每个分P一行」 */
const continueList = computed(() =>
  learn.listByVideo
    .filter((r) => r.seconds > 5 && !r.completed)
    .slice(0, 6)
    .map((r) => ({
      ...r,
      progress: r.duration ? Math.min(1, r.seconds / r.duration) : 0
    }))
)

/** UP 投稿去重：多个 UP 转载同一稿件时首页只出现一张卡 */
const latestUnique = computed(() => {
  const seen = new Set()
  const out = []
  for (const it of ups.latest) {
    if (!it.bvid || seen.has(it.bvid)) continue
    seen.add(it.bvid)
    out.push(it)
  }
  return out
})

/** 首页推荐 = 本机 UP 名单里最新的投稿 */
const items = computed(() => {
  const list = latestUnique.value.map((it) => ({ ...it, reason: it.pubdate ? fmtAgo(it.pubdate) : '' }))
  if (only.value === 'all') return list
  return list.filter((it) => String(it.upMid) === only.value)
})

const upChips = computed(() => {
  const names = new Map()
  for (const it of latestUnique.value) {
    const k = String(it.upMid)
    if (!names.has(k)) names.set(k, it.upName)
  }
  const chips = [{ mid: 'all', name: '全部', n: latestUnique.value.length }]
  for (const [mid, name] of names) {
    chips.push({ mid, name, n: latestUnique.value.filter((x) => String(x.upMid) === mid).length })
  }
  return chips
})

function progressOf(item) {
  const rec = Object.values(learn.progressMap).find((x) => x.bvid === item.bvid)
  if (!rec || !rec.duration) return 0
  return Math.min(1, rec.seconds / rec.duration)
}

async function refresh() {
  try {
    await ups.loadLatest(true)
    ui.ok('已刷新关注 UP 的更新')
  } catch (err) {
    ui.err(err.message || '刷新失败')
  }
}

async function importFollowings() {
  if (!auth.loggedIn) {
    ui.askLogin()
    return
  }
  imported.value = true
  try {
    const res = await ups.importFollowings()
    ui.ok(`已导入 ${res.imported} 个关注`)
    await ups.loadLatest(true)
  } catch (err) {
    ui.err(err.message || '导入失败')
  } finally {
    imported.value = false
  }
}

onMounted(async () => {
  await ups.init(true)
  if (ups.items.length) {
    try {
      await ups.loadLatest(false)
    } catch (err) {
      console.warn('[home] 关注 UP 更新拉取失败：', err && err.message)
    }
  }
})
</script>

<template>
  <div>
    <section v-if="continueList.length" style="margin-bottom: 22px">
      <div class="page-head">
        <h1>继续学习</h1>
        <p>接着上次的进度继续，今天已学 {{ fmtHours(learn.todaySeconds) }} 小时</p>
        <span class="grow" />
        <RouterLink to="/learn" class="chip"><Icon name="chart" :size="13" /> 学习统计</RouterLink>
      </div>
      <div class="grid">
        <VideoCard
          v-for="r in continueList"
          :key="r.key"
          :item="{ bvid: r.bvid, title: r.title, cover: r.cover, upName: r.upName, upMid: r.upMid }"
          :progress="r.progress"
        />
      </div>
    </section>

    <div class="page-head">
      <h1>关注的 UP 更新</h1>
      <p>
        {{ ups.count }} 个 UP 的最新投稿
        <template v-if="ups.latestError"> · {{ ups.latestError }}</template>
      </p>
      <span class="grow" />
      <RouterLink to="/ups" class="chip"><Icon name="users" :size="13" /> 管理名单</RouterLink>
      <button class="btn sm" :disabled="ups.loadingLatest" @click="refresh">
        <span v-if="ups.loadingLatest" class="spinner" />
        <Icon v-else name="refresh" :size="14" />
        刷新
      </button>
    </div>

    <div v-if="ups.count > 1" class="row" style="flex-wrap: wrap; margin-bottom: 14px">
      <span
        v-for="c in upChips"
        :key="c.mid"
        class="chip"
        :class="{ on: only === c.mid }"
        @click="only = c.mid"
      >
        {{ c.name }} {{ c.n }}
      </span>
    </div>

    <SkeletonGrid v-if="ups.loadingLatest && !items.length" />
    <EmptyBlock
      v-else-if="!ups.count"
      icon="users"
      title="还没有添加 UP 主"
      desc="首页只显示你自己名单里 UP 的最新投稿。先添加几个想专心学习的 UP 主，登录后还能一键导入 B 站关注。"
    >
      <RouterLink to="/ups" class="btn primary"><Icon name="plus" :size="15" /> 去添加 UP</RouterLink>
      <button class="btn" :disabled="imported" @click="importFollowings">
        <span v-if="imported" class="spinner" />
        <Icon v-else name="download" :size="15" />
        导入 B 站关注
      </button>
    </EmptyBlock>
    <EmptyBlock
      v-else-if="!items.length"
      icon="film"
      title="这些 UP 最近没有更新"
      desc="换个 UP 看看，或者点「刷新」重新拉取。"
    />
    <div v-else class="grid">
      <VideoCard v-for="v in items" :key="v.bvid" :item="v" :progress="progressOf(v)" />
    </div>
  </div>
</template>
