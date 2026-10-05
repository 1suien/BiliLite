<script setup>
defineProps({ count: { type: Number, default: 12 } })
</script>

<template>
  <div class="grid">
    <div v-for="i in count" :key="i" class="vcard" style="cursor: default">
      <div class="thumb sk" />
      <div class="meta">
        <div class="sk" style="height: 13px; width: 92%" />
        <div class="sk" style="height: 13px; width: 62%" />
        <div class="sk" style="height: 10px; width: 40%; margin-top: 4px" />
      </div>
    </div>
  </div>
</template>
