<template>
  <svg class="dropdown-chevron" :class="{'is-expanded': expanded}" width="16" height="16"
    viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
    <path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
</template>

<script setup>
defineProps({expanded: Boolean})
</script>

<style scoped>
.dropdown-chevron {
  display: block;
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
  color: var(--el-text-color-secondary);
  pointer-events: none;
  transition: transform var(--transition-fast);
}
.dropdown-chevron.is-expanded { transform: rotate(180deg); }
@media (prefers-reduced-motion: reduce) {
  .dropdown-chevron { transition: none; }
}
</style>
