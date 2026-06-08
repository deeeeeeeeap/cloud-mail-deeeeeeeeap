<template>
  <div :class="shouldShowAccountPanel ? 'main-box-show' : 'main-box-hide'">
    <div :class="shouldShowAccountPanel ? 'block-show' : 'block-hide'" @click="uiStore.accountShow = false"></div>
    <AccountPanel v-if="accountPanelMounted && hasAccountQueryPerm" :class="shouldShowAccountPanel ? 'show' : 'hide'" />
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
let  innerWidth =  window.innerWidth

let elNotification = null
const noticeStyleId = 'cloud-mail-notice-style'
const accountPanelMounted = ref(false)

const accountShow = computed(() => {
  return uiStore.accountShow && settingStore.settings.manyEmail === 0
})

const hasAccountQueryPerm = computed(() => hasPerm('account:query'))

const shouldShowAccountPanel = computed(() => {
  return accountShow.value && hasAccountQueryPerm.value
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
  if (['content','email','send'].includes(route.meta.name)) {
    if (innerWidth !==  window.innerWidth) {
      innerWidth = window.innerWidth;
      uiStore.accountShow = window.innerWidth >= 767;
    }
  }
}

</script>
<style lang="scss" scoped>

.block-show {
  position: fixed;
  @media (max-width: 767px) {
    position: absolute;
    right: 0;
    border: 0;
    height: 100%;
    width: 100%;
    background: #000000;
    opacity: 0.6;
    z-index: 10;
    transition: all 300ms;
  }
}

.block-hide {
  position: fixed;
  pointer-events: none;
  transition: all 300ms;
}

.show {
  transition: all 100ms;
  @media (max-width: 767px) {
    position: fixed;
    z-index: 100;
    width: 260px;
  }
}

.hide {
  transition: all 100ms;
  position: fixed;
  transform: translateX(-100%);
  opacity: 0;
  @media (max-width: 1024px) {
    width: 260px;
    z-index: 100;
  }
}


.main-box-show {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  height: calc(100% - 60px);
  min-width: 0;
  overflow: hidden;
  @media (max-width: 767px) {
    grid-template-columns: minmax(0, 1fr);
  }
}

.main-box-hide {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  height: calc(100% - 60px);
  min-width: 0;
  overflow: hidden;
}


.main-view {
  background: var(--el-bg-color);
  min-width: 0;
  width: 100%;
  overflow: hidden;
}


.navigation {
  height: 30px;
  border-bottom: solid 1px var(--el-menu-border-color);
  display: inline-flex;
  justify-items: center;
  align-items: center;
  width: 100%;
  .tag {
    background: var(--el-bg-color);
    margin-left: 5px;
  }
}
</style>
