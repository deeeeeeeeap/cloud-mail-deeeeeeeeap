import KvConst from '../const/kv-const';
import setting from '../entity/setting';
import orm from '../entity/orm';
import {verifyRecordType} from '../const/entity-const';
import fileUtils from '../utils/file-utils';
import r2Service from './r2-service';
import constant from '../const/constant';
import BizError from '../error/biz-error';
import {t} from '../i18n/i18n'
import verifyRecordService from './verify-record-service';
import userContext from '../security/user-context';

const SETTING_CACHE_TTL = 30 * 1000;
let settingCache = null;

function cloneSetting(settingRow) {
	return JSON.parse(JSON.stringify(settingRow));
}

function normalizeSettingRow(settingRow) {
	if (!settingRow) {
		return null;
	}

	if (typeof settingRow.resendTokens === 'string') {
		settingRow.resendTokens = JSON.parse(settingRow.resendTokens || '{}');
	}
	if (!settingRow.resendTokens || typeof settingRow.resendTokens !== 'object' || Array.isArray(settingRow.resendTokens)) {
		settingRow.resendTokens = {};
	}

	return settingRow;
}

async function cacheSettingRow(c, settingRow) {
	const cloned = cloneSetting(settingRow);
	c.set?.('setting', cloned);
	settingCache = {
		value: cloned,
		expiresAt: Date.now() + SETTING_CACHE_TTL
	};
	await c.env.kv.put(KvConst.SETTING, JSON.stringify(cloned));
	return cloneSetting(cloned);
}

const settingService = {

	async refresh(c) {
		const settingRow = normalizeSettingRow(await orm(c).select().from(setting).get());
		if (!settingRow) {
			throw new BizError('数据库未初始化 Database not initialized.');
		}
		await cacheSettingRow(c, settingRow);
	},

	async query(c) {

		if (c.get?.('setting')) {
			return c.get('setting')
		}

		let settingData = null;
		if (settingCache && settingCache.expiresAt > Date.now()) {
			settingData = cloneSetting(settingCache.value);
		} else {
			try {
				settingData = normalizeSettingRow(await c.env.kv.get(KvConst.SETTING, { type: 'json' }));
			} catch (e) {
				console.warn(`Unable to read settings cache from KV: ${e.message}`);
				settingData = null;
			}
			if (settingData) {
				settingCache = {
					value: cloneSetting(settingData),
					expiresAt: Date.now() + SETTING_CACHE_TTL
				};
			}
		}

		if (!settingData) {
			try {
				settingData = normalizeSettingRow(await orm(c).select().from(setting).get());
				if (settingData) {
					settingData = await cacheSettingRow(c, settingData);
				}
			} catch (e) {
				console.warn(`Unable to restore settings cache from D1: ${e.message}`);
			}
		}

		if (!settingData) {
			throw new BizError('数据库未初始化 Database not initialized.');
		}

		let domainList = c.env.domain;

		if (typeof domainList === 'string') {
			try {
				domainList = JSON.parse(domainList)
			} catch (error) {
				throw new BizError(t('notJsonDomain'));
			}
		}

		if (!c.env.domain) {
			throw new BizError(t('noDomainVariable'));
		}

		if (!Array.isArray(domainList)) {
			throw new BizError(t('notJsonDomain'));
		}

		domainList = domainList.map(item => '@' + item);
		settingData.domainList = domainList;


		let linuxdoSwitch = c.env.linuxdo_switch;
		let projectLink = c.env.project_link;

		if (typeof linuxdoSwitch === 'string' && linuxdoSwitch === 'true') {
			linuxdoSwitch = true
		} else if (linuxdoSwitch === true) {
			linuxdoSwitch = true
		} else {
			linuxdoSwitch = false
		}

		if (typeof projectLink === 'string' && projectLink === 'false') {
			projectLink = false
		} else if (projectLink === false) {
			projectLink = false
		} else {
			projectLink = true
		}

		settingData.projectLink = projectLink;

		settingData.linuxdoClientId = c.env.linuxdo_client_id;
		settingData.linuxdoCallbackUrl = c.env.linuxdo_callback_url;
		settingData.linuxdoSwitch = linuxdoSwitch;

		settingData.emailPrefixFilter = String(settingData.emailPrefixFilter || '').split(",").filter(Boolean);

		c.set?.('setting', settingData);
		return settingData;
	},

	async get(c, showSiteKey = false) {

		const [settingData, recordList] = await Promise.all([
			this.query(c),
			verifyRecordService.selectListByIP(c)
		]);
		const settingRow = cloneSetting(settingData);

		const rawSiteKey = settingRow.siteKey || '';
		const rawSecretKey = settingRow.secretKey || '';
		settingRow.siteKeyConfigured = !!rawSiteKey;
		settingRow.secretKeyConfigured = !!rawSecretKey;

		if (!showSiteKey) {
			settingRow.siteKey = rawSiteKey ? `${rawSiteKey.slice(0, 6)}******` : null;
		}

		settingRow.secretKey = null;

		Object.keys(settingRow.resendTokens).forEach(key => {
			settingRow.resendTokens[key] = `${settingRow.resendTokens[key].slice(0, 12)}******`;
		});

		settingRow.s3AccessKey = settingRow.s3AccessKey ? `${settingRow.s3AccessKey.slice(0, 12)}******` : null;
		settingRow.s3SecretKey = settingRow.s3SecretKey ? `${settingRow.s3SecretKey.slice(0, 12)}******` : null;
		settingRow.hasR2 = !!c.env.r2
		settingRow.hasCfEmail = !!c.env.email

		let regVerifyOpen = false
		let addVerifyOpen = false

		recordList.forEach(row => {
			if (row.type === verifyRecordType.REG) {
				regVerifyOpen = row.count >= settingRow.regVerifyCount
			}
			if (row.type === verifyRecordType.ADD) {
				addVerifyOpen = row.count >= settingRow.addVerifyCount
			}
		})

		settingRow.regVerifyOpen = regVerifyOpen
		settingRow.addVerifyOpen = addVerifyOpen

		settingRow.storageType = await r2Service.storageType(c);

		return settingRow;
	},

	async set(c, params) {
		const settingData = await this.query(c);
		let resendTokens = { ...settingData.resendTokens, ...params.resendTokens };
		Object.keys(resendTokens).forEach(domain => {
			if (!resendTokens[domain]) delete resendTokens[domain];
		});

		if (Array.isArray(params.emailPrefixFilter)) {
			params.emailPrefixFilter = params.emailPrefixFilter + '';
		}

		if (Array.isArray(params.aiCodeFilter)) {
			params.aiCodeFilter = params.aiCodeFilter + '';
		}

		params.resendTokens = JSON.stringify(resendTokens);
		await orm(c).update(setting).set({ ...params }).returning().get();
		await this.refresh(c);
	},

	async deleteBackground(c) {

		const { background } = await this.query(c);
		if (!background) return

		if (background.startsWith('http')) {
			await orm(c).update(setting).set({ background: '' }).run();
			await this.refresh(c)
			return;
		}

		if (background) {
			await r2Service.delete(c,background)
			await orm(c).update(setting).set({ background: '' }).run();
			await this.refresh(c)
		}
	},

	async setBackground(c, params) {

		let { background } = params

		await this.deleteBackground(c);

		if (background && !background.startsWith('http')) {

			const file = fileUtils.base64ToFile(background)

			const arrayBuffer = await file.arrayBuffer();
			background = constant.BACKGROUND_PREFIX + await fileUtils.getBuffHash(arrayBuffer) + fileUtils.getExtFileName(file.name);


			await r2Service.putObj(c, background, arrayBuffer, {
				contentType: file.type,
				cacheControl: `public, max-age=31536000, immutable`,
				contentDisposition: `inline; filename="${file.name}"`
			});

		}

		await orm(c).update(setting).set({ background }).run();
		await this.refresh(c);
		return background;
	},


	async setBlacklist(c, params) {
		const { blackSubject, blackContent, blackFrom  } = params
		await orm(c).update(setting).set({ blackSubject, blackContent, blackFrom }).run();
		await this.refresh(c);
		return this.get(c);
	},

	async websiteConfig(c) {

		const settingRow = await this.get(c, true);
		const token = await userContext.getToken(c);

		return {
			register: settingRow.register,
			title: settingRow.title,
			manyEmail: settingRow.manyEmail,
			addEmail: settingRow.addEmail,
			autoRefresh: settingRow.autoRefresh,
			addEmailVerify: settingRow.addEmailVerify,
			registerVerify: settingRow.registerVerify,
			send: settingRow.send,
			r2Domain: settingRow.r2Domain,
			siteKey: settingRow.siteKey,
			background: settingRow.background,
			loginOpacity: settingRow.loginOpacity,
			domainList: settingRow.loginDomain === 1 && !token ? [] : settingRow.domainList,
			regKey: settingRow.regKey,
			regVerifyOpen: settingRow.regVerifyOpen,
			addVerifyOpen: settingRow.addVerifyOpen,
			noticeTitle: settingRow.noticeTitle,
			noticeContent: settingRow.noticeContent,
			noticeType: settingRow.noticeType,
			noticeDuration: settingRow.noticeDuration,
			noticePosition: settingRow.noticePosition,
			noticeWidth: settingRow.noticeWidth,
			noticeOffset: settingRow.noticeOffset,
			notice: settingRow.notice,
			loginDomain: settingRow.loginDomain,
			linuxdoClientId: settingRow.linuxdoClientId,
			linuxdoCallbackUrl: settingRow.linuxdoCallbackUrl,
			linuxdoSwitch: settingRow.linuxdoSwitch,
			minEmailPrefix: settingRow.minEmailPrefix,
			projectLink: settingRow.projectLink
		};
	},

};

export default settingService;
