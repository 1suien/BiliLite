<script setup>
const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 18 },
  stroke: { type: [Number, String], default: 1.7 }
})

const ICONS = {
  home: '<path d="M3 9.5 12 3l9 6.5V20a1.5 1.5 0 0 1-1.5 1.5H4.5A1.5 1.5 0 0 1 3 20z"/><path d="M9.5 21.5V14h5v7.5"/>',
  search: '<circle cx="11" cy="11" r="7.5"/><path d="M20.5 20.5 16.2 16.2"/>',
  star: '<path d="M12 3.2 14.9 9l6.3.9-4.6 4.4 1.1 6.3L12 17.6 6.3 20.6l1.1-6.3L2.8 9.9 9.1 9z"/>',
  book: '<path d="M4 19.2A2.2 2.2 0 0 1 6.2 17H20"/><path d="M6.2 2.5H20v19H6.2A2.2 2.2 0 0 1 4 19.2V4.7A2.2 2.2 0 0 1 6.2 2.5z"/>',
  settings:
    '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
  user: '<path d="M20 21v-1.8a4.2 4.2 0 0 0-4.2-4.2H8.2A4.2 4.2 0 0 0 4 19.2V21"/><circle cx="12" cy="7.5" r="3.8"/>',
  play: '<path d="M6 3.6 19.5 12 6 20.4z"/>',
  pause: '<rect x="6.5" y="4" width="3.6" height="16" rx="1"/><rect x="13.9" y="4" width="3.6" height="16" rx="1"/>',
  prev: '<path d="M18 4.5 7.5 12 18 19.5z"/><path d="M5 5v14"/>',
  next: '<path d="M6 4.5 16.5 12 6 19.5z"/><path d="M19 5v14"/>',
  volume:
    '<path d="M4 9.5h3.2L12 5.2v13.6L7.2 14.5H4z"/><path d="M16 9.2a4 4 0 0 1 0 5.6"/><path d="M18.7 6.6a7.6 7.6 0 0 1 0 10.8"/>',
  mute: '<path d="M4 9.5h3.2L12 5.2v13.6L7.2 14.5H4z"/><path d="M16.5 9.8 21 14.3M21 9.8l-4.5 4.5"/>',
  expand:
    '<path d="M8 3.5H5.5A2 2 0 0 0 3.5 5.5V8M20.5 8V5.5a2 2 0 0 0-2-2H16M16 20.5h2.5a2 2 0 0 0 2-2V16M3.5 16v2.5a2 2 0 0 0 2 2H8"/>',
  clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.2V12l3.4 2"/>',
  check: '<path d="M20 6.5 9.2 17.3 4 12.1"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M21 4v4.6h-4.6"/>',
  logout: '<path d="M9.5 21H5.5A2 2 0 0 1 3.5 19V5a2 2 0 0 1 2-2h4"/><path d="M16 16.5 20.5 12 16 7.5M20.5 12H9.5"/>',
  folder: '<path d="M21.5 18.5a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h5l2 3h8a2 2 0 0 1 2 2z"/>',
  external:
    '<path d="M18 13.5v5.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5.5"/><path d="M14.5 3.5h6v6M20.5 3.5 11 13"/>',
  left: '<path d="M15 18.5 8.5 12 15 5.5"/>',
  right: '<path d="M9 5.5 15.5 12 9 18.5"/>',
  down: '<path d="M5.5 9 12 15.5 18.5 9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  trash:
    '<path d="M3.5 6.5h17M5.5 6.5l1 13.2a1.8 1.8 0 0 0 1.8 1.8h7.4a1.8 1.8 0 0 0 1.8-1.8l1-13.2M10 6.5V4.2A1.2 1.2 0 0 1 11.2 3h1.6A1.2 1.2 0 0 1 14 4.2v2.3"/>',
  list: '<path d="M8 6.5h12M8 12h12M8 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  film: '<rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="M7.5 4v16M16.5 4v16M2.5 12h19"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  zap: '<path d="M13.5 2.5 4 14h6l-1.5 7.5L18.5 10h-6z"/>',
  monitor: '<rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M8.5 20.5h7M12 16.5v4"/>',
  fire: '<path d="M12 21.5c3.6 0 6-2.4 6-5.8 0-4.3-4.5-5.4-4-11.2-3 1.3-5.5 4.3-5.5 7.4 0 1.3.5 2.3 1.2 3-1.6 0-2.7-.9-3.2-2.1-.3.9-.5 1.9-.5 2.9 0 3.4 2.4 5.8 6 5.8z"/>',
  note: '<path d="M5 3.5h9.5L19 8v12.5H5z"/><path d="M14 3.5V8h5M8.5 12.5h7M8.5 16h4"/>',
  pin: '<path d="M12 21.5s6.5-6.3 6.5-11a6.5 6.5 0 1 0-13 0c0 4.7 6.5 11 6.5 11z"/><circle cx="12" cy="10.5" r="2.4"/>',
  users:
    '<path d="M16.5 20.5v-1.6a3.9 3.9 0 0 0-3.9-3.9H6.9A3.9 3.9 0 0 0 3 18.9v1.6"/><circle cx="9.7" cy="8.2" r="3.6"/><path d="M21 20.5v-1.6a3.9 3.9 0 0 0-2.9-3.8M15.5 4.9a3.9 3.9 0 0 1 0 6.6"/>',
  calendar:
    '<rect x="3.2" y="5" width="17.6" height="16" rx="2"/><path d="M3.2 9.6h17.6M8 3.2v3.6M16 3.2v3.6"/>',
  pie: '<path d="M12 3.2v8.8h8.8A9 9 0 0 0 12 3.2z"/><path d="M20.4 14.4A9 9 0 1 1 9.6 3.6v9.9h9.9z"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  download: '<path d="M12 3.5v11.8M7.4 11l4.6 4.6L16.6 11"/><path d="M4 20.5h16"/>'
}
</script>

<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="stroke"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="ICONS[name] || ''"
  />
</template>

<style scoped>
.icon {
  flex: none;
  display: block;
}
</style>
