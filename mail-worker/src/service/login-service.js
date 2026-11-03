import BizError from '../error/biz-error';
import userService from './user-service';
import emailUtils from '../utils/email-utils';
import { isDel, settingConst, userConst } from '../const/entity-const';
import JwtUtils from '../utils/jwt-utils';
import { v4 as uuidv4 } from 'uuid';
import KvConst from '../const/kv-const';
import constant from '../const/constant';
import userContext from '../security/user-context';
import verifyUtils from '../utils/verify-utils';
import accountService from './account-service';
import settingService from './setting-service';
import saltHashUtils from '../utils/crypto-utils';
import cryptoUtils from '../utils/crypto-utils';
import turnstileService, { TURNSTILE_ACTIONS } from './turnstile-service';
import roleService from './role-service';
import regKeyService from './reg-key-service';
import dayjs from 'dayjs';
import { toUtc } from '../utils/date-uitil';
import { t } from '../i18n/i18n.js';
import authInfoCache from '../security/auth-info-cache';
import verifyRecordService from './verify-record-service';
import reqUtils from '../utils/req-utils';
import authRateLimitService, { markAuthAbuse } from './auth-rate-limit-service';
import { isConfiguredDomain } from '../utils/domain-utils';

const loginService = {

	async register(c, params, oauth = false) {

		// OAuth 绑定注册不过人机验证，且注册失败后 oauth-service 会把绑定令牌放回，
		// 换个 email 重试几乎零成本。这里按纯 IP 分桶（account 传空串），
		// 让轮换邮箱无法刷新配额；否则 isRegAccount/isDelUser 就是个不限速的邮箱枚举预言机。
		const rateIdentity = oauth
			? await authRateLimitService.assertAllowed(c, 'oauth-register', '')
			: await authRateLimitService.assertAllowed(c, 'register', params?.email);

		try {
			const regResult = await this.registerInternal(c, params, oauth);
			if (rateIdentity) {
				try {
					await authRateLimitService.clear(c, rateIdentity);
				} catch (clearError) {
					// 注册已成功，限流清理失败不应把成功响应变成 429
					console.warn('register rate-limit clear failed');
				}
			}
			return regResult;
		} catch (e) {
			if (rateIdentity && e?.authAbuse) {
				await authRateLimitService.recordFailure(c, rateIdentity);
			} else if (rateIdentity) {
				try {
					await authRateLimitService.releaseReservation(c, rateIdentity);
				} catch (releaseError) {
					// 归还名额失败只会让该名额等 30 秒自动过期，不应盖掉真正的失败原因
					console.warn('register rate-limit reservation release failed');
				}
			}
			throw e;
		}
	},

	async registerInternal(c, params, oauth = false) {

		const { email, password, token, code } = params;
		if (emailUtils.isSameAddress(email, c.env.admin)) {
			throw markAuthAbuse(new BizError('Administrator account must be created through the initialization flow', 403));
		}

		let { regKey, register, registerVerify, regVerifyCount, minEmailPrefix, emailPrefixFilter } = await settingService.query(c)

		if (oauth) {
			registerVerify = settingConst.registerVerify.CLOSE;
			// 默认尊重站点注册开关；仅在显式配置 oauth_auto_register 时保留旧的自动放行行为
			const autoRegister = String(c.env.oauth_auto_register ?? '').toLowerCase();
			if (autoRegister === 'true' || autoRegister === '1') {
				register = settingConst.register.OPEN;
			}
		}

		if (register === settingConst.register.CLOSE) {
			throw new BizError(t('regDisabled'));
		}

		if (!verifyUtils.isEmail(email)) {
			throw new BizError(t('notEmail'));
		}

		if (emailUtils.getName(email).length < minEmailPrefix) {
			throw new BizError(t('minEmailPrefix', { msg: minEmailPrefix } ));
		}

		if (emailPrefixFilter.some(content => emailUtils.getName(email).includes(content)))  {
			throw new BizError(t('banEmailPrefix'));
		}

		if (emailUtils.getName(email).length > 64) {
			throw new BizError(t('emailLengthLimit'));
		}

		if (typeof password !== 'string') {
			throw new BizError(t('pwdMinLength'));
		}

		if (password.length > 30) {
			throw new BizError(t('pwdLengthLimit'));
		}

		if (password.length < 6) {
			throw new BizError(t('pwdMinLength'));
		}

		if (!isConfiguredDomain(c.env.domain, emailUtils.getDomain(email))) {
			throw new BizError(t('notEmailDomain'));
		}

		let type = null;
		let regKeyId = 0

		if (regKey === settingConst.regKey.OPEN) {
			const result = await this.handleOpenRegKey(c, regKey, code)
			type = result?.type
			regKeyId = result?.regKeyId
		}

		if (regKey === settingConst.regKey.OPTIONAL) {
			const result = await this.handleOpenOptional(c, regKey, code)
			type = result?.type
			regKeyId = result?.regKeyId
		}

		const accountRow = await accountService.selectByEmailIncludeDel(c, email);

		// 这两条回答的是「该邮箱是否已存在」，是可被反复调用的枚举信号
		if (accountRow && accountRow.isDel === isDel.DELETE) {
			throw markAuthAbuse(new BizError(t('isDelUser')));
		}

		if (accountRow) {
			throw markAuthAbuse(new BizError(t('isRegAccount')));
		}

		let defType = null

		if (!type) {
			const roleRow = await roleService.selectDefaultRole(c);
			defType = roleRow.roleId
		}


		const roleRow = await roleService.selectById(c, type || defType);

		if(!roleService.hasAvailDomainPerm(roleRow.availDomain, email)) {

			if (type) {
				throw new BizError(t('noDomainPermRegKey'),403)
			}

			if (defType) {
				throw new BizError(t('noDomainPermReg'),403)
			}

		}

		let regVerifyOpen = false

		if (registerVerify === settingConst.registerVerify.OPEN) {
			regVerifyOpen = true
			await turnstileService.verify(c, token, TURNSTILE_ACTIONS.REGISTER)
		}

		if (registerVerify === settingConst.registerVerify.COUNT) {
			regVerifyOpen = await verifyRecordService.isOpenRegVerify(c, regVerifyCount);
			if (regVerifyOpen) {
				await turnstileService.verify(c, token, TURNSTILE_ACTIONS.REGISTER)
			}
		}

		const { salt, hash } = await saltHashUtils.hashPassword(password);
		const roleId = type || defType;
		let regKeyReserved = false;

		if (regKey !== settingConst.regKey.CLOSE && type) {
			regKeyReserved = await regKeyService.reserveCount(c, {
				regKeyId,
				roleId: type,
				quantity: 1
			});
			if (!regKeyReserved) {
				throw new BizError(t('noRegKeyCount'), 400);
			}
		}

		const activeIp = reqUtils.getIp(c) || '';
		const { os = '', browser = '', device = '' } = reqUtils.getUserAgent(c);
		const activeTime = dayjs().format('YYYY-MM-DD HH:mm:ss');

		try {
			await c.env.db.batch([
				c.env.db.prepare(`
					INSERT INTO user (
						email, password, salt, type, reg_key_id,
						os, browser, active_ip, create_ip, device, active_time
					)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`).bind(
					email,
					hash,
					salt,
					roleId,
					regKeyId,
					os,
					browser,
					activeIp,
					activeIp,
					device,
					activeTime
				),
				c.env.db.prepare(`
					INSERT INTO account (email, name, user_id)
					VALUES (
						?,
						?,
						(
							SELECT user_id
							FROM user
							WHERE email COLLATE NOCASE = ?
							  AND password = ?
							  AND salt = ?
							ORDER BY user_id DESC
							LIMIT 1
						)
					)
				`).bind(email, emailUtils.getName(email), email, hash, salt)
			]);
		} catch (e) {
			if (regKeyReserved) {
				try {
					await regKeyService.restoreCount(c, regKeyId, 1);
				} catch (restoreError) {
					console.error('Failed to restore registration key reservation');
				}
			}
			throw e;
		}

		if (registerVerify === settingConst.registerVerify.COUNT && !regVerifyOpen) {
			const row = await verifyRecordService.increaseRegCount(c);
			return {regVerifyOpen: row.count >= regVerifyCount}
		}

		return {regVerifyOpen}

	},

	async registerVerify() {

	},

	async handleOpenRegKey(c, regKey, code) {

		if (!code) {
			throw new BizError(t('emptyRegKey'));
		}

		const regKeyRow = await regKeyService.selectByCode(c, code);

		if (!regKeyRow) {
			// 注册码猜测，与配置类失败区别对待
			throw markAuthAbuse(new BizError(t('notExistRegKey')));
		}

		if (regKeyRow.count <= 0) {
			throw new BizError(t('noRegKeyCount'));
		}

		const today = toUtc().tz('Asia/Shanghai').startOf('day')
		const expireTime = toUtc(regKeyRow.expireTime).tz('Asia/Shanghai').startOf('day');

		if (expireTime.isBefore(today)) {
			throw new BizError(t('regKeyExpire'));
		}

		return { type: regKeyRow.roleId, regKeyId: regKeyRow.regKeyId };
	},

	async handleOpenOptional(c, regKey, code) {

		if (!code) {
			return null
		}

		const regKeyRow = await regKeyService.selectByCode(c, code);

		if (!regKeyRow) {
			return null
		}

		const today = toUtc().tz('Asia/Shanghai').startOf('day')
		const expireTime = toUtc(regKeyRow.expireTime).tz('Asia/Shanghai').startOf('day');

		if (regKeyRow.count <= 0 || expireTime.isBefore(today)) {
			return null
		}

		return { type: regKeyRow.roleId, regKeyId: regKeyRow.regKeyId };
	},

	async login(c, params, noVerifyPwd = false) {

		const { email, password } = params;

		if ((!email || !password) && !noVerifyPwd) {
			throw new BizError(t('emailAndPwdEmpty'));
		}

		const rateIdentity = noVerifyPwd
			? null
			: await authRateLimitService.assertAllowed(c, 'login', email);

		let userRow;
		try {
			userRow = await userService.selectByEmailIncludeDel(c, email);
			// 不存在的账号仍付出同等密码验证开销，避免暴露账号是否存在。
			if (!userRow || userRow.isDel === isDel.DELETE) {
				if (!noVerifyPwd) await cryptoUtils.burnPasswordVerification(password);
				throw markAuthAbuse(new BizError(t('loginFailed')));
			}
			if (!noVerifyPwd) {
				if (!await cryptoUtils.verifyPassword(password, userRow.salt, userRow.password)) {
					throw markAuthAbuse(new BizError(t('loginFailed')));
				}
				const currentUserRow = await userService.upgradePasswordHash(c, userRow, password);
				if (!currentUserRow) throw markAuthAbuse(new BizError(t('loginFailed')));
				Object.assign(userRow, currentUserRow);
				await authRateLimitService.clear(c, rateIdentity);
			}
		} catch (error) {
			if (rateIdentity && error?.authAbuse) {
				// recordFailure 已消费名额，即使抛 429 也不能再次归还同代其他请求的名额。
				await authRateLimitService.recordFailure(c, rateIdentity);
			} else if (rateIdentity) {
				try {
					await authRateLimitService.releaseReservation(c, rateIdentity);
				} catch {
					console.warn('login rate-limit reservation release failed');
				}
			}
			throw error;
		}

		if (userRow.status === userConst.status.BAN) {
			throw new BizError(t('isBanUser'));
		}

		const uuid = uuidv4();
		const jwt = await JwtUtils.generateToken(c,{ userId: userRow.userId, token: uuid }, constant.TOKEN_EXPIRE);

		let authInfo = await c.env.kv.get(KvConst.AUTH_INFO + userRow.userId, { type: 'json' });

		if (authInfo && (authInfo.user.email === userRow.email)) {

			if (authInfo.tokens.length >= 10) {
				authInfo.tokens.shift();
			}

			authInfo.tokens.push(uuid);

		} else {

			authInfo = {
				tokens: [],
				user: userRow,
				refreshTime: dayjs().toISOString()
			};

			authInfo.tokens.push(uuid);

		}

		await userService.updateUserInfo(c, userRow.userId);

		if (authInfo.user) {
			const { password: _password, salt: _salt, ...safeUser } = authInfo.user;
			authInfo.user = safeUser;
		}

		await authInfoCache.refresh(c, userRow.userId, authInfo);
		return jwt;
	},

	async logout(c, userId) {
		const token = await userContext.getToken(c);
		// 撤销必须读权威源：缓存快照可能早于本 token 的签发，命中后会误判 token 不存在而跳过撤销
		const authInfo = await c.env.kv.get(KvConst.AUTH_INFO + userId, { type: 'json' });
		if (!authInfo) {
			return;
		}
		const index = authInfo.tokens.findIndex(item => item === token);
		if (index === -1) {
			return;
		}
		authInfo.tokens.splice(index, 1);
		if (authInfo.tokens.length === 0) {
			await authInfoCache.remove(c, userId);
			return;
		}
		await authInfoCache.refresh(c, userId, authInfo);
	}

};

export default loginService;
