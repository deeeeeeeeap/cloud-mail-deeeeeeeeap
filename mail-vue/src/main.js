import {createApp, watch} from 'vue';
import App from './App.vue';
import router from './router';
import './style.css';
import { init } from '@/init/init.js';
import { createPinia } from 'pinia';
import piniaPersistedState from 'pinia-plugin-persistedstate';
import 'element-plus/theme-chalk/dark/css-vars.css';
import 'nprogress/nprogress.css';
import perm from "@/perm/perm.js";
import {configureAuthSession, registerSessionResetter} from "@/session/auth-session.js";
import {resetAuthenticatedStores} from "@/session/reset-authenticated-stores.js";
import {useAccountStore} from "@/store/account.js";
import {userDraftStore} from "@/store/draft.js";
import {useEmailStore} from "@/store/email.js";
import {useRoleStore} from "@/store/role.js";
import {useSendStore} from "@/store/send.js";
import {useUiStore} from "@/store/ui.js";
import {useUserStore} from "@/store/user.js";
import {useWriterStore} from "@/store/writer.js";
import {closeDraftDatabase, initializeDraftDatabase} from "@/db/db.js";
import {clearEmailDetailSession} from "@/components/email-scroll/email-detail-session.js";
const pinia = createPinia().use(piniaPersistedState)
import i18n from "@/i18n/index.js";
const app = createApp(App).use(pinia)
const userStore = useUserStore()

// 发布后旧页面请求已删除的 chunk：整页刷新一次换到新版本（sessionStorage 防循环）。
// 离线时刷新只会换成浏览器错误页；写信窗口有未保存内容时刷新会丢稿，这两种情况都不刷新
window.addEventListener('vite:preloadError', event => {
    if (!navigator.onLine || sessionStorage.getItem('chunk-reloaded') || useUiStore().writerRef?.hasUnsavedContent?.()) return
    sessionStorage.setItem('chunk-reloaded', '1')
    event.preventDefault()
    location.reload()
})

configureAuthSession({
    storage: localStorage,
    navigateToLogin: () => router.replace({name: 'login'})
})
initializeDraftDatabase(userStore)
registerSessionResetter(closeDraftDatabase)
registerSessionResetter(clearEmailDetailSession)
registerSessionResetter(() => resetAuthenticatedStores({
    accountStore: useAccountStore(),
    userStore,
    emailStore: useEmailStore(),
    sendStore: useSendStore(),
    roleStore: useRoleStore(),
    draftStore: userDraftStore(),
    writerStore: useWriterStore(),
    uiStore: useUiStore()
}))
watch(
    () => [
        useAccountStore().currentAccountId,
        userStore.user?.userId,
        ...(userStore.user?.permKeys || [])
    ],
    clearEmailDetailSession,
    {flush: 'sync'}
)

// 图标集须在挂载前注册完成：offline 版 Icon 不会在注册后重绘
const iconsReady = import('@/icons/index.js').catch(error => console.error('图标集加载失败', error))
if (localStorage.getItem('token')) prefetchLandingRoute()

// 不使用顶层 await：入口模块立即完成求值，init() 里再 await 动态 import 也不会形成模块死锁
init()
    .then(() => iconsReady)
    .then(() => {
        app.use(router).use(i18n).directive('perm', perm)
        app.config.devtools = import.meta.env.DEV;
        app.mount('#app');
        router.isReady().then(() => sessionStorage.removeItem('chunk-reloaded'), showInitRetry)
    })
    .catch(e => {
        console.error('应用初始化失败', e)
        showInitRetry()
    })

// 已登录回访：与 init() 的 API 并行下载落地路由的组件 chunk，只触发下载不等待。
// 动态路由此时尚未注册，管理页直链会匹配到 404，跳过即可
function prefetchLandingRoute() {
    let target = router.resolve(router.options.history.location)
    const redirect = target.matched.at(-1)?.redirect
    if (typeof redirect === 'string') target = router.resolve(redirect)
    if (target.name === '404') return
    for (const record of target.matched) {
        const load = record.components?.default
        if (typeof load === 'function' && !load.prototype) load().catch(() => {})
    }
}

// 初始化失败时把首屏 loading 换成可重试的错误提示，避免永久白屏
// 此时 i18n 可能尚未就绪，直接按浏览器语言取内置文案
function showInitRetry() {
    const INIT_RETRY_TEXTS = {
        zh: { message: '加载失败，请检查网络后重试', button: '重试' },
        'zh-tw': { message: '載入失敗，請檢查網路後重試', button: '重試' },
        ja: { message: '読み込みに失敗しました。ネットワークを確認して再試行してください', button: '再試行' },
        en: { message: 'Failed to load. Please check your network and retry.', button: 'Retry' },
    };
    const loading = document.getElementById('loading-first');
    if (!loading) return;
    const navLang = (navigator.language || '').toLowerCase();
    let key = 'en';
    if (navLang.startsWith('zh')) {
        key = ['zh-tw', 'zh-hk', 'zh-mo', 'zh-hant'].some(tag => navLang.startsWith(tag)) ? 'zh-tw' : 'zh';
    } else if (navLang.startsWith('ja')) {
        key = 'ja';
    }
    const message = INIT_RETRY_TEXTS[key].message;
    const buttonText = INIT_RETRY_TEXTS[key].button;
    loading.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;gap:14px;font-family:inherit">
            <span style="color:#909399;font-size:14px">${message}</span>
            <button id="init-retry-btn" style="cursor:pointer;padding:7px 22px;border-radius:6px;border:1px solid #1890ff;background:#1890ff;color:#fff;font-size:14px">${buttonText}</button>
        </div>`;
    document.getElementById('init-retry-btn')?.addEventListener('click', () => location.reload());
}
