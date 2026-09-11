<template>
  <!-- Bundled, decorative artwork. The owning button supplies its accessible name. -->
  <svg class="refresh-list-icon" :class="{'is-refreshing': spinning}" width="20" height="20"
    viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path d="M18.5 3.75v4.5H14" />
    <path d="M18.5 8.25a7.5 7.5 0 1 0 .89 5.05" />
  </svg>
</template>

<script setup>
defineProps({spinning: {type: Boolean, default: false}})
</script>

<style scoped>
.refresh-list-icon { display: block; flex: 0 0 20px; transform-origin: center; }
.refresh-list-icon.is-refreshing { animation: refresh-list-turn 900ms linear infinite; }
@keyframes refresh-list-turn { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .refresh-list-icon.is-refreshing { animation: none; }
}
</style>
