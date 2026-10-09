<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import BiliImage from '../components/BiliImage.vue'
import EmptyBlock from '../components/EmptyBlock.vue'
import Icon from '../components/Icon.vue'
import { useUpsStore, DEFAULT_GROUP } from '../stores/ups'
import { useAuthStore } from '../stores/auth'
import { useUiStore } from '../stores/ui'
import { fmtCount } from '../utils/format'

const router = useRouter()
const ups = useUpsStore()
const auth = useAuthStore()
const ui = useUiStore()

// ---- 添加 UP ----
const addOpen = ref(false)
const addQuery = ref('')
const searching = ref(false)
const candidates = ref([])
const picked = ref(null)
const addGroupName = ref(DEFAULT_GROUP)
const addError = ref('')

// ---- 分组管理 ----
const groupOpen = ref(false)
const newGroup = ref('')

// ---- 给某个 UP 改分组 ----
const assignTarget = ref(null)
const assignGroup = ref('')
const inlineGroup = ref('')

const groupOptions = computed(() => [DEFAULT_GROUP, ...ups.groups])

function openAdd() {
  addOpen.value = true
  addQuery.value = ''
  candidates.value = []
  picked.value = null
  addGroupName.value = ups.activeGroup === 'all' ? DEFAULT_GROUP : ups.activeGroup
  addError.value = ''
}

function looksLikeId(text) {
  const q = String(text || '').trim()
  return /^\d{1,12}$/.test(q) || /space\.bilibili\.com\/\d+/.test(q)
}

async function find() {
  const q = addQuery.value.trim()
  if (!q) {
    addError.value = '请输入 UP 主的 UID、空间链接或昵称'
    return
  }
  searching.value = true
  addError.value = ''
  candidates.value = []
  picked.value = null
  try {
    if (looksLikeId(q)) {
      const info = await api.up.resolve(q)
      candidates.value = [info]
      picked.value = info
    } else {
      const res = await api.search.ups(q, 1)
      candidates.value = res.items.slice(0, 8)
      picked.value = candidates.value[0] || null
      if (!candidates.value.length) addError.value = '没有搜到这个 UP 主，可以试试直接粘贴空间链接'
    }
  } catch (err) {
    addError.value = err.message || '查找失败'
  } finally {
    searching.value = false
  }
}

async function confirmAdd() {
  if (!picked.value) return
  try {
    await ups.addUp(picked.value, addGroupName.value)
    ui.ok(`已加入：${picked.value.name}`)
    addOpen.value = false
  } catch (err) {
    addError.value = err.message || '添加失败'
  }
}

async function importFollowings() {
  if (!auth.loggedIn) {
    ui.askLogin()
    return
  }
  try {
    const res = await ups.importFollowings()
    ui.ok(`已导入 ${res.imported} 个关注`)
  } catch (err) {
    ui.err(err.message || '导入失败')
  }
}

async function removeUp(u) {
  const okToGo = await ui.confirm('从名单中移除？', `「${u.name}」将不再出现在首页`, '移除')
  if (!okToGo) return
  await ups.removeUp(u.mid)
  ui.ok(`已移除：${u.name}`)
}

function startAssign(u) {
  assignTarget.value = u
  assignGroup.value = u.group || DEFAULT_GROUP
  inlineGroup.value = ''
}

async function confirmAssign(group) {
  const target = assignTarget.value
  if (!target) return
  const name = (group || assignGroup.value || DEFAULT_GROUP).trim() || DEFAULT_GROUP
  if (name !== DEFAULT_GROUP && !ups.groups.includes(name)) {
    await ups.addGroup(name)
  }
  await ups.setGroup(target.mid, name)
  assignTarget.value = null
  ui.ok(`「${target.name}」已归到 ${name}`)
}

async function createGroup() {
  const name = newGroup.value.trim()
  if (!name) return
  try {
    await ups.addGroup(name)
    newGroup.value = ''
    ui.ok(`已新建分组：${name}`)
  } catch (err) {
    ui.err(err.message)
  }
}

async function dropGroup(name) {
  const n = ups.items.filter((x) => x.group === name).length
  const okToGo = await ui.confirm('删除分组？', n ? `「${name}」下的 ${n} 个 UP 会回到未分组` : `「${name}」还没有 UP`, '删除')
  if (!okToGo) return
  await ups.removeGroup(name)
}

function openUp(u) {
  router.push({ name: 'up', params: { mid: String(u.mid) } })
}

onMounted(async () => {
  await ups.init(true)
})
</script>

<template>
  <div>
    <div class="page-head">
      <h1>UP 管理</h1>
      <p>
        {{ ups.count }} 个关注
        <template v-if="ups.count"> · 首页只显示这批 UP 的最新投稿</template>
      </p>
      <span class="grow" />
      <button class="btn sm" @click="importFollowings">
        <Icon name="download" :size="14" /> 导入 B 站关注
      </button>
      <button class="btn sm" @click="groupOpen = true"><Icon name="list" :size="14" /> 分组管理</button>
      <button class="btn primary sm" @click="openAdd"><Icon name="plus" :size="14" /> 添加 UP</button>
    </div>

    <div v-if="ups.count" class="row" style="flex-wrap: wrap; margin-bottom: 14px">
      <span
        v-for="c in ups.groupChips"
        :key="c.name"
        class="chip"
        :class="{ on: ups.activeGroup === c.name }"
        @click="ups.activeGroup = c.name"
      >
        {{ c.label }} {{ c.n }}
      </span>
    </div>

    <EmptyBlock
      v-if="!ups.count"
      icon="users"
      title="名单还是空的"
      desc="添加你想专心学习的 UP 主（UID、空间链接或昵称都行），首页就只显示他们的最新投稿；登录后还能一键导入 B 站关注。"
    >
      <button class="btn primary" @click="openAdd"><Icon name="plus" :size="15" /> 添加 UP</button>
      <button class="btn" @click="importFollowings"><Icon name="download" :size="15" /> 导入 B 站关注</button>
    </EmptyBlock>

    <div v-else class="uplist">
      <div v-for="u in ups.filtered" :key="u.mid" class="uprow">
        <div class="avatar" @click="openUp(u)"><BiliImage :src="u.face" :alt="u.name" /></div>
        <div class="info">
          <div class="name" @click="openUp(u)">{{ u.name }}</div>
          <div class="sign clamp-1">{{ u.sign || '这个 UP 主还没有写简介' }}</div>
        </div>
        <span v-if="u.fans" class="muted mono" style="font-size: 12px">{{ fmtCount(u.fans) }} 粉丝</span>
        <span class="chip plain">{{ u.group || DEFAULT_GROUP }}</span>
        <button class="btn sm" @click="startAssign(u)">分组</button>
        <button class="btn ghost sm" style="color: var(--danger)" @click="removeUp(u)">删除</button>
      </div>
    </div>

    <!-- 添加 UP -->
    <div v-if="addOpen" class="overlay" @click.self="addOpen = false">
      <div class="modal" style="width: 460px">
        <h3>添加 UP 主</h3>
        <div class="row">
          <input
            v-model="addQuery"
            class="input"
            placeholder="UID / https://space.bilibili.com/xxx / 昵称"
            @keyup.enter="find"
          />
          <button class="btn primary" :disabled="searching" @click="find">
            <span v-if="searching" class="spinner" />
            <Icon v-else name="search" :size="15" />
            查找
          </button>
        </div>
        <p v-if="addError" class="muted" style="color: var(--danger); margin: 0">{{ addError }}</p>

        <div v-if="candidates.length" class="cands">
          <div
            v-for="c in candidates"
            :key="c.mid"
            class="cand"
            :class="{ on: picked && picked.mid === c.mid }"
            @click="picked = c"
          >
            <div class="avatar sm"><BiliImage :src="c.face" :alt="c.name" /></div>
            <div class="info">
              <div class="name">{{ c.name }}</div>
              <div class="sign clamp-1">{{ c.sign || '—' }}</div>
            </div>
            <span v-if="c.fans" class="muted mono" style="font-size: 11.5px">{{ fmtCount(c.fans) }} 粉丝</span>
          </div>
        </div>

        <div class="field">
          <label>分组</label>
          <div class="ctrl row" style="flex-wrap: wrap">
            <span
              v-for="g in groupOptions"
              :key="g"
              class="chip"
              :class="{ on: addGroupName === g }"
              @click="addGroupName = g"
            >
              {{ g }}
            </span>
          </div>
        </div>

        <div class="row" style="justify-content: flex-end">
          <button class="btn" @click="addOpen = false">取消</button>
          <button class="btn primary" :disabled="!picked" @click="confirmAdd">加入名单</button>
        </div>
      </div>
    </div>

    <!-- 分组管理 -->
    <div v-if="groupOpen" class="overlay" @click.self="groupOpen = false">
      <div class="modal" style="width: 420px">
        <h3>分组管理</h3>
        <div class="row">
          <input v-model="newGroup" class="input" placeholder="新分组名称，如：英语 / 钢琴 / 数学" @keyup.enter="createGroup" />
          <button class="btn primary" @click="createGroup"><Icon name="plus" :size="15" /> 新建</button>
        </div>
        <div v-if="ups.groups.length" class="glist">
          <div v-for="g in ups.groups" :key="g" class="grow-item">
            <span>{{ g }}</span>
            <span class="muted mono" style="font-size: 12px">{{ ups.items.filter((x) => x.group === g).length }} 个 UP</span>
            <button class="btn ghost sm" style="color: var(--danger)" @click="dropGroup(g)">删除</button>
          </div>
        </div>
        <p v-else class="muted" style="margin: 0; font-size: 12.5px">还没有自定义分组。删除分组时，组里的 UP 会回到「未分组」。</p>
        <div class="row" style="justify-content: flex-end">
          <button class="btn" @click="groupOpen = false">完成</button>
        </div>
      </div>
    </div>

    <!-- 给某个 UP 改分组 -->
    <div v-if="assignTarget" class="overlay" @click.self="assignTarget = null">
      <div class="modal" style="width: 420px">
        <h3>{{ assignTarget.name }} · 选择分组</h3>
        <div class="row" style="flex-wrap: wrap">
          <span
            v-for="g in groupOptions"
            :key="g"
            class="chip"
            :class="{ on: assignGroup === g }"
            @click="assignGroup = g"
          >
            {{ g }}
          </span>
        </div>
        <div class="row">
          <input v-model="inlineGroup" class="input" placeholder="或者直接输入新分组名" @keyup.enter="confirmAssign(inlineGroup)" />
          <button class="btn" @click="confirmAssign(inlineGroup)">新建并归入</button>
        </div>
        <div class="row" style="justify-content: flex-end">
          <button class="btn" @click="assignTarget = null">取消</button>
          <button class="btn primary" @click="confirmAssign()">确定</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.uplist {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.uprow {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  transition: border-color 0.13s, background 0.13s;
}
.uprow:hover {
  border-color: var(--line-strong);
  background: var(--card-hover);
}
.avatar {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  overflow: hidden;
  flex: none;
  background: var(--soft);
  cursor: pointer;
}
.avatar.sm {
  width: 34px;
  height: 34px;
}
.info {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.name {
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
}
.name:hover {
  color: var(--link);
}
.sign {
  font-size: 12px;
  color: var(--t3);
}
.cands {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 260px;
  overflow: auto;
}
.cand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: border-color 0.13s, background 0.13s;
}
.cand:hover {
  background: var(--card-hover);
}
/* 选中候选用品牌色描边 + 淡底 —— 跟侧栏/收藏夹的「当前项」保持一致，
   原来只有一层 border 变白的弱提示。 */
.cand.on {
  border-color: var(--brand-line);
  background: var(--brand-soft);
}
.glist {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.grow-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.grow-item > span:first-child {
  flex: 1;
  font-size: 13px;
}
</style>
