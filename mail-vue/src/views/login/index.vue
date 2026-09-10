<template>
  <div id="login-box" :class="{'has-custom-background': !!settingStore.settings.background}" v-loading="oauthLoading" :element-loading-text="$t('loginLoading')">
    <div v-if="settingStore.settings.background" class="login-background" :class="{'login-background-ready': backgroundReady}" :style="background"></div>
    <div class="form-wrapper">
      <div v-if="!settingStore.settings.background" class="login-art" aria-hidden="true">
        <div class="letter-sheet"><span></span><span></span><span></span><Icon icon="cloud-mail:mail" width="36" height="36"/></div>
        <div class="letter-envelope"></div>
        <div class="letter-seal"><Icon icon="cloud-mail:send" width="28" height="28"/></div>
      </div>
      <div class="container">
        <span class="form-title">{{ settingStore.settings.title }}</span>
        <span class="form-desc" v-if="show === 'login'">{{ $t('loginTitle') }}</span>
        <span class="form-desc" v-else>{{ $t('regTitle') }}</span>
        <div v-show="show === 'login'">
          <el-input :class="!hideLoginDomain ? 'email-input' : ''" v-model="form.email"
                    type="text" :placeholder="$t('emailAccount')" autocomplete="off">
            <template #append v-if="!hideLoginDomain">
              <div @click.stop="openSelect">
                <el-select
                    v-if="show === 'login'"
                    ref="mySelect"
                    @visible-change="selectOpen = $event"
                    v-model="suffix"
                    :placeholder="$t('select')"
                    class="select"
                >
                  <el-option
                      v-for="item in domainList"
                      :key="item"
                      :label="item"
                      :value="item"
                  />
                </el-select>
                <div class="select-trigger-label">
                  <span :title="suffix">{{ suffix }}</span>
                  <DropdownChevron :expanded="selectOpen"/>
                </div>
              </div>
            </template>
          </el-input>
          <el-input v-model="form.password" :placeholder="$t('password')" type="password" autocomplete="off">
          </el-input>
          <el-button class="btn" type="primary" @click="submit" :loading="loginLoading"
          >{{ $t('loginBtn') }}
          </el-button>
          <el-button class="btn" v-if="settingStore.settings.linuxdoSwitch"  style="margin-top: 10px"  @click="linuxDoLogin">
            <el-avatar src="/image/linuxdo.webp" :size="18" style="margin-right: 10px" />LinuxDo
          </el-button>
        </div>
        <div v-show="show !== 'login'">
          <el-input :class="!hideLoginDomain ? 'email-input' : ''" v-model="registerForm.email" type="text" :placeholder="$t('emailAccount')"
                    autocomplete="off">
            <template #append v-if="!hideLoginDomain">
              <div @click.stop="openSelect">
                <el-select
                    v-if="show !== 'login'"
                    ref="mySelect"
                    @visible-change="selectOpen = $event"
                    v-model="suffix"
                    :placeholder="$t('select')"
                    class="select"
                >
                  <el-option
                      v-for="item in domainList"
                      :key="item"
                      :label="item"
                      :value="item"
                  />
                </el-select>
                <div class="select-trigger-label">
                  <span :title="suffix">{{ suffix }}</span>
                  <DropdownChevron :expanded="selectOpen"/>
                </div>
              </div>
            </template>
          </el-input>
          <el-input v-model="registerForm.password" :placeholder="$t('password')" type="password" autocomplete="off"/>
          <el-input v-model="registerForm.confirmPassword" :placeholder="$t('confirmPwd')" type="password"
                    autocomplete="off"/>
          <el-input v-if="settingStore.settings.regKey === 0" v-model="registerForm.code" :placeholder="$t('regKey')"
                    type="text" autocomplete="off"/>
          <el-input v-if="settingStore.settings.regKey === 2" v-model="registerForm.code"
                    :placeholder="$t('regKeyOptional')" type="text" autocomplete="off"/>
          <div v-show="verifyShow"
               class="register-turnstile"
               :data-sitekey="settingStore.settings.siteKey"
               data-action="register"
               data-callback="onLoginTurnstileSuccess"
               data-error-callback="onLoginTurnstileError"
          >
            <span style="font-size: 12px;color: #F56C6C" v-if="botJsError">{{ $t('verifyModuleFailed') }}</span>
          </div>
          <el-button class="btn" style="margin: 0" type="primary" @click="submitRegister" :loading="registerLoading"
          >{{ $t('regBtn') }}
          </el-button>
          <el-button v-if="settingStore.settings.linuxdoSwitch" class="btn" style="margin-top: 10px"  @click="linuxDoLogin">
            <el-avatar src="/image/linuxdo.webp" :size="18" style="margin-right: 10px" />LinuxDo
          </el-button>
        </div>
        <template v-if="settingStore.settings.register === 0">
          <button type="button" class="switch" @click="show = 'register'" v-if="show === 'login'">{{ $t('noAccount') }}
            <span>{{ $t('regSwitch') }}</span>
          </button>
          <button type="button" class="switch" @click="show = 'login'" v-else>{{ $t('hasAccount') }} <span>{{ $t('loginSwitch') }}</span>
          </button>
        </template>
      </div>
    </div>
    <el-dialog class="bind-dialog" v-model="showBindForm"  :title="$t('bindEmailTitle')" >
      <div class="bind-container">
        <el-input :class="!hideLoginDomain ? 'email-input' : ''" v-model="bindForm.email" type="text" :placeholder="$t('emailAccount')" autocomplete="off">
          <template #append v-if="!hideLoginDomain">
            <div @click.stop="openSelect">
              <el-select
                  ref="bindSelect"
                  @visible-change="bindSelectOpen = $event"
                  v-model="suffix"
                  :placeholder="$t('select')"
                  class="select"
              >
                <el-option
                    v-for="item in domainList"
                    :key="item"
                    :label="item"
                    :value="item"
                />
              </el-select>
              <div class="select-trigger-label">
                <span :title="suffix">{{ suffix }}</span>
                <DropdownChevron :expanded="bindSelectOpen"/>
              </div>
            </div>
          </template>
        </el-input>
        <el-input v-if="settingStore.settings.regKey === 0" v-model="bindForm.code" :placeholder="$t('regKey')"
                  type="text" autocomplete="off"/>
        <el-input v-if="settingStore.settings.regKey === 2" v-model="bindForm.code"
                  :placeholder="$t('regKeyOptional')" type="text" autocomplete="off"/>
        <el-button class="btn" type="primary" @click="bind" :loading="bindLoading"
        >{{ $t('bind') }}
        </el-button>
      </div>
    </el-dialog>
    <a v-show="settingStore.settings.projectLink" class="github" :href="settingStore.settings.projectLink">
      <Icon icon="mingcute:github-line" color="#1890ff" width="20" height="20" />
    </a>
  </div>
</template>

<script setup>
import DropdownChevron from "@/components/dropdown-chevron/index.vue";
import router from "@/router";
import {computed, nextTick, onMounted, onUnmounted, reactive, ref, watch} from "vue";
import {login} from "@/request/login.js";
import {register} from "@/request/login.js";
import {websiteConfig} from "@/request/setting.js";
import {isEmail} from "@/utils/verify-utils.js";
import {useSettingStore} from "@/store/setting.js";
import {useAccountStore} from "@/store/account.js";
import {useUserStore} from "@/store/user.js";
import {useUiStore} from "@/store/ui.js";
import {Icon} from "@iconify/vue";
import {cvtR2Url} from "@/utils/convert.js";
import {loginUserInfo} from "@/request/my.js";
import {permsToRouter} from "@/perm/perm.js";
import {useI18n} from "vue-i18n";
import {oauthBindUser, oauthLinuxDoAuthorize, oauthLinuxDoLogin} from "@/request/ouath.js";
import {
  LINUXDO_OAUTH_STATE_KEY,
  consumeLinuxDoCallback,
  exchangeLinuxDoCallback,
  prepareLinuxDoAuthorization
} from "@/views/login/oauth-flow.js";
import {
  clearAuthSession,
  installDynamicRoutes,
  startAuthSession
} from "@/session/auth-session.js";
import {queueLoginBackground} from "@/views/login/login-background.js";
import {consumePrefetchLoginBackground} from "@/views/login/login-background-prefetch.js";

const {t} = useI18n();
const accountStore = useAccountStore();
const userStore = useUserStore();
const uiStore = useUiStore();
const settingStore = useSettingStore();
const loginLoading = ref(false)
const bindLoading = ref(false)
const oauthLoading = ref(false);
const showBindForm = ref(false);
const show = ref('login')

const bindForm = reactive({
  email: '',
  bindToken: '',
  code: ''
})

const form = reactive({
  email: '',
  password: '',

});
const selectOpen = ref(false)
const mySelect = ref()
const bindSelect = ref()
const bindSelectOpen = ref(false)
const suffix = ref('')
const registerForm = reactive({
  email: '',
  password: '',
  confirmPassword: '',
  code: null
})
const domainList = settingStore.domainList;
const registerLoading = ref(false)
suffix.value = domainList[0]
const verifyShow = ref(false)
let verifyToken = ''
let turnstileId = null
let botJsError = ref(false)
let verifyErrorCount = 0

let verifyRetryTimer = null

// Turnstile 按名字从 window 取回调，所以只能挂全局；但名字必须每个组件独立，
// 账号面板也有一个 turnstile，共用同一组名字时后挂载的会静默顶掉先挂载的
function onLoginTurnstileSuccess(token) {
  verifyToken = token;
}

function onLoginTurnstileError(e) {
  if (verifyErrorCount >= 4) {
    return
  }
  verifyErrorCount++
  console.warn('人机验加载失败', e)
  verifyRetryTimer = setTimeout(() => {
    nextTick(renderTurnstile)
  }, 1500)
}

async function renderTurnstile() {
  try {
    const {loadTurnstile} = await import("@/utils/turnstile-loader.js");
    const turnstile = await loadTurnstile();
    if (!turnstileId) {
      turnstileId = turnstile.render('.register-turnstile')
    } else {
      turnstile.reset(turnstileId)
    }
    botJsError.value = false
  } catch (e) {
    botJsError.value = true
    console.warn('人机验证js加载失败', e)
  }
}

const loginOpacity = computed(() => {
  const opacity = settingStore.settings.loginOpacity
  return uiStore.dark ? `rgba(0, 0, 0, ${opacity})` : `rgba(255, 255, 255, ${opacity})`
})

const hideLoginDomain = computed(() => settingStore.settings.loginDomain === 1)
const loadedBackgroundUrl = ref('')
const backgroundReady = ref(false)
let cancelBackgroundLoad = () => {}
let stopBackgroundWatch = () => {}

const background = computed(() => {
  return loadedBackgroundUrl.value ? {
    'background-image': `url(${loadedBackgroundUrl.value})`,
    'background-repeat': 'no-repeat',
    'background-size': 'cover',
    'background-position': 'center'
  } : ''
})

onMounted(() => {
  window.onLoginTurnstileSuccess = onLoginTurnstileSuccess
  window.onLoginTurnstileError = onLoginTurnstileError

  stopBackgroundWatch = watch(() => settingStore.settings.background, value => {
    cancelBackgroundLoad()
    loadedBackgroundUrl.value = ''
    backgroundReady.value = false
    if (!value) return

    const src = cvtR2Url(value)
    // 复用 init 阶段预取的 Image，避免重复下载
    const prefetchedImage = consumePrefetchLoginBackground(src)
    cancelBackgroundLoad = queueLoginBackground(src, {
      reuseImage: prefetchedImage || undefined,
      onReady: decodedSrc => {
        loadedBackgroundUrl.value = decodedSrc
        nextTick(() => {
          const reveal = () => {
            backgroundReady.value = true
          }
          if (typeof globalThis.requestAnimationFrame === 'function') {
            globalThis.requestAnimationFrame(reveal)
          } else {
            globalThis.setTimeout(reveal, 0)
          }
        })
      },
      onError: error => {
        console.warn('背景图片加载失败:', error)
      }
    })
  }, {immediate: true})
})

onUnmounted(() => {
  delete window.onLoginTurnstileSuccess
  delete window.onLoginTurnstileError
  clearTimeout(verifyRetryTimer)
  stopBackgroundWatch()
  cancelBackgroundLoad()
})

const openSelect = () => {
  const select = showBindForm.value ? bindSelect.value : mySelect.value
  select?.focus()
  select?.toggleMenu()
}

const getFullEmail = (email) => {
  return hideLoginDomain.value ? email : email + suffix.value
}

const getEmailName = (email) => {
  return email.split('@')[0]
}

async function linuxDoLogin() {
  oauthLoading.value = true
  try {
    const authorization = prepareLinuxDoAuthorization(await oauthLinuxDoAuthorize())
    sessionStorage.setItem(LINUXDO_OAUTH_STATE_KEY, authorization.state)
    window.location.assign(authorization.authorizationUrl)
  } catch {
    try {
      sessionStorage.removeItem(LINUXDO_OAUTH_STATE_KEY)
    } catch {
      // OAuth cannot continue safely when session storage is unavailable.
    }
    oauthLoading.value = false
  }
}

linuxDoGetUser().catch(() => {
  oauthLoading.value = false
});

async function linuxDoGetUser() {
  const callback = consumeLinuxDoCallback(window.location.href, sessionStorage)
  if (callback.status === 'none') {
    return
  }

  window.history.replaceState({}, '', callback.cleanUrl)

  if (callback.status !== 'ready') {
    ElMessage({
      message: t('oauthFlowInvalidMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  oauthLoading.value = true
  try {
    const data = await exchangeLinuxDoCallback(callback, oauthLinuxDoLogin)
    bindForm.bindToken = data.bindToken || '';

    if (!data.token) {
      showBindForm.value = true
      oauthLoading.value = false
      ElMessage({
        message: t('bindEmailMsg'),
        type: 'warning',
        duration: 4000,
        plain: true,
      })
      return;
    }

    await saveToken(data.token);
  } catch {
    oauthLoading.value = false
  }
}

function bind() {

  if (!bindForm.email) {
    ElMessage({
      message: t('emptyEmailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }


  if (getEmailName(bindForm.email).length < settingStore.settings.minEmailPrefix) {
    ElMessage({
      message: t('minEmailPrefix', {msg: settingStore.settings.minEmailPrefix}),
      type: 'error',
      plain: true,
    })
    return
  }

  let email = getFullEmail(bindForm.email);


  if (!isEmail(email)) {
    ElMessage({
      message: t('notEmailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (settingStore.settings.regKey === 0) {

    if (!bindForm.code) {

      ElMessage({
        message: t('emptyRegKeyMsg'),
        type: 'error',
        plain: true,
      })
      return
    }

  }

  const form = {email, bindToken: bindForm.bindToken, code: bindForm.code}

  bindLoading.value = true
  oauthBindUser(form).then(data => {
    return saveToken(data.token)
  }).catch(() => {
    bindLoading.value = false
  })
}

const submit = () => {

  if (!form.email) {
    ElMessage({
      message: t('emptyEmailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  let email = getFullEmail(form.email);

  if (!isEmail(email)) {
    ElMessage({
      message: t('notEmailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (!form.password) {
    ElMessage({
      message: t('emptyPwdMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  loginLoading.value = true
  login(email, form.password).then(async data => {
    await saveToken(data.token)
  }).catch(() => {}).finally(() => {
    loginLoading.value = false
  })
}

async function saveToken(token) {
  startAuthSession(token)
  refreshWebsiteConfig()
  try {
    const user = await loginUserInfo();
    accountStore.currentAccountId = user.account.accountId;
    accountStore.currentAccount = user.account;
    userStore.user = user;
    const routers = permsToRouter(user.permKeys);
    installDynamicRoutes(router, routers);
    await router.replace({name: 'layout'})
  } catch (e) {
    // 用户信息拉取失败则不能保留登录态，否则后续进入主界面会因空用户信息崩溃
    if (localStorage.getItem('token')) {
      await clearAuthSession({redirect: false})
    }
    throw e
  } finally {
    oauthLoading.value = false;
    bindLoading.value = false;
  }
  uiStore.showNotice()
}

function refreshWebsiteConfig() {
  websiteConfig().then(setting => {
    settingStore.settings = setting
    settingStore.domainList = setting.domainList
    if (!suffix.value && setting.domainList.length > 0) {
      suffix.value = setting.domainList[0]
    }
    document.title = setting.title
  }).catch(e => {
    console.error(e)
  })
}


function submitRegister() {

  if (!registerForm.email) {
    ElMessage({
      message: t('emptyEmailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (getEmailName(registerForm.email).length < settingStore.settings.minEmailPrefix) {
    ElMessage({
      message: t('minEmailPrefix', {msg: settingStore.settings.minEmailPrefix}),
      type: 'error',
      plain: true,
    })
    return
  }

  const email = getFullEmail(registerForm.email);

  if (!isEmail(email)) {
    ElMessage({
      message: t('notEmailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (!registerForm.password) {
    ElMessage({
      message: t('emptyPwdMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (registerForm.password.length < 6) {
    ElMessage({
      message: t('pwdLengthMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (registerForm.password !== registerForm.confirmPassword) {

    ElMessage({
      message: t('confirmPwdFailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (settingStore.settings.regKey === 0) {

    if (!registerForm.code) {

      ElMessage({
        message: t('emptyRegKeyMsg'),
        type: 'error',
        plain: true,
      })
      return
    }

  }

  if (!verifyToken && (settingStore.settings.registerVerify === 0 || (settingStore.settings.registerVerify === 2 && settingStore.settings.regVerifyOpen))) {
    if (!verifyShow.value) {
      verifyShow.value = true
      nextTick(renderTurnstile)
    } else if (!botJsError.value) {
      ElMessage({
        message: t('botVerifyMsg'),
        type: "error",
        plain: true
      })
    }
    return;
  }

  registerLoading.value = true

  const form = {
    email,
    password: registerForm.password,
    token: verifyToken,
    code: registerForm.code
  }

  register(form).then(({regVerifyOpen}) => {
    show.value = 'login'
    registerForm.email = ''
    registerForm.password = ''
    registerForm.confirmPassword = ''
    registerForm.code = ''
    registerLoading.value = false
    verifyToken = ''
    settingStore.settings.regVerifyOpen = regVerifyOpen
    verifyShow.value = false
    ElMessage({
      message: t('regSuccessMsg'),
      type: 'success',
      plain: true,
    })
  }).catch(res => {

    registerLoading.value = false

    if (res.code === 400) {
      verifyToken = ''
      settingStore.settings.regVerifyOpen = true
      verifyShow.value = true
      nextTick(renderTurnstile)

    }
  });
}

</script>


<style>
.el-select-dropdown__item {
  padding: 0 15px;
}

.no-autofill-pwd {
  .el-input__inner {
    -webkit-text-security: disc !important;
  }
}
</style>

<style lang="scss" scoped>

.form-wrapper {
  position: relative;
  z-index: 1;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: clamp(60px, 8vw, 140px);
  padding: 48px 20px;
}

#login-box.has-custom-background .form-wrapper {
  position: fixed;
  inset: 0 0 0 auto;
  width: min(480px, 100%);
  padding: 0;
  display: flex;
  justify-content: stretch;
  align-items: stretch;
  gap: 0;
  border-left: 1px solid rgb(255 255 255 / 22%);
  box-shadow: -18px 0 48px rgb(7 19 36 / 14%);
  backdrop-filter: blur(14px);
}

.container {
  background: v-bind(loginOpacity);
  padding: 40px;
  display: flex;
  flex-direction: column;
  width: min(420px, 100%);
  border: 1px solid var(--el-border-color-light);
  border-radius: 24px;
  box-shadow: 0 24px 80px rgb(9 20 39 / 18%);
  flex-shrink: 0;
  @media (max-width: 767px) { padding: 28px 24px; }

  .btn {
    height: 44px;
    width: 100%;
    border-radius: var(--radius-md);
    transition: transform var(--transition-fast), box-shadow var(--transition-fast),
      background-color var(--transition-fast), border-color var(--transition-fast);

  }

  .form-desc {
    margin-top: 6px;
    margin-bottom: 22px;
    font-size: 14px;
    color: var(--form-desc-color);
  }

  .form-title {
    font-weight: bold;
    font-size: 26px;
    letter-spacing: 0;
    font-family: "Segoe UI Variable Display", "Segoe UI", "Microsoft YaHei", sans-serif;
  }

  .switch {
    color: var(--el-text-color-primary);
    cursor: pointer;
    margin-top: 20px;
    text-align: center;

    span {
      color: var(--login-switch-color);
      cursor: pointer;
      transition: opacity var(--transition-fast);

      &:hover {
        opacity: 0.75;
        text-decoration: underline;
        text-underline-offset: 3px;
      }
    }
  }

  :deep(.el-input__wrapper) {
    border-radius: var(--radius-md);
    background: var(--el-bg-color);
    transition: box-shadow var(--transition-fast);
  }

  .email-input :deep(.el-input__wrapper) {
    border-radius: var(--radius-md) 0 0 var(--radius-md);
    background: var(--el-bg-color);
  }

  .el-input {
    height: 44px;
    width: 100%;
    margin-bottom: 18px;

    :deep(.el-input__inner) {
      height: 42px;
    }
  }
}

#login-box.has-custom-background .container {
  width: 100%;
  max-width: none;
  height: 100%;
  justify-content: center;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  padding: clamp(28px, 5vw, 64px);
}

:deep(.el-select-dropdown__item) {
  padding: 0 10px;
}

:deep(.bind-dialog) {
  width: 400px !important;
  @media (max-width: 440px) {
    width: calc(100% - 40px) !important;
    margin-right: 20px !important;
    margin-left: 20px !important;
  }
}

.bind-container {
  display: grid;
  grid-template-columns: 1fr;
  gap: 15px;
}

.github {
  position: fixed;
  width: 35px;
  height: 35px;
  display: flex;
  justify-content: center;
  align-items: center;
  border-radius: 50%;
  background: var(--el-bg-color);
  bottom: 10px;
  right: 10px;
  z-index: 1000;
  border: 1px solid var(--el-border-color-light);
  box-shadow: var(--el-box-shadow-light);
  cursor: pointer;
  transition: transform var(--transition-base), box-shadow var(--transition-base);

  &:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-card-hover);
  }
}

:deep(.el-input-group__append) {
  padding: 0 !important;
  padding-left: 8px !important;
  padding-right: 4px !important;
  background: var(--el-bg-color);
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
}

:deep(.el-button+.el-button) {
  margin: 0;
}

.register-turnstile {
  margin-bottom: 18px;
}

.select {
  position: absolute;
  right: 30px;
  width: 100px;
  opacity: 0;
  pointer-events: none;
}

#login-box {
  position: relative;
  isolation: isolate;
  background: #142b45;
  min-height: 100%;
  overflow-x: hidden;
}

#login-box:not(.has-custom-background)::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background:
    linear-gradient(118deg, rgb(93 190 193 / 20%), transparent 38%),
    linear-gradient(300deg, rgb(229 183 113 / 14%), transparent 34%),
    #142b45;
}

.login-art {
  position: relative;
  width: 330px;
  height: 300px;
  flex-shrink: 0;
  transform: rotate(-8deg);
  @media (max-width: 900px) { display: none; }
}
.letter-sheet {
  position: absolute; left: 30px; top: 0; width: 270px; height: 240px;
  padding: 32px; border-radius: 14px; background: #eef3ff;
  box-shadow: 0 8px 40px rgb(5 15 33 / 16%);
  span { display: block; height: 6px; background: #c6d4e9; border-radius: 3px; margin-bottom: 14px; }
  span:nth-child(2) { width: 75%; }
  span:nth-child(3) { width: 48%; }
  svg { position: absolute; right: 28px; top: 140px; color: #758dcc; }
}
.letter-envelope {
  position: absolute; inset: 110px 0 0; border-radius: 8px 8px 18px 18px;
  background: #adc7ef; box-shadow: 0 24px 60px rgb(5 15 33 / 22%);
  &::before { content: ''; position: absolute; inset: 0; background: #c7dcfb; clip-path: polygon(0 0, 50% 56%, 100% 0, 100% 100%, 0 100%); border-radius: inherit; }
  &::after { content: ''; position: absolute; inset: 0; background: #d7e6fc; clip-path: polygon(0 100%, 50% 44%, 100% 100%); border-radius: inherit; }
}
.letter-seal {
  position: absolute; display: grid; place-items: center; width: 60px; height: 60px;
  right: -18px; bottom: 38px; border-radius: 18px; background: #6ea995; color: white;
  transform: rotate(16deg); box-shadow: 0 8px 20px rgb(5 15 33 / 15%);
}

.login-background {
  position: fixed;
  inset: 0;
  z-index: 0;
  opacity: 0;
  transition: opacity 320ms ease;
}

.login-background-ready {
  opacity: 1;
}

@media (max-width: 767px) {
  .form-wrapper {
    padding: 24px 16px;
  }

  #login-box.has-custom-background .form-wrapper {
    position: relative;
    width: 100%;
    min-height: 100dvh;
    border-left: 0;
    box-shadow: none;
    backdrop-filter: none;
  }

  #login-box.has-custom-background .container {
    height: auto;
    min-height: 100dvh;
    padding: 32px 22px;
    border-radius: 0;
  }

  #login-box:not(.has-custom-background) .container {
    width: min(420px, 100%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .login-background {
    transition: none;
  }
}

</style>
