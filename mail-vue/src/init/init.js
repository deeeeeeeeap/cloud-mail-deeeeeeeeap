import {useUserStore} from "@/store/user.js";
import {useSettingStore} from "@/store/setting.js";
import {useAccountStore} from "@/store/account.js";
import {loginUserInfo} from "@/request/my.js";
import {permsToRouter} from "@/perm/perm.js";
import router from "@/router";
import {websiteConfig} from "@/request/setting.js";
import {cvtR2Url} from "@/utils/convert.js";
import {detectLang, loadLocaleMessages, normalizeLang} from "@/i18n/index.js";
import {
    clearAuthSession,
    getSessionGeneration,
    installDynamicRoutes,
    resetSessionState,
    startAuthSession
} from "@/session/auth-session.js";
import {
    assertSafeAuthenticatedMount,
    initializeAuthenticatedSession
} from "@/init/auth-bootstrap.js";
import {prefetchLoginBackground} from "@/views/login/login-background-prefetch.js";

export async function init() {
    document.title = '\u200B'

    const settingStore = useSettingStore();
    const userStore = useUserStore();
    const accountStore = useAccountStore();

    const token = localStorage.getItem('token');
    if (!settingStore.lang) {
        settingStore.lang = detectLang(navigator.language)
    } else {
        settingStore.lang = normalizeLang(settingStore.lang)
    }

    // 当前语言包与下面的 API 并行加载
    const localeReady = loadLocaleMessages(settingStore.lang)

    // 匿名回访与 API 并行加载登录背景；已登录用户不需要下载登录页图片。
    const prefetchedBackground = !token ? settingStore.lastBackgroundUrl : '';
    if (prefetchedBackground) prefetchLoginBackground(prefetchedBackground);

    let setting = null;

    if (token) {
        startAuthSession(token);
        const sessionGeneration = getSessionGeneration();
        const userOutcomePromise = loginUserInfo().then(
            user => ({user}),
            error => ({error})
        );

        const [s, userOutcome] = await Promise.all([websiteConfig(), userOutcomePromise, localeReady]);
        setting = s;
        settingStore.settings = setting;
        settingStore.domainList = setting.domainList;
        document.title = setting.title;

        const authResult = await initializeAuthenticatedSession({
            token,
            sessionGeneration,
            loadUser: async () => {
                if ('error' in userOutcome) throw userOutcome.error;
                return userOutcome.user;
            },
            getToken: () => localStorage.getItem('token'),
            getCurrentGeneration: getSessionGeneration,
            clearSession: clearAuthSession,
            applyUser: user => {
                accountStore.currentAccountId = user.account.accountId;
                accountStore.currentAccount = user.account;
                userStore.user = user;

                const routers = permsToRouter(user.permKeys);
                installDynamicRoutes(router, routers);
            }
        });
        assertSafeAuthenticatedMount({
            authResult,
            currentToken: localStorage.getItem('token'),
            currentUser: userStore.user
        });

    } else {
        resetSessionState();
        [setting] = await Promise.all([websiteConfig(), localeReady]);
        settingStore.settings = setting;
        settingStore.domainList = setting.domainList;
        document.title = setting.title;
    }

    // 401 可能已清除 token：按本次实际预取去重，确保登录回退仍能加载缓存 URL。
    if (setting.background) {
        const src = cvtR2Url(setting.background);
        if (!localStorage.getItem('token') && src !== prefetchedBackground) {
            prefetchLoginBackground(src);
        }
        settingStore.lastBackgroundUrl = src;
    } else {
        settingStore.lastBackgroundUrl = '';
    }
}
