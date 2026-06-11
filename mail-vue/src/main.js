import {createApp} from 'vue';
import App from './App.vue';
import router from './router';
import './style.css';
import { init } from '@/init/init.js';
import { createPinia } from 'pinia';
import piniaPersistedState from 'pinia-plugin-persistedstate';
import 'element-plus/theme-chalk/dark/css-vars.css';
import 'nprogress/nprogress.css';
import perm from "@/perm/perm.js";
const pinia = createPinia().use(piniaPersistedState)
import i18n from "@/i18n/index.js";
const app = createApp(App).use(pinia)
try {
    await init()
} catch (e) {
    console.error('应用初始化失败', e)
    showInitRetry()
    throw e
}
app.use(router).use(i18n).directive('perm',perm)
app.config.devtools = import.meta.env.DEV;

app.mount('#app');

// 初始化失败时把首屏 loading 换成可重试的错误提示，避免永久白屏
function showInitRetry() {
    const loading = document.getElementById('loading-first');
    if (!loading) return;
    const isZh = navigator.language.startsWith('zh');
    const message = isZh ? '加载失败，请检查网络后重试' : 'Failed to load. Please check your network and retry.';
    const buttonText = isZh ? '重试' : 'Retry';
    loading.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;gap:14px;font-family:inherit">
            <span style="color:#909399;font-size:14px">${message}</span>
            <button id="init-retry-btn" style="cursor:pointer;padding:7px 22px;border-radius:6px;border:1px solid #1890ff;background:#1890ff;color:#fff;font-size:14px">${buttonText}</button>
        </div>`;
    document.getElementById('init-retry-btn')?.addEventListener('click', () => location.reload());
}
