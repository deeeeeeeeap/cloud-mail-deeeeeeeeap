<template>
  <div class="main-box" :class="{'with-accounts': shouldShowAccountPanel}">
    <div class="account-overlay" :class="{'is-open': shouldShowAccountPanel}" @click="uiStore.accountShow = false"></div>
    <div class="account-panel" :class="{'is-open': shouldShowAccountPanel}" :inert="!shouldShowAccountPanel" @keydown.esc="uiStore.accountShow = false">
      <AccountPanel v-if="accountPanelMounted && hasAccountQueryPerm" />
    </div>
    <router-view class="main-view" v-slot="{ Component,route }">
      <keep-alive :include="['email','all-email','send','sys-setting','star','user','role','analysis','reg-key','draft']">
        <component :is="Component" :key="route.name"/>
      </keep-alive>
    </router-view>
  </div>
</template>
<script setup>
import {useUiStore} from "@/store/ui.js";
import {useSettingStore} from "@/store/setting.js";
import {computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch} from "vue";
import { useRoute } from 'vue-router'
import { hasPerm } from "@/perm/perm.js"
import {sanitizeHtml} from "@/utils/html-sanitize.js";

const AccountPanel = defineAsyncComponent(() => import('@/layout/account/index.vue'))
const settingStore = useSettingStore()
const uiStore = useUiStore();
const route = useRoute()
let accountPanelDesktop = window.innerWidth > 767

let elNotification = null
const noticeStyleId = 'cloud-mail-notice-style'
const accountPanelMounted = ref(false)

const accountShow = computed(() => {
  return uiStore.accountShow && settingStore.settings.manyEmail === 0
})

const hasAccountQueryPerm = computed(() => hasPerm('account:query'))

const shouldShowAccountPanel = computed(() => {
  return accountShow.value && hasAccountQueryPerm.value
      && ['email', 'send', 'content'].includes(route.name)
})

watch(shouldShowAccountPanel, (show) => {
  if (show) {
    accountPanelMounted.value = true
  }
}, {immediate: true})

watch(() => uiStore.changeNotice, () => {

  const settings = settingStore.settings

  let data = {
    notice: settings.notice,
    noticeWidth: settings.noticeWidth,
    noticeTitle: settings.noticeTitle,
    noticeContent: settings.noticeContent,
    noticeType: settings.noticeType,
    noticeDuration: settings.noticeDuration,
    noticePosition: settings.noticePosition,
    noticeOffset: settings.noticeOffset
  }

  showNotice(data)
})

watch(() => uiStore.changePreview, () => {
  showNotice(uiStore.previewData)
})

function showNotice(data) {

  if (data.notice === 1) {
    return;
  }

  if (elNotification) {
    elNotification.close()
  }

  updateNoticeStyle(data.noticeWidth)

  elNotification = ElNotification({
    title: data.noticeTitle,
    message: `<div style="width: 100%;height: 100%;white-space: pre;word-break: normal;overflow-x: auto;">${sanitizeHtml(data.noticeContent)}</div>`,
    type: data.noticeType === 'none' ? '' : data.noticeType,
    duration: data.noticeDuration,
    position: data.noticePosition,
    offset: data.noticeOffset,
    dangerouslyUseHTMLString: true,
    customClass: 'custom-notice'
  })
}

function updateNoticeStyle(noticeWidth) {
  const width = Number(noticeWidth)
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 400
  let style = document.getElementById(noticeStyleId)

  if (!style) {
    style = document.createElement('style')
    style.id = noticeStyleId
    document.head.appendChild(style)
  }

  style.textContent = `
  .custom-notice.el-notification {
    --el-notification-width: min(${safeWidth}px, calc(100% - 30px)) !important;
  }
  `
}

onMounted(() => {
  window.addEventListener('resize', handleResize)
  handleResize()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
  if (elNotification) {
    elNotification.close()
    elNotification = null
  }
  document.getElementById(noticeStyleId)?.remove()
})

const handleResize = () => {
  const desktop = window.innerWidth > 767
  if (desktop === accountPanelDesktop) return
  accountPanelDesktop = desktop
  if (['content', 'email', 'send'].includes(route.name)) uiStore.accountShow = desktop
}

</script>
<style lang="scss" scoped>

.account-overlay {
  position: absolute;
  inset: 0;
  z-index: 10;
  opacity: 0;
  pointer-events: none;
  background: rgb(15 23 42 / 48%);
  transition: opacity var(--transition-base);
  @media (max-width: 767px) {
    &.is-open {
      opacity: 1;
      pointer-events: auto;
    }
  }
}

.account-panel {
  position: absolute;
  inset: 0 auto 0 0;
  z-index: 100;
  width: 228px;
  min-height: 0;
  background: var(--extra-light-fill);
  visibility: hidden;
  pointer-events: none;
  transform: translateX(-100%);
  transition: transform var(--transition-base), visibility var(--transition-base);
  @media (max-width: 767px) {
    width: 260px;
  }

  &.is-open {
    visibility: visible;
    pointer-events: auto;
    // Restore viewport positioning for the account dialogs after the slide.
    transform: none;
    @media (min-width: 768px) {
      position: relative;
    }
  }
}


.main-box {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  height: calc(100% - var(--header-height));
  min-width: 0;
  overflow: hidden;
  &.with-accounts {
    grid-template-columns: 228px minmax(0, 1fr);
    @media (max-width: 767px) { grid-template-columns: minmax(0, 1fr); }
  }
}
.main-view {
  background: var(--el-bg-color);
  min-width: 0;
  width: 100%;
  overflow: hidden;
}
</style>
