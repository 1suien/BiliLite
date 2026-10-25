<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useHabitsStore } from '../stores/habits'
import { todayKey } from '../utils/format'
import Icon from './Icon.vue'

const router = useRouter()
const habits = useHabitsStore()

const list = computed(() => habits.todayList)
const done = computed(() => habits.todayDone)
</script>

<template>
  <div class="card habit-home">
    <div class="row hb-home-head">
      <Icon name="check" :size="15" />
      <b class="grow">今日习惯</b>
      <span class="muted hb-home-n">{{ done }}/{{ list.length }}</span>
      <button class="btn sm ghost" @click="router.push('/habit')">习惯页 <Icon name="right" :size="13" /></button>
    </div>
    <div v-if="!list.length" class="muted" style="font-size: 12.5px">
      还没有习惯，去「习惯」页加一个（比如每天跟读 30 天）。
    </div>
    <div v-else class="hb-home-list">
      <button
        v-for="h in list"
        :key="h.id"
        class="chip hb-home-chip"
        :class="h.done ? 'on' : 'plain'"
        :title="h.done ? '再点一下取消今天的打卡' : '点一下记今天已打卡'"
        @click="habits.toggle(h.id, todayKey())"
      >
        <Icon :name="h.done ? 'check' : 'plus'" :size="12" /> {{ h.name }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.habit-home {
  padding: 12px 14px;
  margin-top: 14px;
}
.hb-home-head {
  align-items: center;
  gap: 8px;
}
.hb-home-n {
  font-size: 12.5px;
}
.hb-home-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.hb-home-chip {
  cursor: pointer;
}
</style>
