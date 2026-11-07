<template>
  <el-scrollbar class="navigation-scroll">
    <nav :aria-label="settingStore.settings.title">
      <div class="brand">
        <span class="brand-mark"><Icon icon="cloud-mail:mail" width="24" height="24" /></span>
        <span class="brand-name">{{ settingStore.settings.title }}</span>
      </div>
      <el-menu :default-active="route.meta.name" @select="navigate">
        <template v-for="group in visibleGroups" :key="group.label">
          <li v-if="group.label" class="manage-title" role="presentation">{{ $t(group.label) }}</li>
          <el-menu-item v-for="item in group.items" :key="item.name" :index="item.name"
                        @mouseenter="prefetchRoute(item.name)" @focus="prefetchRoute(item.name)">
            <Icon :icon="item.icon" width="20" height="20" aria-hidden="true" />
            <span>{{ $t(item.label) }}</span>
          </el-menu-item>
        </template>
      </el-menu>
    </nav>
  </el-scrollbar>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Icon } from '@iconify/vue/offline'
import { useSettingStore } from '@/store/setting.js'
import { useUiStore } from '@/store/ui.js'
import { hasPerm } from '@/perm/perm.js'
import { createRoutePrefetcher } from '@/utils/route-prefetch.js'

const settingStore = useSettingStore()
const uiStore = useUiStore()
const route = useRoute()
const router = useRouter()
// 悬停或聚焦菜单时先下载页面 chunk（例如分析页的 echarts），点击后不必再等
const prefetchRoute = createRoutePrefetcher(router)
const groups = [
  { label: '', items: [
    { name: 'email', label: 'inbox', icon: 'cloud-mail:inbox' },
    { name: 'send', label: 'sent', icon: 'cloud-mail:send', permission: 'email:send' },
    { name: 'draft', label: 'drafts', icon: 'cloud-mail:draft', permission: 'email:send' },
    { name: 'star', label: 'starred', icon: 'cloud-mail:star' },
    { name: 'code-center', label: 'codeCenter', icon: 'cloud-mail:code' },
    { name: 'setting', label: 'settings', icon: 'cloud-mail:user' },
  ] },
  { label: 'manage', items: [
    { name: 'analysis', label: 'analytics', icon: 'cloud-mail:chart', permission: 'analysis:query' },
    { name: 'user', label: 'allUsers', icon: 'cloud-mail:user', permission: 'user:query' },
    { name: 'all-email', label: 'allMail', icon: 'cloud-mail:mail', permission: 'all-email:query' },
    { name: 'role', label: 'permissions', icon: 'cloud-mail:lock', permission: 'role:query' },
    { name: 'reg-key', label: 'inviteCode', icon: 'cloud-mail:key', permission: 'reg-key:query' },
    { name: 'sys-setting', label: 'SystemSettings', icon: 'cloud-mail:settings', permission: 'setting:query' },
    { name: 'api-key', label: 'apiKeys', icon: 'cloud-mail:api', permission: 'api-key:manage' },
    { name: 'maintenance', label: 'maintenance', icon: 'cloud-mail:tools', permission: 'maintenance:query' },
  ] },
]
const visibleGroups = computed(() => groups.map(group => ({
  ...group, items: group.items.filter(item => !item.permission || hasPerm(item.permission))
})).filter(group => group.items.length))

function navigate(name) {
  router.push({ name })
  if (window.innerWidth <= 1024) uiStore.asideShow = false
}
</script>

<style lang="scss" scoped>
.navigation-scroll { width: 216px; background: var(--aside-background); color: var(--nav-text); }
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 84px;
  padding: 0 20px;
  font-size: 19px;
  font-weight: 650;
  color: #eff5ff;
  letter-spacing: -0.5px;
  font-family: "Segoe UI Variable Display", "Segoe UI", "Microsoft YaHei", sans-serif;
}
.brand-mark {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 11px 11px 11px 3px;
  background: var(--brand-accent);
  color: var(--aside-background);
  transform: rotate(-6deg);
}
.brand-name { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.el-menu {
  border: 0;
  padding: 0 14px 24px;
  --el-menu-bg-color: transparent;
  --el-menu-text-color: var(--nav-text);
  --el-menu-hover-bg-color: var(--nav-hover);
  --el-menu-active-color: var(--nav-active-text);
}
.el-menu-item {
  height: 44px;
  margin: 4px 0;
  padding: 0 12px !important;
  gap: 12px;
  border-radius: var(--radius-md);
  transition: background-color var(--transition-fast), color var(--transition-fast);
  svg { flex-shrink: 0; }
  &.is-active { background: var(--nav-active); font-weight: 600; box-shadow: 0 2px 6px rgb(0 0 0 / 8%); }
  &:focus-visible { outline-color: var(--brand-accent); outline-offset: 2px; }
}
.manage-title {
  margin: 28px 12px 10px;
  font-size: 12px;
  color: var(--nav-heading);
  letter-spacing: 0.08em;
}
</style>
