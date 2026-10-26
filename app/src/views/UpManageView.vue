<script setup lang="ts">
/**
 * UP 管理页（/ups）：关注列表、分组筛选、添加/导入/移除 UP、分组管理
 * 还原自 UpManageView-DfXP44oj.js（scope data-v-1a1c558f）
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import BiliImage from '@/components/BiliImage.vue'
import EmptyBlock from '@/components/EmptyBlock.vue'
import { bili } from '@/bridge'
import { useUpsStore, UNGROUPED } from '@/stores/ups'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { formatCount } from '@/utils/format'

const router = useRouter()
const ups = useUpsStore()
const auth = useAuthStore()
const ui = useUiStore()

/** 添加 UP 弹窗 */
const addOpen = ref(false)
/** 搜索输入 */
const query = ref('')
/** 正在查找 */
const searching = ref(false)
/** 候选列表 */
const candidates = ref<any[]>([])
/** 当前选中的候选 */
const picked = ref<any>(null)
/** 添加时归入的分组 */
const addToGroup = ref(UNGROUPED)
/** 添加弹窗里的错误/提示 */
const addError = ref('')

/** 分组管理弹窗 */
const groupsOpen = ref(false)
const newGroup = ref('')

/** 给某个 UP 改分组的弹窗 */
const groupTarget = ref<any>(null)
const groupPick = ref('')
const groupNew = ref('')

/** 可选分组：未分组 + 自定义分组 */
const groupList = computed(() => [UNGROUPED, ...ups.groups])

/** 打开添加弹窗 */
function openAdd() {
  addOpen.value = true
  query.value = ''
  candidates.value = []
  picked.value = null
  addToGroup.value = ups.activeGroup === 'all' ? UNGROUPED : ups.activeGroup
  addError.value = ''
}

/** 看起来像 UID / 空间链接（直接 resolve，不走搜索） */
function looksLikeId(v: string) {
  const s = String(v || '').trim()
  return /^\d{1,12}$/.test(s) || /space\.bilibili\.com\/\d+/.test(s)
}

/** 查找 UP：UID/链接 → resolve；否则按昵称搜 UP */
async function find() {
  const s = query.value.trim()
  if (!s) {
    addError.value = '请输入 UP 主的 UID、空间链接或昵称'
    return
  }
  searching.value = true
  addError.value = ''
  candidates.value = []
  picked.value = null
  try {
    if (looksLikeId(s)) {
      const hit: any = await bili.up.resolve(s)
      // 桥的 up.resolve 有可能只回 { mid }；缺头像/昵称时补一次 up.info
      let up: any = hit
      if (hit && !hit.face) {
        try {
          up = { ...hit, ...(await bili.up.info(hit.mid)) }
        } catch {}
      }
      candidates.value = [up]
      picked.value = up
    } else {
      const res = await bili.search.ups(s, 1)
      candidates.value = res.items.slice(0, 8)
      picked.value = candidates.value[0] || null
      if (!candidates.value.length) addError.value = '没有搜到这个 UP 主，可以试试直接粘贴空间链接'
    }
  } catch (e: any) {
    addError.value = e.message || '查找失败'
  } finally {
    searching.value = false
  }
}

/** 加入名单 */
async function confirmAdd() {
  if (!picked.value) return
  try {
    await ups.addUp(picked.value, addToGroup.value)
    ui.ok(`已加入：${picked.value.name}`)
    addOpen.value = false
  } catch (e: any) {
    addError.value = e.message || '添加失败'
  }
}

/** 从 B 站导入关注（需要登录） */
async function importFollowings() {
  if (!auth.loggedIn) {
    ui.askLogin()
    return
  }
  try {
    const res = await ups.importFollowings()
    ui.ok(`已导入 ${res.imported} 个关注`)
  } catch (e: any) {
    ui.err(e.message || '导入失败')
  }
}

/** 从名单移除 */
async function removeUp(up: any) {
  const yes = await ui.confirm('从名单中移除？', `「${up.name}」将从你的关注名单里移除`, '移除')
  if (!yes) return
  await ups.removeUp(up.mid)
  ui.ok(`已移除：${up.name}`)
}

/** 打开「选择分组」弹窗 */
function openGroupPicker(up: any) {
  groupTarget.value = up
  groupPick.value = up.group || UNGROUPED
  groupNew.value = ''
}

/** 把当前 UP 移到分组（可新建） */
async function applyGroup(name?: string) {
  const up = groupTarget.value
  if (!up) return
  const target = (name || groupPick.value || UNGROUPED).trim() || UNGROUPED
  if (target !== UNGROUPED && !ups.groups.includes(target)) await ups.addGroup(target)
  await ups.setGroup(up.mid, target)
  groupTarget.value = null
  ui.ok(`「${up.name}」已归到 ${target}`)
}

/** 新建分组 */
async function createGroup() {
  const name = newGroup.value.trim()
  if (!name) return
  try {
    await ups.addGroup(name)
    newGroup.value = ''
    ui.ok(`已新建分组：${name}`)
  } catch (e: any) {
    ui.err(e.message)
  }
}

/** 删除分组（组里的 UP 回到未分组） */
async function deleteGroup(name: string) {
  const n = ups.items.filter((u) => u.group === name).length
  const yes = await ui.confirm(
    '删除分组？',
    n ? `「${name}」下的 ${n} 个 UP 会回到未分组` : `「${name}」还没有 UP`,
    '删除',
  )
  if (!yes) return
  await ups.removeGroup(name)
}

/** 进入 UP 主页 */
function goUp(up: any) {
  router.push({ name: 'up', params: { mid: String(up.mid) } })
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
        <template v-if="ups.count"> · 播放页可一键加入名单</template>
      </p>
      <span class="grow" />
      <button class="btn sm" @click="importFollowings">
        <Icon name="download" :size="14" /> 导入 B 站关注
      </button>
      <button class="btn sm" @click="groupsOpen = true">
        <Icon name="list" :size="14" /> 分组管理
      </button>
      <button class="btn primary sm" @click="openAdd">
        <Icon name="plus" :size="14" /> 添加 UP
      </button>
    </div>

    <div v-if="ups.count" class="row" style="flex-wrap: wrap; margin-bottom: 14px">
      <span
        v-for="chip in ups.groupChips"
        :key="chip.name"
        class="chip"
        :class="{ on: ups.activeGroup === chip.name }"
        @click="ups.activeGroup = chip.name"
      >
        {{ chip.label }} {{ chip.n }}
      </span>
    </div>

    <div v-if="ups.count" class="uplist">
      <div v-for="up in ups.filtered" :key="up.mid" class="uprow">
        <div class="avatar" @click="goUp(up)">
          <BiliImage :src="up.face" :alt="up.name" />
        </div>
        <div class="info">
          <div class="name" @click="goUp(up)">{{ up.name }}</div>
          <div class="sign clamp-1">{{ up.sign || '这个 UP 主还没有写简介' }}</div>
        </div>
        <span v-if="up.fans" class="muted mono" style="font-size: 12px">
          {{ formatCount(up.fans) }} 粉丝
        </span>
        <span class="chip plain">{{ up.group || UNGROUPED }}</span>
        <button class="btn sm" @click="openGroupPicker(up)">分组</button>
        <button class="btn ghost sm" style="color: var(--danger)" @click="removeUp(up)">删除</button>
      </div>
    </div>
    <EmptyBlock
      v-else
      icon="users"
      title="名单还是空的"
      desc="把想专心跟的 UP 主加进来（UID、空间链接或昵称都行），集中管理；登录后还能一键导入 B 站关注。"
    >
      <button class="btn primary" @click="openAdd">
        <Icon name="plus" :size="15" /> 添加 UP
      </button>
      <button class="btn" @click="importFollowings">
        <Icon name="download" :size="15" /> 导入 B 站关注
      </button>
    </EmptyBlock>

    <div v-if="addOpen" class="overlay" @click.self="addOpen = false">
      <div class="modal" style="width: 460px">
        <h3>添加 UP 主</h3>
        <div class="row">
          <input
            v-model="query"
            class="input"
            placeholder="UID / https://space.bilibili.com/xxx / 昵称"
            @keyup.enter="find"
          />
          <button class="btn primary" :disabled="searching" @click="find">
            <span v-if="searching" class="spinner" />
            <Icon v-else name="search" :size="15" /> 查找
          </button>
        </div>
        <p v-if="addError" class="muted" style="color: var(--danger); margin: 0">{{ addError }}</p>
        <div v-if="candidates.length" class="cands">
          <div
            v-for="cand in candidates"
            :key="cand.mid"
            class="cand"
            :class="{ on: picked && picked.mid === cand.mid }"
            @click="picked = cand"
          >
            <div class="avatar sm">
              <BiliImage :src="cand.face" :alt="cand.name" />
            </div>
            <div class="info">
              <div class="name">{{ cand.name }}</div>
              <div class="sign clamp-1">{{ cand.sign || '—' }}</div>
            </div>
            <span v-if="cand.fans" class="muted mono" style="font-size: 11.5px">
              {{ formatCount(cand.fans) }} 粉丝
            </span>
          </div>
        </div>
        <div class="field">
          <label>分组</label>
          <div class="ctrl row" style="flex-wrap: wrap">
            <span
              v-for="g in groupList"
              :key="g"
              class="chip"
              :class="{ on: addToGroup === g }"
              @click="addToGroup = g"
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

    <div v-if="groupsOpen" class="overlay" @click.self="groupsOpen = false">
      <div class="modal" style="width: 420px">
        <h3>分组管理</h3>
        <div class="row">
          <input
            v-model="newGroup"
            class="input"
            placeholder="新分组名称，如：英语 / 钢琴 / 数学"
            @keyup.enter="createGroup"
          />
          <button class="btn primary" @click="createGroup">
            <Icon name="plus" :size="15" /> 新建
          </button>
        </div>
        <div v-if="ups.groups.length" class="glist">
          <div v-for="g in ups.groups" :key="g" class="grow-item">
            <span>{{ g }}</span>
            <span class="muted mono" style="font-size: 12px">
              {{ ups.items.filter((u) => u.group === g).length }} 个 UP
            </span>
            <button class="btn ghost sm" style="color: var(--danger)" @click="deleteGroup(g)">删除</button>
          </div>
        </div>
        <p v-else class="muted" style="margin: 0; font-size: 12.5px">
          还没有自定义分组。删除分组时，组里的 UP 会回到「未分组」。
        </p>
        <div class="row" style="justify-content: flex-end">
          <button class="btn" @click="groupsOpen = false">完成</button>
        </div>
      </div>
    </div>

    <div v-if="groupTarget" class="overlay" @click.self="groupTarget = null">
      <div class="modal" style="width: 420px">
        <h3>{{ groupTarget.name }} · 选择分组</h3>
        <div class="row" style="flex-wrap: wrap">
          <span
            v-for="g in groupList"
            :key="g"
            class="chip"
            :class="{ on: groupPick === g }"
            @click="groupPick = g"
          >
            {{ g }}
          </span>
        </div>
        <div class="row">
          <input v-model="groupNew" class="input" placeholder="或者直接输入新分组名" @keyup.enter="applyGroup(groupNew)" />
          <button class="btn" @click="applyGroup(groupNew)">新建并归入</button>
        </div>
        <div class="row" style="justify-content: flex-end">
          <button class="btn" @click="groupTarget = null">取消</button>
          <button class="btn primary" @click="applyGroup()">确定</button>
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
  transition:
    border-color 0.13s,
    background 0.13s;
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
  transition:
    border-color 0.13s,
    background 0.13s;
}
.cand:hover {
  background: var(--card-hover);
}
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
