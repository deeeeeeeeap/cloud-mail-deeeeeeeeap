import i18next from 'i18next';
import zh from './zh.js'
import en from './en.js'
import app from '../hono/hono';
import { AsyncLocalStorage } from 'node:async_hooks';

const resources = {
	en: {
		translation: en
	},
	zh: {
		translation: zh,
	},
};

const langStorage = new AsyncLocalStorage();

// 模块加载时一次性初始化；请求语言通过 ALS 按调用传给 t，避免并发请求互相覆盖全局语言
i18next.init({
	lng: 'zh',
	fallbackLng: 'zh',
	initImmediate: false,
	resources,
});

function normalizeLang(lang) {
	return resources[lang] ? lang : 'zh';
}

app.use('*', (c, next) => {
	const lang = c.req.header('accept-language')?.split('-')[0];
	return langStorage.run(normalizeLang(lang), next);
});

export const t = (key, values) => i18next.t(key, { ...values, lng: langStorage.getStore() || 'zh' });

export default i18next;
