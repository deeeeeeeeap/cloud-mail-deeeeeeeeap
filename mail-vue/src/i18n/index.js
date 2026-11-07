import { createI18n } from 'vue-i18n';
import { shallowRef } from 'vue';

// 支持的界面语言，新增语言时在此注册并同步维护各处 locale 映射
export const SUPPORTED_LANGS = [
    { value: 'zh', label: '中文' },
    { value: 'zh-tw', label: '繁體中文' },
    { value: 'en', label: 'English' },
    { value: 'ja', label: '日本語' },
]

const SUPPORTED_LANG_VALUES = SUPPORTED_LANGS.map(item => item.value)

// 根据浏览器语言推断默认界面语言
export function detectLang(navLang) {
    const lang = (navLang || '').toLowerCase()
    if (lang.startsWith('zh')) {
        return ['zh-tw', 'zh-hk', 'zh-mo', 'zh-hant'].some(tag => lang.startsWith(tag)) ? 'zh-tw' : 'zh'
    }
    const base = lang.split('-')[0]
    return SUPPORTED_LANG_VALUES.includes(base) ? base : 'en'
}

export function normalizeLang(lang) {
    return SUPPORTED_LANG_VALUES.includes(lang) ? lang : 'en'
}

// 切换语言会整页刷新，每次只需加载当前语言
const MESSAGE_LOADERS = {
    zh: () => import('./zh.js'),
    'zh-tw': () => import('./zh-tw.js'),
    en: () => import('./en.js'),
    ja: () => import('./ja.js'),
}

const ELEMENT_LOCALE_LOADERS = {
    zh: () => import('element-plus/es/locale/lang/zh-cn'),
    'zh-tw': () => import('element-plus/es/locale/lang/zh-tw'),
    ja: () => import('element-plus/es/locale/lang/ja'),
}

// Element Plus 组件语言，null 表示使用内置英文
export const elementLocale = shallowRef(null)

const i18n = createI18n({
    legacy: false,
    fallbackLocale: 'en',
    messages: {},
});

export async function loadLocaleMessages(lang) {
    const target = normalizeLang(lang)
    const [messages, element] = await Promise.all([
        MESSAGE_LOADERS[target](),
        ELEMENT_LOCALE_LOADERS[target]?.(),
    ])
    i18n.global.setLocaleMessage(target, messages.default)
    i18n.global.locale.value = target
    elementLocale.value = element?.default ?? null
    return target
}

export default i18n;
