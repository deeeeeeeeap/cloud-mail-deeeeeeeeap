<template>
  <div class="header">
    <div class="header-btn">
      <button class="menu-toggle icon-button" type="button" :aria-label="$t('toggleNavigation')" :aria-expanded="uiStore.asideShow" aria-controls="app-navigation" @click="changeAside">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></svg>
      </button>
      <span class="breadcrumb-item">{{ $t(route.meta.title) }}</span>
    </div>
    <button v-perm="'email:send'" class="writer-box" type="button"
         :class="{'writer-secondary': route.name === 'code-center'}"
         :disabled="writerOpening" :aria-busy="writerOpening" :aria-label="$t('composeMessage')" :title="$t('composeMessage')"
         @pointerenter="preloadWriter"
         @pointerdown="preloadWriter"
         @focus="preloadWriter"
         @click="openSend">
      <Icon icon="cloud-mail:compose" width="18" height="18"/>
      <span>{{ writerOpening ? $t('ux.writerLoading') : $t('composeMessage') }}</span>
    </button>
    <div class="toolbar">
      <button class="icon-button desktop-utility" type="button" :aria-label="$t('toggleTheme')" :aria-pressed="uiStore.dark" @click="openDark">
        <Icon :icon="uiStore.dark ? 'cloud-mail:sun' : 'cloud-mail:moon'" width="20" height="20"/>
      </button>
      <button class="icon-button desktop-utility" type="button" :aria-label="$t('noticeTitle')" @click="openNotice">
        <Icon icon="cloud-mail:notice" width="20" height="20"/>
      </button>
      <el-dropdown class="mobile-utility" trigger="click" placement="bottom-end">
        <button class="icon-button" type="button" :aria-label="$t('ux.moreActions')"><Icon icon="cloud-mail:more" width="20" height="20" /></button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item @click="openDark"><Icon :icon="uiStore.dark ? 'cloud-mail:sun' : 'cloud-mail:moon'" width="18" height="18" /> {{ $t('toggleTheme') }}</el-dropdown-item>
            <el-dropdown-item @click="openNotice"><Icon icon="cloud-mail:notice" width="18" height="18" /> {{ $t('noticeTitle') }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-dropdown ref="userinfoRef" trigger="click" placement="bottom-end" @visible-change="e => userInfoShow = e" popper-class="detail-dropdown">
        <button class="avatar" type="button" :aria-label="$t('accountMenu')" :aria-expanded="userInfoShow" @keydown.esc.stop="userinfoRef.handleClose()">
          <span class="avatar-text">{{ userInitial }}</span>
          <Icon class="setting-icon" icon="mingcute:down-small-fill" width="24" height="24"/>
        </button>
        <template #dropdown>
          <div class="user-details" @keydown.esc.stop="userinfoRef.handleClose()">
            <div class="profile-heading">
              <div class="details-avatar" aria-hidden="true">{{ userInitial }}</div>
              <div class="profile-identity">
                <div class="user-name">{{ userStore.user.name }}</div>
                <div class="detail-user-type">{{ userStore.user.role.name }}</div>
              </div>
            </div>
            <button class="detail-email" type="button" :title="$t('copyEmail')" @click="copyEmail(userStore.user.email)">
              {{ userStore.user.email }}
            </button>
            <dl class="action-info">
              <div class="quota-row">
                <dt>{{ $t('sendCount') }}</dt>
                <dd><span v-if="sendCount">{{ sendCount }}</span><span class="quota-period">{{ sendType }}</span></dd>
              </div>
              <div class="quota-row">
                <dt>{{ $t('accountCount') }}</dt>
                <dd>
                  <span v-if="settingStore.settings.manyEmail || settingStore.settings.addEmail">
                    {{ $t('disabled') }}
                  </span>
                  <span v-else-if="accountCount && hasPerm('account:add')">{{ $t('totalUserAccount', {msg: accountCount}) }}</span>
                  <span v-else-if="!accountCount && hasPerm('account:add')">{{ $t('unlimited') }}</span>
                  <span v-else-if="!hasPerm('account:add')">{{ $t('unauthorized') }}</span>
                </dd>
              </div>
            </dl>
            <div class="logout">
              <el-button :loading="logoutLoading" @click="clickLogout">{{ $t('logOut') }}</el-button>
            </div>
          </div>
        </template>
      </el-dropdown>
    </div>
  </div>
</template>

<script setup>
import {logout} from "@/request/login.js";
import {Icon} from "@iconify/vue";
import {useUiStore} from "@/store/ui.js";
import {useUserStore} from "@/store/user.js";
import {useRoute} from "vue-router";
import {computed, nextTick, ref} from "vue";
import {useSettingStore} from "@/store/setting.js";
import {hasPerm} from "@/perm/perm.js"
import {useI18n} from "vue-i18n";
import {clearAuthSession} from "@/session/auth-session.js";

const {t} = useI18n();
const route = useRoute();
const settingStore = useSettingStore();
const userStore = useUserStore();
const uiStore = useUiStore();
const logoutLoading = ref(false)
const writerOpening = ref(false)
const userInfoShow = ref(false)
const userinfoRef = ref(null)
const userInitial = computed(() => (userStore.user.name || userStore.user.email || '').slice(0, 1).toUpperCase())

const accountCount = computed(() => {
  return userStore.user.role.accountCount
})

const sendType = computed(() => {

  if (settingStore.settings.send === 1) {
    return t('disabled')
  }

  if (!hasPerm('email:send')) {
    return t('unauthorized')
  }

  if (userStore.user.role.sendType === 'ban') {
    return t('sendBanned')
  }

  if (userStore.user.role.sendType === 'internal') {
    return t('sendInternal')
  }

  if (!userStore.user.role.sendCount) {
    return t('unlimited')
  }

  if (userStore.user.role.sendType === 'day') {
    return t('daily')
  }

  if (userStore.user.role.sendType === 'count') {
    return t('total')
  }
})

const sendCount = computed(() => {


  if (!hasPerm('email:send')) {
    return null
  }

  if (userStore.user.role.sendType === 'ban') {
    return null
  }

  if (userStore.user.role.sendType === 'internal') {
    return null
  }

  if (!userStore.user.role.sendCount) {
    return null
  }

  if (settingStore.settings.send === 1) {
    return null
  }

  return userStore.user.sendCount + '/' + userStore.user.role.sendCount
})

async function copyEmail(email) {
  try {
    await navigator.clipboard.writeText(email);
    ElMessage({
      message: t('copySuccessMsg'),
      type: 'success',
      plain: true,
    })
  } catch (err) {
    console.error(`${t('copyFailMsg')}:`, err);
    ElMessage({
      message: t('copyFailMsg'),
      type: 'error',
      plain: true,
    })
  }
}

function openNotice() {
  uiStore.showNotice()
}

function openDark() {
  const nextIsDark = !uiStore.dark
  document.documentElement.classList.toggle('dark', nextIsDark)
  const metaTag = document.getElementById('theme-color-meta');
  const isMobile =  !window.matchMedia("(pointer: fine) and (hover: hover)").matches;
  metaTag?.setAttribute('content', nextIsDark ? (isMobile ? '#141414' : '#000000') : (isMobile ? '#FFFFFF' : '#F1F1F1'));
  uiStore.dark = nextIsDark
}

function preloadWriter() {
  uiStore.writerRef?.preload?.().catch(() => {})
}

async function openSend() {
  if (writerOpening.value) return
  writerOpening.value = true
  try {
    if (!uiStore.writerRef?.open) throw new Error('Writer unavailable')
    await uiStore.writerRef.open()
  } catch {
    ElMessage({message: t('ux.writerOpenFailed'), type: 'error'})
  } finally {
    writerOpening.value = false
  }
}

function changeAside() {
  uiStore.asideShow = !uiStore.asideShow
  if (uiStore.asideShow && window.innerWidth <= 1024) {
    nextTick(() => {
      const navigation = document.getElementById('app-navigation')
      const item = navigation?.querySelector('.is-active') || navigation?.querySelector('[role="menuitem"]')
      item?.focus()
    })
  }
}

async function clickLogout() {
  logoutLoading.value = true
  try {
    await logout()
  } finally {
    if (localStorage.getItem('token')) {
      await clearAuthSession()
    }
    logoutLoading.value = false
  }
}

</script>
<style>
.detail-dropdown {
  color: var(--el-text-color-primary) !important;
  border-radius: var(--radius-lg) !important;
}
</style>
<style lang="scss" scoped>

.user-details {
  width: min(320px, calc(100vw - 32px));
  padding: 20px;
  font-size: 14px;
  line-height: 1.5;
  .profile-heading { display: flex; align-items: center; gap: 12px; }
  .profile-identity { min-width: 0; }
  .user-name { font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
  .detail-user-type { color: var(--secondary-text-color); font-size: 12px; margin-top: 2px; }
  .details-avatar {
    display: grid; place-items: center; flex-shrink: 0;
    width: 44px; height: 44px; border-radius: 12px;
    color: var(--el-color-primary); background: var(--el-color-primary-light-9);
    font-size: 19px; font-weight: 600;
  }
  .detail-email {
    display: block; width: 100%; margin-top: 14px; text-align: left;
    color: var(--regular-text-color); overflow-wrap: anywhere; cursor: pointer;
    line-height: 1.6;
    &:hover { color: var(--el-color-primary); }
  }
  .action-info { margin: 18px 0; padding-top: 16px; border-top: 1px solid var(--el-border-color-light); }
  .quota-row {
    display: grid; grid-template-columns: minmax(0, 1fr) auto;
    align-items: baseline; gap: 16px;
    & + .quota-row { margin-top: 12px; }
    dt { color: var(--secondary-text-color); }
    dd { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; font-variant-numeric: tabular-nums; }
  }
  .logout .el-button { width: 100%; height: 36px; border-radius: var(--radius-md); }
}


.mobile-utility { display: none; }
.writer-box.writer-secondary { background: var(--el-fill-color-light); color: var(--el-text-color-regular); box-shadow: none; }
.writer-box.writer-secondary:hover { color: var(--el-bg-color); }
.writer-box:disabled { cursor: wait; opacity: .65; }

.header {
  display: flex;
  align-items: center;
  height: 100%;
  gap: 20px;
  padding: 0 24px 0 14px;
}

.header-btn {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  flex: 1;
}

.breadcrumb-item {
  font-weight: 600;
  font-size: 17px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.writer-box {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 16px;
  height: 40px;
  border-radius: var(--radius-md);
  background: var(--el-color-primary);
  color: var(--el-bg-color);
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 3px 8px rgb(76 97 213 / 18%);
  transition: background-color var(--transition-fast), transform var(--transition-fast), box-shadow var(--transition-fast);
  &:hover { background: var(--el-color-primary-dark-2); box-shadow: 0 4px 12px rgb(76 97 213 / 25%); }
  &:active { transform: translateY(1px); }
}

.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  font-size: 20px;
  border-radius: var(--radius-md);
  color: var(--regular-text-color);
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast);
  &:hover { background: var(--base-fill); }
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  .avatar {
    display: flex;
    align-items: center;
    cursor: pointer;
    margin-left: 8px;
    padding: 4px;
    gap: 3px;
    border-radius: var(--radius-md);
    &:hover { background: var(--base-fill); }
    .avatar-text {
      background: var(--el-color-primary-light-9);
      color: var(--el-color-primary);
      height: 32px;
      width: 32px;
      display: grid;
      place-items: center;
      border-radius: 10px;
      font-weight: 600;
    }
    .setting-icon { width: 18px; color: var(--secondary-text-color); }
  }
}

@media (max-width: 767px) {
  .header { gap: 8px; padding: 0 10px; }
  .header-btn { gap: 6px; }
  .breadcrumb-item { font-size: 15px; }
  .writer-box { padding: 0 10px; gap: 5px; }
  .toolbar { gap: 0; .avatar { margin-left: 4px; } }
  .toolbar .setting-icon { display: none; }
  .icon-button { width: 44px; height: 44px; }
  .toolbar .avatar { min-width: 44px; min-height: 44px; margin-left: 0; justify-content: center; }
  .desktop-utility { display: none; }
  .mobile-utility { display: inline-flex; }
  .writer-box { width: 44px; height: 44px; padding: 0; }
  .writer-box span { display: none; }
  .user-details { width: min(320px, calc(100vw - 24px)); padding: 16px; }
  .user-details .detail-email, .user-details .logout .el-button { min-height: 44px; }
}
</style>
